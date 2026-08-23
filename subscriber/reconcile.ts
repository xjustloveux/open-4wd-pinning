/**
 * 檢查點採納後的 reconcile：把帳本 derive 出的最新狀態鏡射到 IPFS Cluster 的 pin 集合。
 *
 * 自動 pin 四類內容（檢查點本體／derived state／治理 signer set／各 cold partition，
 * metadata 為 `{ source: 'auto', logicalSizeBytes, physicalSizeBytes }`——source:'auto' 使
 * checkpoint 自動 pin 不佔用任何 signer 的個人配額；global 用量由完整 DAG block 引用索引
 * 計算，metadata physicalSizeBytes 僅為 ingress 歸因）；掃描 cluster 現有的服務自動 cold
 * partition pin，unpin 這次已經不再被任何 partition 引用的舊 CID（quarter 隨時間合併／
 * 裁剪）；另外掃 retired UGC 與
 * 治理黑名單，把「目前真的還 pin 著」的那些一併 unpin——只在 cluster 目前的 pin 快照裡
 * 找得到才會真的呼叫 unpin，避免對從沒 pin 過的 CID 送出無意義的請求。
 *
 * 每一筆 pin／unpin 各自獨立 try/catch：單筆失敗只記進 report.warnings，不會讓整個
 * reconcile 中途拋錯。cold partition 的清理以 cluster 現況為準，因此單筆 unpin 失敗後
 * 不會因前一份 checkpoint 推進而遺失；下一次採納仍會再次嘗試。
 */
import type { BlockAccess, DerivedState, LedgerCheckpoint } from '../core';
import type {
  ClusterClient,
  KuboClient,
  PinMeta,
  PinRecord,
  QuotaAdmission,
  QuotaBlockMeasurement,
  QuotaReservation,
} from '../pinning';
import { transferDag } from './dag-transfer';

/**
 * LedgerCheckpoint 本體是內容定址的 dag-cbor block，不含自己的 CID（CID 是外部對它的
 * canonical bytes 編碼＋雜湊算出來的，不可能把結果嵌回被雜湊的內容裡）。reconcile 的
 * 呼叫端（檢查點採納流程）拿到已解碼的 checkpoint 物件時，本來就同時持有它的 CID
 * （例如 checkpointStore.getLatest() 回傳 `{ cid, checkpoint }`），故以此形態傳入，
 * reconcile 不需要重做一次「canonical CBOR 編碼＋雜湊」才能知道自己在 pin 什麼。
 */
export type AdoptedCheckpoint = LedgerCheckpoint & { readonly cid: string };

/** 提供檢查點同步所需的 Cluster、Kubo、區塊與配額連接埠。 */
export interface ReconcileCtx {
  readonly cluster: ClusterClient;
  readonly kubo: KuboClient;
  readonly blocks: Pick<BlockAccess, 'get'>;
  readonly quota: {
    reserve(input: QuotaAdmission): QuotaReservation;
    release(reservationId: string): void;
    commit(
      reservationId: string,
      record: PinRecord,
      blocks?: readonly QuotaBlockMeasurement[],
    ): void;
    recordUnpin(cid: string): void;
    physicalSizeBytesFor(cid: string): number;
  };
}

/** 記錄單一 pin 或 unpin 失敗，供後續診斷與重試。 */
export interface ReconcileWarning {
  readonly cid: string;
  readonly operation: 'pin' | 'unpin';
  readonly message: string;
}

/** 彙整一次檢查點同步完成、移除與警告項目。 */
export interface ReconcileReport {
  readonly pinned: string[];
  readonly unpinned: string[];
  readonly warnings: ReconcileWarning[];
}

// auto pin metadata 分開保存完整 DAG logical bytes 與本次 ingress 新增的 physical bytes；
// 後者僅供診斷，global physical 由 QuotaLedger 的唯一 block 引用索引計算。auto pin 不佔任何
// signer 個人配額（source:'auto'）。
const autoPinMeta = (
  category: string,
  logicalSizeBytes: number,
  physicalSizeBytes: number,
): PinMeta => ({
  category,
  source: 'auto',
  logicalSizeBytes,
  physicalSizeBytes,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function pinOne(
  ctx: ReconcileCtx,
  cid: string,
  category: string,
  report: ReconcileReport,
): Promise<void> {
  try {
    const { logicalDagBytes, newPhysicalBytes, blocks } = await transferDag({
      root: cid,
      blocks: ctx.blocks,
      kubo: ctx.kubo,
    });
    const physicalSizeBytes = ctx.quota.physicalSizeBytesFor(cid) + newPhysicalBytes;
    const reservation = ctx.quota.reserve({
      cid,
      logicalSizeBytes: logicalDagBytes,
      physicalSizeBytes,
      blocks,
    });
    if (!reservation.allowed) {
      throw new Error(`quota admission rejected: ${reservation.reason}`);
    }
    const meta = autoPinMeta(category, logicalDagBytes, physicalSizeBytes);
    let committed = false;
    try {
      await ctx.cluster.pin(cid, meta);
      ctx.quota.commit(reservation.reservationId, { cid, meta }, blocks);
      committed = true;
    } finally {
      if (!committed) ctx.quota.release(reservation.reservationId);
    }
    report.pinned.push(cid);
  } catch (error) {
    report.warnings.push({ cid, operation: 'pin', message: errorMessage(error) });
  }
}

async function unpinOne(ctx: ReconcileCtx, cid: string, report: ReconcileReport): Promise<void> {
  try {
    await ctx.cluster.unpin(cid);
    ctx.quota.recordUnpin(cid);
    report.unpinned.push(cid);
  } catch (error) {
    report.warnings.push({ cid, operation: 'unpin', message: errorMessage(error) });
  }
}

/** 將採納的檢查點與衍生狀態同步至供應者的 Cluster pin 集合。 */
export async function reconcileCheckpoint(
  ctx: ReconcileCtx,
  cp: AdoptedCheckpoint,
  state: DerivedState,
  prev?: DerivedState,
): Promise<ReconcileReport> {
  // 保留既有呼叫介面；清理權威已改為 Cluster 持久現況，不能再依賴相鄰 checkpoint diff。
  void prev;
  const report: ReconcileReport = { pinned: [], unpinned: [], warnings: [] };

  // pin 順序＝checkpoint→derived-state→signer-set→cold parts；每一筆先 transferDag
  // 確保 kubo 本地有完整內容，成功後才對 cluster 下 pin（見 pinOne）。
  await pinOne(ctx, cp.cid, 'checkpoint', report);
  await pinOne(ctx, cp.derived_state_cid, 'derived-state', report);
  await pinOne(ctx, cp.signer_set_cid, 'signer-set', report);
  for (const partitionCid of state.coldMatchPartitions.values()) {
    await pinOne(ctx, partitionCid, 'cold-partition', report);
  }

  // cold partition／retired／黑名單共用同一份 cluster pin 快照。清理冷分區時直接以這份
  // 持久現況比對目前 state，不再依賴僅相鄰兩份 checkpoint 的 diff；如此上輪 unpin 失敗
  // 留下的 orphan 在下輪仍然看得到。source/category 必須同時精確吻合，絕不碰 API pin、
  // 其他 auto 類別或缺少 metadata 的舊記錄。
  const currentPins: PinRecord[] = [];
  const currentlyPinned = new Set<string>();
  for await (const record of ctx.cluster.list()) {
    currentPins.push(record);
    currentlyPinned.add(record.cid);
  }

  // 同一 CID 若同時符合多個清理條件，一輪只嘗試一次；失敗留待下一次 reconcile 重試。
  const attemptedUnpins = new Set<string>();
  const unpinCurrent = async (cid: string): Promise<void> => {
    if (!currentlyPinned.has(cid) || attemptedUnpins.has(cid)) return;
    attemptedUnpins.add(cid);
    await unpinOne(ctx, cid, report);
  };

  const currentPartitionCids = new Set<string>(state.coldMatchPartitions.values());
  for (const record of currentPins) {
    if (
      record.meta.source === 'auto' &&
      record.meta.category === 'cold-partition' &&
      !currentPartitionCids.has(record.cid)
    ) {
      await unpinCurrent(record.cid);
    }
  }

  for (const [ugcCid, record] of state.ugc.ugcRecords) {
    if (record.retired) await unpinCurrent(ugcCid);
  }
  for (const blacklistedCid of state.moderation.blacklist) {
    await unpinCurrent(blacklistedCid);
  }

  return report;
}

/** repeat-infringer 認定門檻：同一 signer 名下未復原的下架次數達到這個數字，就視為
 * 慣犯、拒絕其後續 pin 請求（著作權安全港慣例的「三振」政策）。這是 pinning 節點自己
 * 的維運政策常數、不是治理 config，本模組獨立持有這個值，不依賴外部設定或其他模組。 */
const REPEAT_INFRINGER_THRESHOLD = 3;

/** 提供 CID 封鎖與重複侵權者判定所需的最新狀態。 */
export interface DenyListDeps {
  /** 目前的 derived state 存取器（黑名單判定唯一事實來源；通常是閉包捕捉「reconcile
   * 迴圈手上最新一份」的參照）——每次查詢都讀當下最新值，DenyList 本身不快取、不持有
   * 自己的一份拷貝，永遠與呼叫端手上的帳本狀態同步。 */
  currentState(): DerivedState;
  /** repeat-infringer 計數來源；由呼叫端注入、與判定依據（DMCA 模組）解耦——本檔刻意
   * 不 import dmca，由組裝層（app/main.ts）注入。省略＝恆回 0（DMCA_ENABLE 關閉時沒有人
   * 會被判 repeat-infringer）。 */
  countNotRestoredTakedowns?(signer: string): Promise<number>;
}

/** 拒服務名單：CID 黑名單（下架≠退役，查中即拒絕 re-pin）與 repeat-infringer（拒新 pin，
 * 不影響既有內容的自清 unpin）兩個獨立判定。 */
export class DenyList {
  constructor(private readonly deps: DenyListDeps) {}

  /** 判斷指定 CID 是否位於目前治理封鎖清單。 */
  isBlacklisted(cid: string): boolean {
    return new Set<string>(this.deps.currentState().moderation.blacklist).has(cid);
  }

  /** 判斷簽署者是否已達營運政策的重複侵權門檻。 */
  async isRepeatInfringer(signer: string): Promise<boolean> {
    const count = (await this.deps.countNotRestoredTakedowns?.(signer)) ?? 0;
    return count >= REPEAT_INFRINGER_THRESHOLD;
  }
}
