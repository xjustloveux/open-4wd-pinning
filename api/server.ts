/**
 * 管理 HTTP 服務：`GET /stats`／`POST /pin`／`POST /unpin`。
 *
 * pin 流程閘順序（固定，不可調換）：verify（簽章＋時戳＋nonce 重放）→ authorize（白名單 ∪
 * 信譽閾值，pin 動作另過 repeat-infringer 一票否決）→ denyList（CID 黑名單，只擋 re-pin，不擋
 * unpin）→ 既有 pin 記錄冪等短路（見下方「re-pin 不得移轉所有權」）→ quota.reserve（以 signed
 * sizeHintBytes 保留最壞情況）→ pinExecutor.preparePin（有界搬 DAG）→ quota.recheck（實量）→
 * cluster.pin → quota.commit。任何前置失敗都 release reservation；只有 Cluster 成功才入帳。
 *
 * re-pin 不得移轉所有權：真實 cluster 對同一 CID 的 pin 是以 cid 為主鍵的 upsert，metadata
 * 由最後一次寫入者覆寫（last-writer-wins）。若放行每一次 /pin 呼叫都無條件走到
 * pin pipeline，任何具備 pin 資格的人（白名單或信譽達標）都能對別人、甚至系統自動 pin
 * 的 CID 重新 pin 一次，把自己寫成新的 signer，藉此取得原本不屬於自己的 unpin 資格——保留
 * 最初 pinner 的記錄不被覆寫，是下面「只有原 signer 或白名單能 unpin」這條規則能夠成立的
 * 前提。故 denyList 檢查之後、quota.admit 之前，先查這個 CID 目前的記錄：找到記錄且
 * signer 與這次請求的 signer 不同、或該記錄是 source:'auto' 的系統性 pin（不論 signer 是
 * 否碰巧相同，系統性 pin 一律不可被單一 signer 的 re-pin「認領」），一律視為冪等成功、
 * 直接回 200，不呼叫 pinExecutor.pin（因此也不會觸發底層 cluster 的 metadata 覆寫）、不
 * 呼叫 quota.recordPin（重複 pin 不該灌配額帳）。找到記錄但 signer 相同（本人重 pin 自己
 * 已經 pin 過的東西）則不短路、照常往下走——quota.recordPin 本身對同一 cid 的重複記帳已經
 * 是「先扣舊帳再記新帳」的冪等語意，不會因此重複計數。
 *
 * unpin 走不同的授權規則，只有原 signer 或白名單成員可 unpin 某 CID——這與 `authorize()` 的
 * 白名單∪信譽門檻不同（信譽達標本身不足以讓人 unpin 別人的內容，只能自清自己 pin 過的東西），
 * 故 unpin 不呼叫 `authorize()`，改在本檔直接判定：白名單成員可 unpin 任何 CID，完全不查
 * cluster（簽章合法但未獲授權的呼叫端，不該有能力逼這裡碰 cluster）；非白名單者只能 unpin
 * 目前 cluster 記錄裡 signer 恰為自己的 CID（找不到記錄＝不算原 signer）——這個查詢與上面
 * pin 流程的既有記錄查詢共用同一個單筆查詢管道（`findPinRecord`），不掃整份 pinset。
 * repeat-infringer 否決與信譽門檻皆不適用於 unpin（讓被標記者仍可自行清理既有內容）。
 *
 * `denyList`／`authDeps` 兩者的 isRepeatInfringer 是兩個獨立的注入點：`authDeps.isRepeatInfringer`
 * 是 `authorize()` 內建否決機制的資料來源（由組裝端決定其實際依據），本檔只透過 `authorize()`
 * 間接使用；`denyList` 在本檔只用得到 `isBlacklisted`（CID 黑名單），故 `ApiDeps.denyList` 的
 * 型別只要求這一個方法，避免重複走兩條路徑判斷同一件事。
 *
 * 升級面硬化（教訓：連線層錯誤事件若無人監聽會讓整個行程崩潰；未設上限的 body 讀取可被拿來
 * 塞爆記憶體；限流若晚於 body 解析，超量請求仍要付出讀取整包 body 的成本）：
 * 1. socket 的 error listener 置於請求處理最前面，涵蓋整個請求生命週期。
 * 2. body 讀取設 1 MiB 硬上限，超過立即中止累積（不 destroy socket，讓回應能正常送出）。
 * 3. per-IP 限流在讀取 body 之前執行；驗章後再套 per-signer／operation 桶。
 */
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { CID } from 'multiformats/cid';
import { authorize, NonceCache, verifyPinRequest, type AuthConfig, type AuthDeps } from '../auth';
import type {
  ClusterClient,
  KuboClient,
  PinMeta,
  PinRecord,
  QuotaAdmission,
  QuotaBlockMeasurement,
  QuotaReservation,
  QuotaVerdict,
} from '../pinning';
import {
  checkRate,
  pruneRateWindows,
  type TokenBucketConfig,
  type TokenBucketState,
} from './rate-limit';
import type { ApiMetricRoute, HttpStatusClass, PinningMetrics } from '../metrics';
import {
  makeProviderDescriptor,
  type DesignatedAgentRegistration,
  type ProviderPolicyUrls,
} from './provider-descriptor';

/** ApiDeps.quota 所需的最小介面——QuotaLedger 的公開方法子集。QuotaLedger 本身是帶 private
 * 欄位的 class，直接以該具體型別要求會讓測試無法用純物件替身注入（TS 對含 private 成員的
 * class 之間的指派是名義型別，物件字面量對不上），故改宣告一個只含實際會呼叫到的方法的介面；
 * 真正的 QuotaLedger 實例本來就滿足這個較窄的介面，兩邊都能用。 */
export interface QuotaPort {
  admit(input: QuotaAdmission): QuotaVerdict;
  reserve(input: QuotaAdmission): QuotaReservation;
  recheck(reservationId: string, input: QuotaAdmission): QuotaVerdict;
  release(reservationId: string): void;
  commit(reservationId: string, rec: PinRecord, blocks?: readonly QuotaBlockMeasurement[]): void;
  recordPin(rec: PinRecord, blocks?: readonly QuotaBlockMeasurement[]): void;
  recordUnpin(cid: string): void;
  /** 目前仍受本 provider 保留的 root，是否真的包含指定 traversal block。 */
  hasRootBlock(rootCid: string, blockCid: string): boolean;
}

/** ApiDeps.denyList 所需的最小介面——本檔只用得到黑名單查詢（見檔頭關於 isRepeatInfringer
 * 兩個注入點分工的說明）。理由同 QuotaPort：DenyList 是 class，narrower 介面兩邊都能滿足。 */
export interface DenyListPort {
  isBlacklisted(cid: string): boolean;
}

/** ApiDeps.cluster 所需的介面：ClusterClient 的既有操作，外加把 get()（單筆查詢）從
 * ClusterClient 介面本身宣告的可選收斂成必要。那裡標成可選是為了不強迫其他既有呼叫端
 * （在這個方法新增之前就已經實作 ClusterClient 的替身）回頭補一個用不到的方法；但本檔的
 * pin／unpin 安全閘直接倚賴單筆查詢（見 findPinRecord），注入進來的 cluster 一定要真的
 * 支援它，收斂成必要能讓呼叫端不必每次都判斷這個方法存不存在。`createClusterClient()`
 * 的回傳型別本來就滿足這個較窄的介面。 */
export interface ClusterPort extends ClusterClient {
  get(cid: string): Promise<PinRecord | undefined>;
}

/** 描述公開統計端點回傳的服務運作狀態。 */
export interface StatsBody {
  readonly node_id: string;
  readonly version: string;
  readonly uptime: number;
  readonly total_pinned_count: number;
  readonly total_size_bytes: number;
  readonly available_space_bytes: number;
  readonly ipfs_cluster_peers: number;
  readonly last_sync_timestamp: number;
  readonly accepting_pins: boolean;
  readonly quota_used_bytes: number;
  readonly quota_limit_bytes: number;
}

/** 承載準備 pin 所需的有界且可取消輸入。 */
export interface PinExecutorPinParams {
  readonly cid: string;
  /** 簽章涵蓋的完整 logical DAG 硬上限；實作必須在寫入超額 block 前停止。 */
  readonly sizeHintBytes: number;
  /** pinTimeoutMs 逾時時會被 abort——實作若能取消底層 DAG 抓取，可縮小「回應已送出 504 但
   * 背景其實抓完了」的半 pin 競態窗口（Promise 本身不可取消，signal 是唯一的取消管道）。 */
  readonly signal: AbortSignal;
}

/** 承載移除 pin 所需的目標與取消訊號。 */
export interface PinExecutorUnpinParams {
  readonly cid: string;
  readonly signal: AbortSignal;
}

/** transferDag＋cluster.pin／unpin 的整體封裝，由後續任務組裝真實實作（真形＝抓 DAG 到本地
 * kubo、確認完整後才對 cluster 下 pin／unpin）；本檔只定義介面形＋在測試以 stub 注入。 */
export interface PinExecutor {
  preparePin(params: PinExecutorPinParams): Promise<{
    logicalSizeBytes: number;
    newPhysicalSizeBytes: number;
    blocks: readonly QuotaBlockMeasurement[];
  }>;
  unpin(params: PinExecutorUnpinParams): Promise<void>;
}

/** 設定 HTTP API 邊界、授權、限制與對外聲明能力。 */
export interface ApiConfig {
  /** 監聽埠；0＝由作業系統指派（測試用）。 */
  readonly port: number;
  /**
   * 瀏覽器跨來源 API 的明示 origin allowlist；空集／省略＝fail-closed。只接受 HTTP(S)
   * origin，不接受 wildcard、credentials、path、query 或 fragment。
   */
  readonly corsAllowedOrigins?: readonly string[];
  readonly auth: AuthConfig;
  /** pinExecutor 整體逾時（ms）；省略＝120_000。 */
  readonly pinTimeoutMs?: number;
  /** 省略＝套用本檔的保守內建預設（見 DEFAULT_RATE_LIMIT）。 */
  readonly rateLimit?: TokenBucketConfig;
  /** 驗章後依 signer 身分計算的第二層 token bucket。 */
  readonly signerRateLimit?: TokenBucketConfig;
  readonly provider: {
    readonly ugcReadEnabled: boolean;
    readonly ugcWriteEnabled: boolean;
    readonly legalNoticeEnabled: boolean;
    readonly counterNoticeEnabled: boolean;
    readonly transparencyEnabled: boolean;
    readonly designatedAgentRegistration: DesignatedAgentRegistration;
    readonly policies?: ProviderPolicyUrls;
  };
}

/** 注入 HTTP API 使用的儲存、政策、指標與執行連接埠。 */
export interface ApiDeps {
  readonly config: ApiConfig;
  readonly quota: QuotaPort;
  readonly cluster: ClusterPort;
  readonly kubo: KuboClient;
  readonly denyList: DenyListPort;
  readonly authDeps: AuthDeps;
  stats(): Promise<StatsBody>;
  readonly providerId: string;
  readonly pinExecutor: PinExecutor;
  /**
   * `/api/dmca/*` 命名空間的委派處理器（單一 dispatcher 注入點）。組裝端在 DMCA 啟用時
   * 傳入 dmca 模組的請求處理器——本 server 對這個前綴的請求直接委派給它，由它全權負責回應
   * （含 dmca 自有的限流／body 上限）。刻意不改用「同一顆 http.Server 掛第二個 request
   * listener」的作法：多重 listener 之間互不知情、可能對同一 request 各自寫入而衝突。以單一
   * dispatcher 委派可徹底避開這個共存風險。未提供（DMCA 關閉）時，`/api/dmca/*` 一律回
   * 404 並正常關閉連線——不留「早退不寫 res」造成的連線懸置。
   */
  readonly dmcaHandler?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  /** 明示啟用後才把 self-host Swagger 的 `/admin/*` 路徑交給 dmcaHandler。 */
  readonly dmcaAdminDocsEnabled?: boolean;
  /** 預設省略＝no-op；metrics listener 與本 API listener 必須分離。 */
  readonly metrics?: PinningMetrics;
}

/** 提供執行中 API 的實際監聽埠與平順關閉操作。 */
export interface RunningApiServer {
  /** 實際監聽的埠；config.port 為 0 時由作業系統指派，故須等 listen 完成。 */
  readonly ready: Promise<number>;
  readonly close: () => Promise<void>;
}

const DEFAULT_PIN_TIMEOUT_MS = 120_000;
// 1 MiB；超過立即中止累積、回 413。
const MAX_BODY_BYTES = 1_048_576;

// 見 NonceCache 分區決策：capacity=20／refillPerSec=1
// 讓單一 IP 在 NonceCache 的 60s TTL 窗內最多只能貢獻 capacity + refillPerSec*60 ≈ 80 筆
// （初始滿桶 20 顆 + 60 秒內以 1/sec 補充的 60 顆），遠低於 NonceCache 的 8192 硬頂
// （約 1%）；要真正填滿共用快取需要上百個各自都跑滿速率的獨立來源同時發動，已超出本層
// （單一 process 的 per-IP 限流）能單獨防禦的範圍，是有意識接受、留給網路層（WAF／CDN／IP
// 信譽）的殘留風險，並非疏漏。
const DEFAULT_RATE_LIMIT: TokenBucketConfig = { capacity: 20, refillPerSec: 1 };
const CORS_ALLOWED_METHODS = 'GET, POST';
const CORS_ALLOWED_HEADERS = 'content-type';
const PINNING_SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
} as const;

class PayloadTooLargeError extends Error {}
class InvalidJsonError extends Error {}
class PinTimeoutError extends Error {}
class QuotaRecheckError extends Error {
  constructor(readonly reason: NonNullable<QuotaVerdict['reason']>) {
    super(reason);
  }
}

/** PinExecutor 用這個型別把結構／位元組硬上限失敗與網路逾時區分。 */
export class PinResourceLimitError extends Error {}

function metricRoute(req: IncomingMessage): ApiMetricRoute {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/provider') return 'provider';
  if (path === '/stats') return 'stats';
  if (path === '/pin') return 'pin';
  if (path === '/unpin') return 'unpin';
  if (path.startsWith('/api/ugc/')) return 'ugc_read';
  if (path.startsWith('/api/dmca/')) return 'dmca';
  if (path.startsWith('/admin/')) return 'dmca';
  return 'not_found';
}

function parseUgcBlockPath(pathname: string): { rootCid: string; blockCid: string } | undefined {
  const match = /^\/api\/ugc\/([^/]+)\/blocks\/([^/]+)$/.exec(pathname);
  if (match === null) return undefined;
  try {
    const rootCid = CID.parse(decodeURIComponent(match[1]!)).toString();
    const blockCid = CID.parse(decodeURIComponent(match[2]!)).toString();
    return { rootCid, blockCid };
  } catch {
    return undefined;
  }
}

function statusClass(status: number): HttpStatusClass {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  return '2xx';
}

function normalizeCorsOrigin(value: string, configField: string): string {
  if (value === '*') {
    throw new TypeError(`${configField} does not allow wildcard "*"`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${configField} contains an invalid origin`);
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search !== '' ||
    url.hash !== '' ||
    url.origin === 'null'
  ) {
    throw new TypeError(
      `${configField} accepts only scheme + host (+ port), without credentials/path/query/fragment`,
    );
  }
  return url.origin;
}

function appendVaryOrigin(res: ServerResponse): void {
  const existing = res.getHeader('vary');
  const values = (
    Array.isArray(existing) ? existing : typeof existing === 'string' ? existing.split(',') : []
  ).map((value) => value.trim());
  if (!values.some((value) => value.toLowerCase() === 'origin')) values.push('Origin');
  res.setHeader('vary', values.join(', '));
}

function requestCorsOrigin(req: IncomingMessage): string | undefined {
  const header = req.headers.origin;
  if (typeof header !== 'string') return undefined;
  try {
    return normalizeCorsOrigin(header, 'Origin');
  } catch {
    return undefined;
  }
}

function requestedCorsHeaders(req: IncomingMessage): string[] {
  const header = req.headers['access-control-request-headers'];
  if (typeof header !== 'string') return [];
  return header
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== '');
}

function applySecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(PINNING_SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

/** 讀取整包 request body，超過上限立即中止累積並拒收（不 destroy socket——req／res 共用
 * 同一條底層連線，直接摧毀會連還沒送出的錯誤回應一起打斷；剩餘 body 交給 Node 在背景自然
 * 讀完丟棄）。空 body 回 undefined；JSON 語法錯誤拋 InvalidJsonError。 */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new InvalidJsonError());
      }
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length === 0 || hex.length % 2 !== 0) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const byteStr = hex.slice(i * 2, i * 2 + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(byteStr)) return undefined;
    bytes[i] = Number.parseInt(byteStr, 16);
  }
  return bytes;
}

/**
 * wire body（`{ payload, timestamp, nonceHex, signer, signatureHex }`，nonce／signature 以
 * hex 字串攜帶——JSON 無法直接乘載原始 bytes）解碼成 `verifyPinRequest` 認得的形狀
 * （`nonce`／`signature` 為 Uint8Array）。nonce 與 signature 兩個二進位欄位統一用同一種
 * hex 編碼慣例，wire 格式只需要一套編解碼規則、呼叫端也不用記兩種寫法。任何欄位缺失或 hex
 * 格式不對，個別產出 undefined，交給 `verifyPinRequest` 內部的形狀檢查統一判定為
 * SIG_INVALID，這裡不用另外拋錯。
 */
function decodeWireBody(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  const nonceHex = obj['nonceHex'];
  const signatureHex = obj['signatureHex'];
  return {
    payload: obj['payload'],
    timestamp: obj['timestamp'],
    nonce: typeof nonceHex === 'string' ? hexToBytes(nonceHex) : undefined,
    signer: obj['signer'],
    signature: typeof signatureHex === 'string' ? hexToBytes(signatureHex) : undefined,
  };
}

/** 查某 CID 目前的 pin 記錄，不存在（或已 unpin）回 undefined。用單筆查詢（cluster.get()），
 * 不掃整份 pinset——pin／unpin 兩個安全閘共用這個管道：
 * - pin 流程（見 handlePin）用它判斷這個 CID 是否已經被別人（或系統自動）pin 過，藉此保留
 *   最初 pinner 的記錄不被 re-pin 覆寫。
 * - unpin 流程（見 handleUnpin）用它的 signer 欄位判斷「原 signer」。
 * 兩處呼叫都發生在授權判定成立之前（甚至決定本身就是授權判定的一部分），而不是授權通過後
 * 才做的重活——用單筆查詢而非線性掃過 list()，是刻意的：一個簽章合法但完全沒有授權的呼叫
 * 端，不該有能力逼這裡對整份 pinset 做一次緩衝＋掃描。 */
async function findPinRecord(cluster: ClusterPort, cid: string): Promise<PinRecord | undefined> {
  return cluster.get(cid);
}

/** 包一層逾時：逾時就 abort signal 並以 PinTimeoutError 拒絕；無論哪邊先解決都清掉計時器，
 * 避免正常路徑（多數請求）留下一堆遲早才觸發、但已經無意義的 timer。Promise 本身不可取消，
 * abort 只是把「請停手」的訊號傳給願意配合的實作（見 PinExecutor 介面註解）。 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new PinTimeoutError());
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 以失敗關閉授權與有界請求處理啟動 Pinning HTTP API。 */
export function createApiServer(deps: ApiDeps): RunningApiServer {
  const nonces = new NonceCache();
  const rateWindows = new Map<string, TokenBucketState>();
  const signerRateWindows = new Map<string, TokenBucketState>();
  const rateLimitConfig = deps.config.rateLimit ?? DEFAULT_RATE_LIMIT;
  const signerRateLimitConfig = deps.config.signerRateLimit ?? DEFAULT_RATE_LIMIT;
  const pinTimeoutMs = deps.config.pinTimeoutMs ?? DEFAULT_PIN_TIMEOUT_MS;
  const corsAllowedOrigins = new Set(
    (deps.config.corsAllowedOrigins ?? []).map((origin) =>
      normalizeCorsOrigin(origin, 'corsAllowedOrigins'),
    ),
  );

  const checkClientRate = (req: IncomingMessage): boolean => {
    const ip = clientIp(req);
    const now = Date.now();
    const result = checkRate(rateWindows.get(ip), now, rateLimitConfig);
    rateWindows.set(ip, result.state);
    // 記錄完這次請求的桶狀態後才回收 rateWindows（見 pruneRateWindows 的完整理由：TTL
    // 等價於「沒出現過」＋硬上限逐出）——刻意放在 set() 之後：這個 ip 剛寫入的條目
    // updatedAtMs 恰為 now，是全 map 最新的一筆，硬上限逐出（依 updatedAtMs 由舊到新
    // 挑）永遠不會選中它，讓「這次請求處理完後 map 大小不超過上限」這個不變式在每次呼叫
    // 後都成立，不會有插入後暫時超額一筆又要等下次呼叫才被修正的空窗。
    pruneRateWindows(rateWindows, now, rateLimitConfig);
    return result.allowed;
  };

  const checkSignerRate = (signer: string, operation: 'pin' | 'unpin'): boolean => {
    const now = Date.now();
    // pin 與 unpin 分桶：pin flood 不得耗盡使用者自清內容所需的 unpin 額度。
    const key = `${operation}:${signer}`;
    const result = checkRate(signerRateWindows.get(key), now, signerRateLimitConfig);
    signerRateWindows.set(key, result.state);
    pruneRateWindows(signerRateWindows, now, signerRateLimitConfig);
    return result.allowed;
  };

  const handlePin = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let rawBody: unknown;
    try {
      rawBody = await readJsonBody(req);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
        return;
      }
      if (err instanceof InvalidJsonError) {
        // 解析不出結構就無從驗章——歸入既有 SIG_INVALID，不為此另開一種錯誤碼。
        sendJson(res, 403, { error: 'SIG_INVALID' });
        return;
      }
      throw err;
    }

    const verified = verifyPinRequest(decodeWireBody(rawBody), Date.now(), nonces);
    if (!verified.ok) {
      sendJson(res, 403, { error: verified.code });
      return;
    }
    if (verified.payload.type !== 'pinning-pin') {
      sendJson(res, 403, { error: 'SIG_INVALID' });
      return;
    }
    const { signer, payload } = verified;

    if (!checkSignerRate(signer, 'pin')) {
      sendJson(res, 429, { error: 'RATE_LIMITED' });
      return;
    }

    const verdict = authorize(signer, payload.type, deps.config.auth, deps.authDeps);
    if (!verdict.allowed) {
      sendJson(res, 403, { error: verdict.code });
      return;
    }

    if (deps.denyList.isBlacklisted(payload.cid)) {
      sendJson(res, 403, { error: 'BLACKLISTED' });
      return;
    }

    // re-pin 不得移轉所有權（見檔頭「re-pin 不得移轉所有權」說明）：這個 CID 已經被別人
    // （signer 不同）或系統自動（source:'auto'，不論 signer 欄位是否碰巧相同）pin 過，
    // 一律視為冪等成功、直接回 200——不呼叫 pinExecutor.pin，因此也不會觸發底層 cluster
    // 對這個 CID 的 metadata 覆寫；不呼叫 quota.recordPin，重複 pin 不該灌配額帳。保留
    // 最初 pinner 的記錄不被覆寫，是下面 unpin「只有原 signer 或白名單能動」這條規則能夠
    // 成立的前提；一旦這裡放行覆寫，「原 signer」判定本身就會被攻擊者的一次 re-pin 抹除
    // 重寫，unpin 的授權閘形同虛設。本人重 pin 自己已經 pin 過的 CID（signer 相同、非
    // source:'auto'）則不觸發這個短路，照常往下走——quota.recordPin 對同一 cid 的重複
    // 記帳本身是「先扣舊帳再記新帳」的冪等語意，不會重複計數，不需要在這裡另開一條路徑。
    const existing = await findPinRecord(deps.cluster, payload.cid);
    if (
      existing !== undefined &&
      (existing.meta.signer !== signer || existing.meta.source === 'auto')
    ) {
      sendJson(res, 200, { ok: true, cid: payload.cid });
      return;
    }

    const previousPhysicalSizeBytes = existing?.meta.physicalSizeBytes ?? 0;
    const reservation = deps.quota.reserve({
      cid: payload.cid,
      signer,
      logicalSizeBytes: payload.sizeHintBytes,
      physicalSizeBytes: previousPhysicalSizeBytes + payload.sizeHintBytes,
    });
    if (!reservation.allowed) {
      sendJson(res, 507, { error: 'QUOTA_EXCEEDED', reason: reservation.reason });
      return;
    }

    // try/catch 刻意只包住 pinExecutor 這一段（逾時或 DAG 抓取失敗的唯一來源）：quota.recordPin
    // 與後續的成功回應不放進同一個 catch，避免萬一記帳本身出錯（理論上極不可能，但非不可能）
    // 被誤標成「pin 逾時」回 504——那是完全不同的失敗語意，應該讓外層 catch-all 轉 500 並記
    // 真正的錯誤，而不是靜默吞成一個誤導性的逾時回應。
    const controller = new AbortController();
    let committed = false;
    try {
      let preparedBlocks: readonly QuotaBlockMeasurement[] = [];
      let meta: PinMeta;
      try {
        meta = await withTimeout(
          (async (): Promise<PinMeta> => {
            const result = await deps.pinExecutor.preparePin({
              cid: payload.cid,
              sizeHintBytes: payload.sizeHintBytes,
              signal: controller.signal,
            });
            const physicalSizeBytes = previousPhysicalSizeBytes + result.newPhysicalSizeBytes;
            const measured = {
              cid: payload.cid,
              signer,
              logicalSizeBytes: result.logicalSizeBytes,
              physicalSizeBytes,
              blocks: result.blocks,
            };
            const measuredVerdict = deps.quota.recheck(reservation.reservationId, measured);
            if (!measuredVerdict.allowed) {
              throw new QuotaRecheckError(measuredVerdict.reason ?? 'reservation-exceeded');
            }
            if (controller.signal.aborted) throw new PinTimeoutError();
            const nextMeta: PinMeta = {
              category: payload.category,
              signer,
              logicalSizeBytes: result.logicalSizeBytes,
              physicalSizeBytes,
              source: 'api',
            };
            await deps.cluster.pin(payload.cid, nextMeta);
            preparedBlocks = result.blocks;
            return nextMeta;
          })(),
          pinTimeoutMs,
          controller,
        );
      } catch (error) {
        if (error instanceof QuotaRecheckError) {
          sendJson(res, 507, { error: 'QUOTA_EXCEEDED', reason: error.reason });
          return;
        }
        if (error instanceof PinResourceLimitError) {
          sendJson(res, 413, { error: 'PIN_LIMIT_EXCEEDED' });
          return;
        }
        // 逾時或 pinExecutor 內部失敗（DAG 從 mesh 抓不齊等）一律回 504、不呼叫
        // recordPin——整筆失敗、不留半 pin 的配額帳目。
        sendJson(res, 504, { error: 'PIN_TIMEOUT' });
        return;
      }
      // commit 是同步記帳，不屬於搬運／Cluster 逾時錯誤面；若不變式被破壞，讓外層回 500。
      deps.quota.commit(reservation.reservationId, { cid: payload.cid, meta }, preparedBlocks);
      committed = true;
    } finally {
      if (!committed) deps.quota.release(reservation.reservationId);
    }
    sendJson(res, 200, { ok: true, cid: payload.cid });
  };

  const handleUnpin = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let rawBody: unknown;
    try {
      rawBody = await readJsonBody(req);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
        return;
      }
      if (err instanceof InvalidJsonError) {
        sendJson(res, 403, { error: 'SIG_INVALID' });
        return;
      }
      throw err;
    }

    const verified = verifyPinRequest(decodeWireBody(rawBody), Date.now(), nonces);
    if (!verified.ok) {
      sendJson(res, 403, { error: verified.code });
      return;
    }
    if (verified.payload.type !== 'pinning-unpin') {
      sendJson(res, 403, { error: 'SIG_INVALID' });
      return;
    }
    const { signer, payload } = verified;

    if (!checkSignerRate(signer, 'unpin')) {
      sendJson(res, 429, { error: 'RATE_LIMITED' });
      return;
    }

    // unpin 授權規則與 pin 不同（見檔頭說明）：白名單成員可 unpin 任何 CID；否則只有這個
    // CID 目前記錄的原 signer 本人可以 unpin（找不到記錄＝不算原 signer）。不呼叫
    // authorize()——信譽達標不足以讓人 unpin 別人的內容。
    const isWhitelisted = deps.config.auth.authorizedSigners.includes(signer);
    if (!isWhitelisted) {
      const record = await findPinRecord(deps.cluster, payload.cid);
      if (record?.meta.signer !== signer) {
        sendJson(res, 403, { error: 'NOT_AUTHORIZED' });
        return;
      }
    }

    // 同 handlePin：try/catch 只包住 pinExecutor 呼叫本身，quota.recordUnpin 與成功回應留在
    // 外面，避免記帳出錯被誤標成逾時。
    const controller = new AbortController();
    try {
      await withTimeout(
        deps.pinExecutor.unpin({ cid: payload.cid, signal: controller.signal }),
        pinTimeoutMs,
        controller,
      );
    } catch {
      sendJson(res, 504, { error: 'PIN_TIMEOUT' });
      return;
    }
    deps.quota.recordUnpin(payload.cid);
    sendJson(res, 200, { ok: true, cid: payload.cid });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 在任何 CORS、preflight、委派 handler 或一般 route 之前套用安全基線，讓 2xx／4xx／5xx、
    // JSON／raw block 與未來新增路由都預設受保護。個別 route 仍可覆寫需要更精確的值，例如
    // self-host Swagger 的 CSP。
    applySecurityHeaders(res);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const origin = requestCorsOrigin(req);
    const corsAllowed = origin !== undefined && corsAllowedOrigins.has(origin);

    // ACAO 必須逐 request 回顯已核准的單一 origin；刻意不設 credentials，也不使用 wildcard。
    // 沒有 Origin 的同源／server-to-server 呼叫維持既有行為。
    if (req.headers.origin !== undefined && corsAllowedOrigins.size > 0) {
      appendVaryOrigin(res);
    }
    if (corsAllowed) res.setHeader('access-control-allow-origin', origin);

    // Preflight 不進入一般 API 限流與路由；否則一次瀏覽器操作會先白白消耗一顆 token。
    if (method === 'OPTIONS' && req.headers.origin !== undefined) {
      if (!corsAllowed) {
        sendJson(res, 403, { error: 'CORS_ORIGIN_DENIED' });
        return;
      }
      const requestedMethod = req.headers['access-control-request-method'];
      const headers = requestedCorsHeaders(req);
      if (
        (requestedMethod !== 'GET' && requestedMethod !== 'POST') ||
        headers.some((header) => header !== CORS_ALLOWED_HEADERS)
      ) {
        sendJson(res, 403, { error: 'CORS_PREFLIGHT_DENIED' });
        return;
      }
      res.setHeader('access-control-allow-methods', CORS_ALLOWED_METHODS);
      res.setHeader('access-control-allow-headers', CORS_ALLOWED_HEADERS);
      res.writeHead(204);
      res.end();
      return;
    }

    // /api/dmca/* 命名空間：以單一 dispatcher 委派給注入的 dmcaHandler（見 ApiDeps.dmcaHandler
    // 說明）。委派處理器全權負責回應（含它自己的 rate limit／body 上限），故此處不套用本 server
    // 的 token bucket 限流、也不走下方的路由。未提供 handler（DMCA 關閉）時直接回 404 並正常
    // 關閉連線——不留「早退不寫 res」造成的連線懸置。
    const isDmcaAdminDocsPath =
      url.pathname === '/admin/docs' || url.pathname.startsWith('/admin/assets/');
    if (
      url.pathname.startsWith('/api/dmca/') ||
      (deps.dmcaAdminDocsEnabled === true && isDmcaAdminDocsPath)
    ) {
      if (url.pathname === '/api/dmca/transparency' && !deps.config.provider.transparencyEnabled) {
        sendJson(res, 404, { error: 'NOT_FOUND' });
        return;
      }
      if (deps.dmcaHandler !== undefined) await deps.dmcaHandler(req, res);
      else sendJson(res, 404, { error: 'NOT_FOUND' });
      return;
    }

    if (!checkClientRate(req)) {
      sendJson(res, 429, { error: 'RATE_LIMITED' });
      return;
    }

    if (method === 'GET' && url.pathname === '/stats') {
      sendJson(res, 200, await deps.stats());
      return;
    }

    if (method === 'GET' && url.pathname === '/provider') {
      sendJson(
        res,
        200,
        makeProviderDescriptor({
          providerId: deps.providerId,
          ...deps.config.provider,
        }),
      );
      return;
    }

    if (method === 'GET' && url.pathname.startsWith('/api/ugc/')) {
      if (!deps.config.provider.ugcReadEnabled) {
        sendJson(res, 403, { error: 'CAPABILITY_DISABLED' });
        return;
      }
      const request = parseUgcBlockPath(url.pathname);
      if (request === undefined) {
        sendJson(res, 400, { error: 'INVALID_CID_PATH' });
        return;
      }
      if (
        deps.denyList.isBlacklisted(request.rootCid) ||
        !deps.quota.hasRootBlock(request.rootCid, request.blockCid) ||
        deps.kubo.blockGet === undefined
      ) {
        sendJson(res, 404, { error: 'NOT_FOUND' });
        return;
      }
      try {
        const bytes = await deps.kubo.blockGet(request.blockCid);
        if (res.headersSent) return;
        res.writeHead(200, {
          'content-type': 'application/vnd.ipld.raw',
          'content-length': String(bytes.byteLength),
          'cache-control': 'private, no-store',
        });
        res.end(bytes);
      } catch {
        sendJson(res, 404, { error: 'NOT_FOUND' });
      }
      return;
    }

    if (method === 'POST' && url.pathname === '/pin') {
      if (!deps.config.provider.ugcWriteEnabled) {
        sendJson(res, 403, { error: 'CAPABILITY_DISABLED' });
        return;
      }
      await handlePin(req, res);
      return;
    }

    if (method === 'POST' && url.pathname === '/unpin') {
      await handleUnpin(req, res);
      return;
    }

    sendJson(res, 404, { error: 'NOT_FOUND' });
  };

  const httpServer = createHttpServer((req, res) => {
    // 連線層錯誤（如用戶端中途斷線）必須有 listener，否則未接聽的 'error' 事件會讓整個
    // 行程崩潰；置於最前——搶在任何後續非同步工作（限流／body 讀取）之前掛上，涵蓋整個
    // 請求生命週期。
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    req.socket.on('error', () => {});
    if (deps.metrics !== undefined) {
      const startedAt = Date.now();
      const route = metricRoute(req);
      res.once('finish', () => {
        deps.metrics?.recordApi(route, statusClass(res.statusCode), Date.now() - startedAt);
      });
    }
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL_ERROR' });
      console.error('[api/server] 未預期錯誤', err);
    });
  });

  const ready = new Promise<number>((resolve) => {
    httpServer.listen(deps.config.port, () => {
      const address = httpServer.address();
      resolve(typeof address === 'object' && address !== null ? address.port : deps.config.port);
    });
  });

  return {
    ready,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}
