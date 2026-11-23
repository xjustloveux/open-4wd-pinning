/**
 * reconcile 測試共用替身——僅供 subscriber 目錄下的 *.spec.ts 使用，不是對外 API
 * （不從 index.ts 匯出）。
 *
 * stub ClusterClient／KuboClient／BlockAccess 只記錄呼叫、不碰真網路：cluster 以一個
 * Map 模擬「目前的 pin 快照」（list() 的資料來源），pin()/unpin() 呼叫同步增減這個快照，
 * 另外用兩個陣列（pinned／unpinned）純記錄「SUT 實際呼叫過什麼」供斷言用——兩者分開，
 * 才不會讓「一開始就存在的 pin」污染「這次 reconcile 到底呼叫了幾次 pin」的斷言。
 *
 * kubo／blocks 這一對用「dag-cbor 包一層 { fakeCid } 標籤」互相呼應：blocks.get(cid) 回
 * dagCbor.encode({ fakeCid: cid }) 的位元組，kubo.blockPut 解碼出 fakeCid 直接回傳當作
 * 「kubo 算出來的 CID」——兩邊天生一致，不需要真的算雜湊，也讓 transferDag 真正跑過一次
 * 「decode→(找不到 CID link，因為 fakeCid 只是個字串欄位)→視為葉節點」的真實程式碼路徑。
 *
 * fabricate 的 LedgerCheckpoint／DerivedState 只填 reconcile 實際讀取的欄位子集（其餘
 * 欄位以 vendored derived-state.ts／events.ts 宣告為準、reconcile 不會去讀，不補值）——
 * 用 as unknown as T 收斂掉沒填的欄位與品牌型別噪音，是測試 fixture 常見手法，不是繞過
 * 生產程式碼的型別檢查。
 */
import * as dagCbor from '@ipld/dag-cbor';
import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';
import type { BlockAccess, DerivedState } from '../core';
import {
  QuotaLedger,
  type ClusterClient,
  type KuboClient,
  type PinRecord,
  type QuotaLimits,
} from '../pinning';
import type { AdoptedCheckpoint, ReconcileCtx } from './reconcile';

// ---- fake DAG 塊：label 先產生真 CIDv1(dag-cbor)，見檔首說明 ----

const fakeBlocks = new Map<string, Uint8Array>();

function cidForBytes(bytes: Uint8Array, codec: number = dagCbor.code): string {
  return CID.createV1(codec, Digest.create(0x12, sha256(bytes))).toString();
}

export function fakeDagCid(labelOrCid: string): string {
  try {
    const parsed = CID.parse(labelOrCid);
    if (parsed.version === 1 && parsed.code === dagCbor.code) return labelOrCid;
  } catch {
    // Human-readable test labels are converted below.
  }
  const encoded = dagCbor.encode({ fakeLabel: labelOrCid });
  const bytes = new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  const cid = cidForBytes(bytes);
  fakeBlocks.set(cid, bytes);
  return cid;
}

// ---- fake cluster ----

export interface FakeClusterClient extends ClusterClient {
  /** SUT 呼叫 pin() 且成功的逐筆記錄（依呼叫序）。 */
  readonly pinned: PinRecord[];
  /** SUT 呼叫 unpin() 且成功的逐筆 cid（依呼叫序）。 */
  readonly unpinned: string[];
}

/**
 * 預先存在的 pin——模擬節點重啟後由 cluster 實際 pin 列表重建、或先前已由 /pin API／
 * 前一輪 reconcile 存進去的既有內容。retired／黑名單 CID 只有在「目前真的被 pin 著」時
 * reconcile 才會呼叫 unpin，這裡固定納入本檔測試會用到的 retired／blacklist fixture
 * cid，讓「掃到→cluster 快照裡已經有→真的 unpin」這條路徑有機會被驗證到，而不是每個
 * 案例都得手動重新宣告一次「這個 cid 早就 pin 過了」。
 */
const DEFAULT_EXISTING_PINS: PinRecord[] = [
  { cid: 'cidRetired', meta: { category: 'part', source: 'api' } },
  { cid: 'cidBad', meta: { category: 'part', source: 'api' } },
];

export interface FakeCtxOptions {
  /** 呼叫 cluster.pin 時要模擬失敗的 cid 清單（單筆失敗只記警告、不中斷 reconcile）。 */
  failPinCids?: string[];
  /** 第一次呼叫 cluster.unpin 時要模擬失敗的 cid；後續呼叫會恢復成功。 */
  failUnpinOnceCids?: string[];
  quotaLimits?: QuotaLimits;
  quotaRecords?: PinRecord[];
  initialPins?: PinRecord[];
}

export interface FakeCtx extends ReconcileCtx {
  readonly cluster: FakeClusterClient;
  readonly quota: QuotaLedger;
}

export function fakeCtx(opts: FakeCtxOptions = {}): FakeCtx {
  const failSet = new Set((opts.failPinCids ?? []).map(fakeDagCid));
  const failUnpinOnceSet = new Set((opts.failUnpinOnceCids ?? []).map(fakeDagCid));
  const pinned: PinRecord[] = [];
  const unpinned: string[] = [];
  const snapshot = new Map<string, PinRecord>(
    [...DEFAULT_EXISTING_PINS, ...(opts.initialPins ?? [])].map((record) => [record.cid, record]),
  );

  const cluster: FakeClusterClient = {
    pinned,
    unpinned,
    async pin(cid, meta) {
      if (failSet.has(cid)) throw new Error(`fake cluster pin 失敗（測試模擬）：${cid}`);
      const record: PinRecord = { cid, meta };
      pinned.push(record);
      snapshot.set(cid, record);
    },
    async unpin(cid) {
      if (failUnpinOnceSet.delete(cid)) {
        throw new Error(`fake cluster unpin 首次失敗（測試模擬）：${cid}`);
      }
      unpinned.push(cid);
      snapshot.delete(cid);
    },
    async *list() {
      for (const record of snapshot.values()) yield record;
    },
    async peers() {
      return 1;
    },
  };

  const stored = new Map<string, Uint8Array>();
  const kubo: KuboClient = {
    async blockPut(bytes, codec) {
      const cid = cidForBytes(bytes, codec === 'raw' ? 0x55 : dagCbor.code);
      stored.set(cid, bytes);
      return cid;
    },
    async hasBlock(cid) {
      return stored.has(cid);
    },
    async stats() {
      return { repoSizeBytes: 0, availableBytes: 0 };
    },
  };

  const blocks: BlockAccess = {
    async get(cid) {
      return fakeBlocks.get(String(cid)) ?? null;
    },
    async putDagCbor(): Promise<never> {
      throw new Error('fake BlockAccess.putDagCbor：reconcile 流程不應呼叫（僅供型別滿足）');
    },
    async putRaw(): Promise<never> {
      throw new Error('fake BlockAccess.putRaw：reconcile 流程不應呼叫（僅供型別滿足）');
    },
    async pin(): Promise<never> {
      throw new Error('fake BlockAccess.pin：reconcile 流程不應呼叫（僅供型別滿足）');
    },
  };

  const quota = new QuotaLedger(
    opts.quotaLimits ?? { perSignerMaxPins: 100, perSignerMaxSizeGb: 100, globalMaxSizeTb: 100 },
  );
  quota.load(opts.quotaRecords ?? []);

  return { cluster, kubo, blocks, quota };
}

// ---- fabricate LedgerCheckpoint／DerivedState ----

export interface FakeStateOptions {
  /** cold partition key → CID；預設空集。 */
  coldParts?: Record<string, string>;
  /** 要標成 retired 的 UGC CID 清單。 */
  retired?: string[];
  /** 要放進 moderation.blacklist 的 CID 清單。 */
  blacklist?: string[];
}

export function fakeState(opts: FakeStateOptions = {}): DerivedState {
  const coldMatchPartitions = new Map(
    Object.entries(opts.coldParts ?? {}).map(([key, cid]) => [key, fakeDagCid(cid)]),
  );
  const ugcRecords = new Map((opts.retired ?? []).map((cid) => [cid, { retired: true }]));
  const blacklist = new Set(opts.blacklist ?? []);

  return {
    ugc: { ugcRecords },
    moderation: { blacklist },
    coldMatchPartitions,
  } as unknown as DerivedState;
}

export interface FakeCheckpointOptions extends FakeStateOptions {
  /** 檢查點本體、derived state、signer set 的 cid（預設值可個別覆寫）。 */
  cid?: string;
  derivedStateCid?: string;
  signerSetCid?: string;
}

export function fakeCheckpoint(opts: FakeCheckpointOptions = {}): {
  checkpoint: AdoptedCheckpoint;
  state: DerivedState;
} {
  const checkpoint = {
    cid: fakeDagCid(opts.cid ?? 'cidCheckpoint'),
    derived_state_cid: fakeDagCid(opts.derivedStateCid ?? 'cidDerivedState'),
    signer_set_cid: fakeDagCid(opts.signerSetCid ?? 'cidSignerSet'),
  } as unknown as AdoptedCheckpoint;

  return { checkpoint, state: fakeState(opts) };
}
