/**
 * IPFS Cluster REST API 的最小客戶端——只覆蓋 pinning 服務需要的五個操作
 * （pin／unpin／get／list／peers）。相依全走注入的 `fetchFn`（預設 `globalThis.fetch`），
 * 不吃任何 vendored／第三方 HTTP 套件，方便測試以 `node:http` 假伺服器抽換，
 * 也不增加供應鏈面。
 *
 * 官方 API 參考（ipfscluster.io/documentation/reference/api/）：
 * - `POST /pins/{cid}`   新增 pin；pin 選項（含自訂 metadata）以 query string 帶入，
 *   metadata 的每個鍵值對編碼成 `meta-<key>=<value>`（Cluster 的 `PinOptions.Metadata`）。
 * - `DELETE /pins/{cid}` 移除 pin。
 * - `GET /pins/{cid}`    查詢單一 CID 的 pin 狀態。⭐這個端點回的是「狀態」而不是「記錄」：
 *   未被 pin 過與已 unpin 的 CID 一樣回 200，只是 `peer_map` 內每個 peer 的 `status` 為
 *   `unpinned` 且沒有 metadata；是否真的存在受管 pin 必須看狀態，不能只看 HTTP 碼。
 * - `GET /pins`          列出 pinset，NDJSON 串流（每行一個 Pin JSON 物件）。
 * - `GET /peers`         列出 cluster peers，NDJSON 串流（每行一個 peer 物件）。
 *
 * Cluster 的 `Metadata` 是 `map[string]string`——寫入時把 logical/physical size 序列化成
 * 字串，讀出時（`parsePinRecord`）再轉回 number，其餘欄位原樣是字串。
 */

export interface PinMeta {
  category: string;
  signer?: string;
  logicalSizeBytes?: number;
  physicalSizeBytes?: number;
  source: 'api' | 'auto';
}

/** 表示 Cluster 中單一 CID 與其 Pinning 中繼資料。 */
export interface PinRecord {
  cid: string;
  meta: Partial<PinMeta>;
}

/** 定義服務所需的最小 IPFS Cluster 操作介面。 */
export interface ClusterClient {
  pin(cid: string, meta: PinMeta): Promise<void>;
  unpin(cid: string): Promise<void>;
  /** 單筆查詢：某 cid 目前的 pin 記錄，不存在（或已被 unpin）回 undefined——呼叫端只需要
   * 檢查/讀取單一 CID 現況時，不該為此線性掃過整份 pinset（那是 `list()` 的代價量級）。
   * 標為可選：這個方法比介面其餘四個晚加入，把它訂為可選能讓在它加入之前就已經實作這個
   * 介面的既有替身維持有效，不強迫回頭補一個用不到的方法；`createClusterClient()` 的
   * 回傳型別會把它收斂成必要（見該函式定義處）。 */
  get?(cid: string): Promise<PinRecord | undefined>;
  list(): AsyncIterable<PinRecord>;
  peers(): Promise<number>;
}

type FetchFn = typeof globalThis.fetch;

/** 非 2xx 回應統一包成這個錯誤，訊息＋`status` 欄位都帶狀態碼，方便呼叫端判斷或記 log。 */
export class ClusterClientError extends Error {
  constructor(
    method: string,
    path: string,
    readonly status: number,
    body: string,
  ) {
    super(`cluster ${method} ${path} 回應非 2xx：HTTP ${status}${body ? ` — ${body}` : ''}`);
    this.name = 'ClusterClientError';
  }
}

const metaToQuery = (meta: PinMeta): string => {
  const params = new URLSearchParams();
  params.set('meta-category', meta.category);
  params.set('meta-source', meta.source);
  if (meta.signer !== undefined) params.set('meta-signer', meta.signer);
  if (meta.logicalSizeBytes !== undefined) {
    params.set('meta-logicalSizeBytes', String(meta.logicalSizeBytes));
  }
  if (meta.physicalSizeBytes !== undefined) {
    params.set('meta-physicalSizeBytes', String(meta.physicalSizeBytes));
  }
  return params.toString();
};

/** Cluster 回傳的 Pin JSON——只挑我們讀得懂、用得到的欄位，其餘（allocations／created…）不理會。 */
interface ClusterPinJson {
  cid?: unknown;
  Cid?: unknown;
  metadata?: Record<string, string>;
  peer_map?: Record<string, { status?: unknown }>;
}

/** 代表「這個 CID 目前不在 pinset 內」的 tracker 狀態；其餘狀態（pinned、pinning、
 * pin_queued、remote、各種 error）都表示 cluster 仍在管這顆 CID。 */
const UNTRACKED_PIN_STATUSES = new Set(['unpinned', 'undefined']);

/** 判斷單筆狀態回應是否代表一筆真的存在的受管 pin。
 *
 * 未被 pin 過與已 unpin 的 CID 都會拿到 200 與一份 `peer_map` 全為 `unpinned` 的狀態物件；
 * 若把它當成既有記錄，pin 流程的「他人已 pin 就冪等回成功」判斷會對每一筆首次 pin 成立
 * （空 metadata 的 signer 必然與請求者不同），於是搬遷、pin 與配額記帳全被略過而仍回 200。
 * `peer_map` 缺席時保守視為存在：寧可多做一次所有權保護，也不要在無法判讀的形狀下放行覆寫。 */
function isTrackedPin(raw: unknown): boolean {
  const peerMap = (raw as ClusterPinJson).peer_map;
  if (peerMap === undefined || peerMap === null) return true;
  const statuses = Object.values(peerMap).map((peer) => peer?.status);
  if (statuses.length === 0) return false;
  return statuses.some(
    (status) => typeof status !== 'string' || !UNTRACKED_PIN_STATUSES.has(status),
  );
}

const parsePinRecord = (raw: unknown): PinRecord => {
  const obj = raw as ClusterPinJson;
  const cidValue = obj.cid ?? obj.Cid;
  const cid = typeof cidValue === 'string' ? cidValue : String(cidValue);
  const metadata = obj.metadata ?? {};

  const meta: Partial<PinMeta> = {};
  if (typeof metadata['category'] === 'string') meta.category = metadata['category'];
  if (typeof metadata['signer'] === 'string') meta.signer = metadata['signer'];
  if (typeof metadata['source'] === 'string') meta.source = metadata['source'] as PinMeta['source'];
  if (typeof metadata['logicalSizeBytes'] === 'string' && metadata['logicalSizeBytes'] !== '') {
    const parsed = Number(metadata['logicalSizeBytes']);
    if (Number.isFinite(parsed)) meta.logicalSizeBytes = parsed;
  }
  if (typeof metadata['physicalSizeBytes'] === 'string' && metadata['physicalSizeBytes'] !== '') {
    const parsed = Number(metadata['physicalSizeBytes']);
    if (Number.isFinite(parsed)) meta.physicalSizeBytes = parsed;
  }
  return { cid, meta };
};

/** 逐行切開 NDJSON（每行一個 JSON 物件），忽略空白行。 */
function* ndjsonLines(text: string): Iterable<string> {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') yield trimmed;
  }
}

/** 回傳型別刻意比 `ClusterClient` 本身更精確：把 `get()` 從介面宣告的可選收斂成必要——這裡
 * 是 `ClusterClient` 唯一的真實實作，一定會提供它；呼叫端（例如 api/ 的安全閘）因此可以
 * 直接呼叫 `client.get(cid)`，不必每次都先判斷這個方法存不存在。 */
export function createClusterClient(
  baseUrl: string,
  fetchFn: FetchFn = globalThis.fetch,
): ClusterClient & { get(cid: string): Promise<PinRecord | undefined> } {
  const root = baseUrl.replace(/\/$/, '');
  const url = (path: string, query?: string): string => `${root}${path}${query ? `?${query}` : ''}`;

  const request = async (method: string, path: string, query?: string): Promise<Response> => {
    const res = await fetchFn(url(path, query), { method });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ClusterClientError(method, path, res.status, body);
    }
    return res;
  };

  return {
    async pin(cid, meta) {
      await request('POST', `/pins/${encodeURIComponent(cid)}`, metaToQuery(meta));
    },

    async unpin(cid) {
      await request('DELETE', `/pins/${encodeURIComponent(cid)}`);
    },

    // 單筆查詢不走共用的 request()：那個 helper 對任何非 2xx 一律拋錯，但這裡 404 是
    // 「這個 cid 沒被 pin 過」的正常狀態、不是錯誤，要轉譯成 undefined 讓呼叫端能用單一
    // if 判斷「有沒有」。其餘非 2xx（伺服器錯誤等）仍與其他操作一致：拋 ClusterClientError。
    // 200 也不代表存在：此端點對未 pin 與已 unpin 的 CID 同樣回 200，必須由 tracker 狀態
    // 判定（見 isTrackedPin）。
    async get(cid) {
      const path = `/pins/${encodeURIComponent(cid)}`;
      const res = await fetchFn(url(path), { method: 'GET' });
      if (res.status === 404) return undefined;
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ClusterClientError('GET', path, res.status, body);
      }
      const raw: unknown = JSON.parse(await res.text());
      if (!isTrackedPin(raw)) return undefined;
      return parsePinRecord(raw);
    },

    async *list() {
      const res = await request('GET', '/pins');
      const text = await res.text();
      for (const line of ndjsonLines(text)) {
        yield parsePinRecord(JSON.parse(line));
      }
    },

    async peers() {
      const res = await request('GET', '/peers');
      const text = await res.text();
      return Array.from(ndjsonLines(text)).length;
    },
  };
}
