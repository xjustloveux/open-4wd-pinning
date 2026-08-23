/**
 * 測試專用替身——僅供 api 目錄下的 *.spec.ts 使用，不是對外 API（不從 index.ts 匯出）。
 *
 * 簽章運算與 auth/auth.test-support.ts 同款作法：金鑰生成／原始簽章改用 @noble/curves 直接
 * 進行（通用 Ed25519 曲線數學，任何正確實作天生位元組相容，不需要共用「同一顆函式」），但
 * 待簽訊息的組裝嚴格重用 vendored 的 buildSignedMessage——這段才是真正需要位元組相容保證的
 * 部分。刻意不 import auth/auth.test-support.ts：測試專用替身不跨模組互相依賴（該檔本身的
 * 檔頭註解也寫明「僅供 auth 目錄下的 *.spec.ts 使用」），這裡自成一份。
 *
 * 額外多做的一步是 auth.test-support.ts 沒有的：本檔的簽章輸出要走 HTTP JSON body，所以把
 * nonce／signature 兩個二進位欄位序列化成 hex 字串（wire 格式decoded 回 Uint8Array 的邏輯在
 * server.ts 的 decodeWireBody，兩邊的欄位名稱＋編碼約定必須一致）。
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import type { AuthDeps, PinPayload, UnpinPayload } from '../auth';
import {
  Protocol,
  buildSignedMessage,
  publicKeyToPeerId,
  type PeerId,
  type PinRequestCategory,
} from '../core';
import type {
  ClusterClient,
  KuboClient,
  PinRecord,
  QuotaAdmission,
  QuotaVerdict,
} from '../pinning';
import type {
  ApiConfig,
  ApiDeps,
  ClusterPort,
  DenyListPort,
  PinExecutor,
  QuotaPort,
  StatsBody,
} from './server';
import type { TokenBucketConfig } from './rate-limit';

export interface TestSigner {
  readonly peerId: PeerId;
  readonly privateKey: Uint8Array;
}

/** 以固定 seed 決定性衍生一把測試用 Ed25519 金鑰；同一 seed 恆回同一身分。純同步（無 I/O），
 * 讓 stubDeps() 整體維持同步——server.spec.ts 給定的 `deps = stubDeps();` 沒有 await。 */
export function makeSigner(seed: number): TestSigner {
  const privateKey = new Uint8Array(32).fill(seed);
  const publicKey = ed25519.getPublicKey(privateKey);
  return { peerId: publicKeyToPeerId(publicKey), privateKey };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 簽出一筆 pin／unpin 請求的 wire body（JSON 可序列化：nonce／signature 皆已轉 hex 字串）。 */
export async function signBody(
  signer: TestSigner,
  payload: PinPayload | UnpinPayload,
  timestamp: number = Date.now(),
): Promise<Record<string, unknown>> {
  const nonce = crypto.getRandomValues(new Uint8Array(Protocol.security.P2P_MESSAGE_NONCE_BYTES));
  const message = buildSignedMessage(payload, timestamp, nonce, signer.peerId);
  const signature = ed25519.sign(message, signer.privateKey);
  return {
    payload,
    timestamp,
    nonceHex: bytesToHex(nonce),
    signer: signer.peerId,
    signatureHex: bytesToHex(signature),
  };
}

const DEFAULT_CATEGORY = 'part';
const DEFAULT_SIZE_HINT_BYTES = 1024;

export async function signedPin(
  signer: TestSigner,
  cid: string,
  opts: { category?: PinRequestCategory; sizeHintBytes?: number; timestamp?: number } = {},
): Promise<Record<string, unknown>> {
  const payload: PinPayload = {
    type: 'pinning-pin',
    cid,
    category: opts.category ?? DEFAULT_CATEGORY,
    sizeHintBytes: opts.sizeHintBytes ?? DEFAULT_SIZE_HINT_BYTES,
  };
  return signBody(signer, payload, opts.timestamp);
}

export async function signedUnpin(
  signer: TestSigner,
  cid: string,
  opts: { timestamp?: number } = {},
): Promise<Record<string, unknown>> {
  const payload: UnpinPayload = { type: 'pinning-unpin', cid };
  return signBody(signer, payload, opts.timestamp);
}

export interface StubCluster extends ClusterPort {
  readonly pinned: PinRecord[];
  readonly unpinned: string[];
  /** list() 被呼叫的累計次數——供測試斷言「安全閘沒有觸發整份 pinset 掃描」（見
   * server.spec.ts 的 DoS 放大防護測試）。 */
  readonly listCalls: number;
  /** get() 被呼叫的累計次數——同上，供測試斷言單筆查詢確實被使用（或確實沒被使用，例如
   * 白名單短路情境）。 */
  readonly getCalls: number;
}

function createStubCluster(): StubCluster {
  const pinned: PinRecord[] = [];
  const unpinned: string[] = [];
  let listCalls = 0;
  let getCalls = 0;
  return {
    pinned,
    unpinned,
    get listCalls() {
      return listCalls;
    },
    get getCalls() {
      return getCalls;
    },
    async pin(cid, meta) {
      // 真 cluster 的 POST /pins/{cid} 是以 cid 為主鍵的 upsert：同一 cid 再次呼叫用新
      // metadata 整筆覆寫舊記錄（last-writer-wins），不是新增一筆重複紀錄。這裡照樣模擬
      // ——早期版本用單純 push，會讓「re-pin 覆寫既有記錄」相關的授權情境（見 server.ts
      // 的 handlePin／findPinRecord 說明）在測試裡從未真的被演練到。
      const idx = pinned.findIndex((p) => p.cid === cid);
      if (idx === -1) pinned.push({ cid, meta });
      else pinned[idx] = { cid, meta };
    },
    async unpin(cid) {
      unpinned.push(cid);
      const idx = pinned.findIndex((p) => p.cid === cid);
      if (idx !== -1) pinned.splice(idx, 1);
    },
    async *list() {
      listCalls += 1;
      // 對 pinned 拍一份快照再迭代：呼叫端（例如 reconcile 風格的掃描）可能在迭代過程中
      // 觸發 pin/unpin 副作用，若直接迭代活陣列，中途增刪會讓走訪行為不可預期。
      for (const record of [...pinned]) yield record;
    },
    async get(cid) {
      getCalls += 1;
      return pinned.find((p) => p.cid === cid);
    },
    async peers() {
      return 1;
    },
  };
}

function createStubKubo(): KuboClient {
  return {
    async blockPut() {
      return 'bafyStub';
    },
    async hasBlock() {
      return true;
    },
    async stats() {
      return { repoSizeBytes: 0, availableBytes: 0 };
    },
  };
}

export interface StubQuota extends QuotaPort {
  nextVerdict: QuotaVerdict;
  readonly recordPinCalls: PinRecord[];
  readonly recordUnpinCalls: string[];
  readonly activeReservations: number;
}

function createStubQuota(): StubQuota {
  const recordPinCalls: PinRecord[] = [];
  const recordUnpinCalls: string[] = [];
  let verdict: QuotaVerdict = { allowed: true };
  let nextReservationId = 1;
  const reservations = new Map<string, QuotaAdmission>();
  return {
    get nextVerdict() {
      return verdict;
    },
    set nextVerdict(v: QuotaVerdict) {
      verdict = v;
    },
    admit: () => verdict,
    reserve: (input) => {
      if (!verdict.allowed) {
        return { allowed: false, reason: verdict.reason ?? 'global-size' };
      }
      const reservationId = `stub-${nextReservationId}`;
      nextReservationId += 1;
      reservations.set(reservationId, input);
      return { allowed: true, reservationId };
    },
    recheck: (reservationId, input) => {
      const reserved = reservations.get(reservationId);
      if (
        reserved === undefined ||
        input.logicalSizeBytes > reserved.logicalSizeBytes ||
        input.physicalSizeBytes > reserved.physicalSizeBytes
      ) {
        return { allowed: false, reason: 'reservation-exceeded' };
      }
      return verdict;
    },
    release: (reservationId) => {
      reservations.delete(reservationId);
    },
    commit: (reservationId, rec) => {
      reservations.delete(reservationId);
      recordPinCalls.push(rec);
    },
    recordPin: (rec) => {
      recordPinCalls.push(rec);
    },
    recordUnpin: (cid) => {
      recordUnpinCalls.push(cid);
    },
    hasRootBlock: () => false,
    recordPinCalls,
    recordUnpinCalls,
    get activeReservations() {
      return reservations.size;
    },
  };
}

function createStubDenyList(blacklistedCid: string): DenyListPort {
  return {
    isBlacklisted: (cid) => cid === blacklistedCid,
  };
}

function createStubAuthDeps(): AuthDeps {
  return {
    reputationOf: () => undefined,
    isRepeatInfringer: () => false,
  };
}

function createStubPinExecutor(cluster: ClusterClient): PinExecutor {
  void cluster;
  return {
    async preparePin({ sizeHintBytes }) {
      return {
        logicalSizeBytes: sizeHintBytes,
        newPhysicalSizeBytes: sizeHintBytes,
        blocks: [{ cid: `stub:${sizeHintBytes}`, sizeBytes: sizeHintBytes }],
      };
    },
    async unpin({ cid }) {
      await cluster.unpin(cid);
    },
  };
}

async function stubStats(): Promise<StatsBody> {
  return {
    node_id: 'test-node',
    version: '0.0.0-test',
    uptime: 0,
    total_pinned_count: 0,
    total_size_bytes: 0,
    available_space_bytes: 0,
    ipfs_cluster_peers: 1,
    last_sync_timestamp: 0,
    accepting_pins: true,
    quota_used_bytes: 0,
    quota_limit_bytes: 1024 ** 4,
  };
}

export interface StubConfigOverrides {
  readonly auth?: ApiConfig['auth'];
  readonly pinTimeoutMs?: number;
  readonly rateLimit?: TokenBucketConfig;
  readonly signerRateLimit?: TokenBucketConfig;
  readonly provider?: ApiConfig['provider'];
}

export interface StubOverrides {
  readonly config?: StubConfigOverrides;
  readonly authDeps?: AuthDeps;
  readonly pinExecutor?: PinExecutor;
}

export interface StubDepsResult extends ApiDeps {
  readonly quota: StubQuota;
  readonly cluster: StubCluster;
  readonly whitelisted: TestSigner;
  readonly stranger: TestSigner;
  readonly blacklistedCid: string;
}

/**
 * 建立一整套 ApiDeps 測試替身（同步——見 makeSigner 註解）。預設：`whitelisted` 是唯一白名單
 * signer、`stranger` 未獲任何授權、`blacklistedCid` 恆被 denyList 判黑名單、quota 恆放行
 * （可經 `.nextVerdict` 動態改判）、rate limit 給極寬鬆的預設值（capacity/refillPerSec 皆
 * 1000）避免多個 it() 共用同一顆 server 時互相干擾——需要精確驗證限流邊界的測試請自行以
 * overrides.config.rateLimit 蓋一個小值、並建立獨立的 server 實例，不要共用這份寬鬆預設。
 */
export function stubDeps(overrides: StubOverrides = {}): StubDepsResult {
  const whitelisted = makeSigner(1);
  const stranger = makeSigner(2);
  const blacklistedCid = 'bafyBlacklisted';

  const cluster = createStubCluster();
  const kubo = createStubKubo();
  const quota = createStubQuota();
  const denyList = createStubDenyList(blacklistedCid);
  const authDeps = overrides.authDeps ?? createStubAuthDeps();
  const pinExecutor = overrides.pinExecutor ?? createStubPinExecutor(cluster);

  const config: ApiConfig = {
    port: 0,
    auth: overrides.config?.auth ?? { authorizedSigners: [whitelisted.peerId] },
    pinTimeoutMs: overrides.config?.pinTimeoutMs ?? 5_000,
    rateLimit: overrides.config?.rateLimit ?? { capacity: 1000, refillPerSec: 1000 },
    signerRateLimit: overrides.config?.signerRateLimit ?? { capacity: 1000, refillPerSec: 1000 },
    provider: overrides.config?.provider ?? {
      ugcReadEnabled: true,
      ugcWriteEnabled: true,
      legalNoticeEnabled: false,
      counterNoticeEnabled: false,
      transparencyEnabled: false,
      designatedAgentRegistration: 'not-declared',
    },
  };

  return {
    config,
    quota,
    cluster,
    kubo,
    denyList,
    authDeps,
    stats: stubStats,
    providerId: 'test-node',
    pinExecutor,
    whitelisted,
    stranger,
    blacklistedCid,
  };
}
