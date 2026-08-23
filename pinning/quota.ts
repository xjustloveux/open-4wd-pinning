/**
 * 配額彙算——per-signer 件數／logical 上限以 Cluster pin metadata 重建；global physical
 * 上限以所有 Cluster roots 的完整 DAG 逐 block 實量與引用索引為權威，共用 block 只計一次。
 * metadata 的 physicalSizeBytes 僅保留 root ingress 歸因供診斷。auto pin（`source:'auto'`）
 * 計入 global 用量，但不記入任何 signer 的個人配額。
 *
 * 上限單位換算採二進位（Gb＝GiB＝1024^3 bytes、Tb＝TiB＝1024^4 bytes）——與本檔測試
 * （quota.spec.ts）用 `1024 ** 3`／`1024 ** 4` 字面量表達上限的寫法一致。
 *
 * `admit` 是純檢查；對外 pin pipeline 使用 `reserve` 保留並行請求的最壞情況額度，實量
 * `recheck` 後在 cluster 成功時 `commit`，其餘路徑 `release`。開機時列出 Cluster roots，
 * 再從 Kubo 量測每個完整 DAG 後 `loadMeasured(...)`；任一量測不可用即禁止新 reservation，
 * 但仍允許 unpin。引用索引是記憶體衍生狀態，不另建持久化資料庫。
 */
import type { PinningQuotaReason } from '../core';
import type { PinRecord } from './cluster-client';

/** 設定每位簽署者與全域實體儲存的配額上限。 */
export interface QuotaLimits {
  perSignerMaxPins: number;
  perSignerMaxSizeGb: number;
  globalMaxSizeTb: number;
}

/** 表示配額准入結果與穩定拒絕原因。 */
export interface QuotaVerdict {
  allowed: boolean;
  reason?: PinningQuotaReason;
}

/** 表示成功建立的配額保留或其拒絕原因。 */
export type QuotaReservation =
  | { readonly allowed: true; readonly reservationId: string }
  | { readonly allowed: false; readonly reason: NonNullable<QuotaVerdict['reason']> };

/** 描述配額准入所需的 CID、簽署者與容量量測。 */
export interface QuotaAdmission {
  cid: string;
  signer?: string;
  logicalSizeBytes: number;
  physicalSizeBytes: number;
  /** 完整 DAG 的逐 block 實量；有值時為 global physical quota 的權威輸入。 */
  blocks?: readonly QuotaBlockMeasurement[];
}

/** 記錄完整 DAG 中單一區塊的實際大小。 */
export interface QuotaBlockMeasurement {
  readonly cid: string;
  readonly sizeBytes: number;
}

/** 彙整目前 Pinning 配額帳本與接收能力。 */
export interface QuotaSnapshot {
  totalPins: number;
  totalLogicalSizeBytes: number;
  physicalSizeBytes: number;
  globalMaxSizeBytes: number;
  acceptingPins: boolean;
}

interface SignerUsage {
  pins: number;
  logicalSizeBytes: number;
}

/** 已入帳的單筆 pin——記住「當初實際算進哪個 signer」，供 recordUnpin 精確扣回。 */
interface LedgeredPin {
  signer: string | undefined;
  logicalSizeBytes: number;
  physicalSizeBytes: number;
  blocks: readonly QuotaBlockMeasurement[];
}

interface BlockReference {
  readonly sizeBytes: number;
  readonly roots: Set<string>;
}

interface ReservationEntry {
  readonly input: QuotaAdmission;
  readonly signerPinsDelta: number;
  readonly signerLogicalDelta: number;
  readonly physicalDelta: number;
}

/** 以唯一區塊引用與並行保留維護 Pinning 配額帳本。 */
export class QuotaLedger {
  /** 每位簽署者允許的最大 logical 位元組數。 */
  private readonly perSignerMaxSizeBytes: number;
  /** 所有唯一區塊合計允許的最大實體位元組數。 */
  private readonly globalMaxSizeBytes: number;
  /** 依簽署者索引已提交的 pin 件數與 logical 用量。 */
  private readonly bySigner = new Map<string, SignerUsage>();
  /** 依根 CID 索引已提交的 pin 帳目。 */
  private readonly byCid = new Map<string, LedgeredPin>();
  /** 依區塊 CID 索引其大小與引用該區塊的根 CID。 */
  private readonly blocksByCid = new Map<string, BlockReference>();
  /** 依保留識別索引尚未提交的最壞情況配額。 */
  private readonly reservations = new Map<string, ReservationEntry>();
  /** 防止同一根 CID 同時建立多筆配額保留。 */
  private readonly reservationByCid = new Map<string, string>();
  /** 產生行程內唯一且可診斷的配額保留識別。 */
  private nextReservationId = 1;
  /** 記錄所有已提交根 CID 的 logical 位元組總和。 */
  private totalLogicalSizeBytes = 0;
  /** 記錄所有唯一已引用區塊的實體位元組總和。 */
  private physicalSizeBytes = 0;
  /** 表示啟動量測是否完整到足以接受新 pin。 */
  private accountingAvailable = true;

  constructor(private readonly limits: QuotaLimits) {
    this.perSignerMaxSizeBytes = limits.perSignerMaxSizeGb * 1024 ** 3;
    this.globalMaxSizeBytes = limits.globalMaxSizeTb * 1024 ** 4;
  }

  /** 開機時以 cluster 實際 pin 列表重建整本帳——內部就是逐筆 recordPin，語意保證一致。 */
  load(records: Iterable<PinRecord>): void {
    for (const rec of records) this.recordPin(rec);
  }

  /** 啟動時以 Cluster roots 與 Kubo 完整 DAG 實量重建引用索引。 */
  loadMeasured(
    entries: Iterable<{
      readonly record: PinRecord;
      readonly blocks: readonly QuotaBlockMeasurement[];
    }>,
  ): void {
    for (const { record, blocks } of entries) this.recordPin(record, blocks);
    this.accountingAvailable = true;
  }

  /** Cluster roots 或任一完整 DAG 無法量測時，新 pin 必須 fail-closed。 */
  markAccountingUnavailable(): void {
    this.accountingAvailable = false;
  }

  /** 驗證區塊量測並合併同一 CID 的重複項目。 */
  private normalizedBlocks(
    rootCid: string,
    physicalSizeBytes: number,
    blocks?: readonly QuotaBlockMeasurement[],
  ): readonly QuotaBlockMeasurement[] {
    const source = blocks ?? [{ cid: `legacy:${rootCid}`, sizeBytes: physicalSizeBytes }];
    const byBlock = new Map<string, number>();
    for (const block of source) {
      if (block.cid.length === 0 || !Number.isSafeInteger(block.sizeBytes) || block.sizeBytes < 0) {
        throw new Error(`invalid quota block measurement: ${block.cid}`);
      }
      const prior = byBlock.get(block.cid);
      if (prior !== undefined && prior !== block.sizeBytes) {
        throw new Error(`conflicting quota block size: ${block.cid}`);
      }
      byBlock.set(block.cid, block.sizeBytes);
    }
    return [...byBlock].map(([cid, sizeBytes]) => ({ cid, sizeBytes }));
  }

  /** 將一筆已成功的 pin 依實際區塊引用寫入配額帳本。 */
  recordPin(rec: PinRecord, measuredBlocks?: readonly QuotaBlockMeasurement[]): void {
    // 冪等：同一 cid 重複 pin（例如 reconcile 重跑）先扣回舊帳再記新帳，避免雙重計數。
    if (this.byCid.has(rec.cid)) this.recordUnpin(rec.cid);

    const logicalSizeBytes = rec.meta.logicalSizeBytes ?? 0;
    const physicalSizeBytes = rec.meta.physicalSizeBytes ?? 0;
    // auto pin 不佔用任何 signer 的個人配額——即使 metadata 剛好帶了 signer 欄位也一樣，
    // 因為「是不是系統性 pin」由 source 決定，不是有沒有 signer 決定。
    const signer = rec.meta.source === 'auto' ? undefined : rec.meta.signer;
    const blocks = this.normalizedBlocks(rec.cid, physicalSizeBytes, measuredBlocks);

    this.byCid.set(rec.cid, { signer, logicalSizeBytes, physicalSizeBytes, blocks });
    this.totalLogicalSizeBytes += logicalSizeBytes;
    for (const block of blocks) {
      const existingBlock = this.blocksByCid.get(block.cid);
      if (existingBlock !== undefined) {
        if (existingBlock.sizeBytes !== block.sizeBytes) {
          throw new Error(`conflicting quota block size: ${block.cid}`);
        }
        existingBlock.roots.add(rec.cid);
      } else {
        this.blocksByCid.set(block.cid, {
          sizeBytes: block.sizeBytes,
          roots: new Set([rec.cid]),
        });
        this.physicalSizeBytes += block.sizeBytes;
      }
    }
    if (signer !== undefined) {
      const usage = this.bySigner.get(signer) ?? { pins: 0, logicalSizeBytes: 0 };
      usage.pins += 1;
      usage.logicalSizeBytes += logicalSizeBytes;
      this.bySigner.set(signer, usage);
    }
  }

  /** 從帳本移除一筆 pin，並釋放不再被任何根引用的區塊。 */
  recordUnpin(cid: string): void {
    const entry = this.byCid.get(cid);
    if (entry === undefined) return; // 冪等：unpin 沒帳過的 cid 是 no-op
    this.byCid.delete(cid);
    this.totalLogicalSizeBytes -= entry.logicalSizeBytes;
    for (const block of entry.blocks) {
      const reference = this.blocksByCid.get(block.cid);
      if (reference === undefined) continue;
      reference.roots.delete(cid);
      if (reference.roots.size === 0) {
        this.blocksByCid.delete(block.cid);
        this.physicalSizeBytes -= reference.sizeBytes;
      }
    }

    if (entry.signer !== undefined) {
      const usage = this.bySigner.get(entry.signer);
      if (usage !== undefined) {
        usage.pins -= 1;
        usage.logicalSizeBytes -= entry.logicalSizeBytes;
        if (usage.pins <= 0) this.bySigner.delete(entry.signer);
        else this.bySigner.set(entry.signer, usage);
      }
    }
  }

  /** 計算一筆提案相對於已提交狀態的保守配額增量。 */
  private reservationDeltas(input: QuotaAdmission): Omit<ReservationEntry, 'input'> {
    const existing = this.byCid.get(input.cid);
    const replacesSameSigner = existing?.signer === input.signer && input.signer !== undefined;
    return {
      signerPinsDelta: input.signer === undefined || replacesSameSigner ? 0 : 1,
      // A replacement is not allowed to free committed capacity until it commits. This keeps
      // reservations conservative even when the declared replacement is smaller than the old pin.
      signerLogicalDelta:
        input.signer === undefined
          ? 0
          : Math.max(
              0,
              input.logicalSizeBytes - (replacesSameSigner ? (existing?.logicalSizeBytes ?? 0) : 0),
            ),
      physicalDelta:
        input.blocks === undefined
          ? Math.max(0, input.physicalSizeBytes - (existing?.physicalSizeBytes ?? 0))
          : this.normalizedBlocks(input.cid, input.physicalSizeBytes, input.blocks).reduce(
              (sum, block) => sum + (this.blocksByCid.has(block.cid) ? 0 : block.sizeBytes),
              0,
            ),
    };
  }

  /** 將既有保留一併納入後裁定新的配額提案。 */
  private verdictWithReservations(
    input: QuotaAdmission,
    excludeReservationId?: string,
  ): QuotaVerdict {
    const usage =
      input.signer === undefined
        ? { pins: 0, logicalSizeBytes: 0 }
        : (this.bySigner.get(input.signer) ?? { pins: 0, logicalSizeBytes: 0 });
    let reservedSignerPins = 0;
    let reservedSignerLogical = 0;
    let reservedPhysical = 0;
    for (const [id, reservation] of this.reservations) {
      if (id === excludeReservationId) continue;
      reservedPhysical += reservation.physicalDelta;
      if (reservation.input.signer === input.signer) {
        reservedSignerPins += reservation.signerPinsDelta;
        reservedSignerLogical += reservation.signerLogicalDelta;
      }
    }
    const proposal = this.reservationDeltas(input);
    const pinsAfter = usage.pins + reservedSignerPins + proposal.signerPinsDelta;
    const signerBytesAfter =
      usage.logicalSizeBytes + reservedSignerLogical + proposal.signerLogicalDelta;
    const physicalBytesAfter = this.physicalSizeBytes + reservedPhysical + proposal.physicalDelta;

    if (pinsAfter > this.limits.perSignerMaxPins) {
      return { allowed: false, reason: 'signer-pins' };
    }
    if (input.signer !== undefined && signerBytesAfter > this.perSignerMaxSizeBytes) {
      return { allowed: false, reason: 'signer-size' };
    }
    if (physicalBytesAfter > this.globalMaxSizeBytes) {
      return { allowed: false, reason: 'global-size' };
    }
    return { allowed: true };
  }

  /** 在不改變狀態下預覽目前配額是否允許提案。 */
  admit(input: QuotaAdmission): QuotaVerdict {
    if (!this.accountingAvailable) return { allowed: false, reason: 'accounting-unavailable' };
    if (this.reservationByCid.has(input.cid)) return { allowed: false, reason: 'in-flight' };
    return this.verdictWithReservations(input);
  }

  /** 為並行 pin 流程保留提案的最壞情況配額。 */
  reserve(input: QuotaAdmission): QuotaReservation {
    if (!this.accountingAvailable) return { allowed: false, reason: 'accounting-unavailable' };
    if (this.reservationByCid.has(input.cid)) return { allowed: false, reason: 'in-flight' };
    const verdict = this.verdictWithReservations(input);
    if (!verdict.allowed) return { allowed: false, reason: verdict.reason ?? 'global-size' };
    const reservationId = `quota-${this.nextReservationId}`;
    this.nextReservationId += 1;
    this.reservations.set(reservationId, { input, ...this.reservationDeltas(input) });
    this.reservationByCid.set(input.cid, reservationId);
    return { allowed: true, reservationId };
  }

  /** 以實際量測重新檢查既有保留是否仍在原始上限內。 */
  recheck(reservationId: string, input: QuotaAdmission): QuotaVerdict {
    const reservation = this.reservations.get(reservationId);
    if (
      reservation === undefined ||
      reservation.input.cid !== input.cid ||
      reservation.input.signer !== input.signer ||
      input.logicalSizeBytes > reservation.input.logicalSizeBytes ||
      input.physicalSizeBytes > reservation.input.physicalSizeBytes
    ) {
      return { allowed: false, reason: 'reservation-exceeded' };
    }
    return this.verdictWithReservations(input, reservationId);
  }

  /** 釋放未提交或失敗 pin 流程所持有的配額。 */
  release(reservationId: string): void {
    const reservation = this.reservations.get(reservationId);
    if (reservation === undefined) return;
    this.reservations.delete(reservationId);
    this.reservationByCid.delete(reservation.input.cid);
  }

  /** 將成功 pin 的保留轉成正式配額帳目。 */
  commit(
    reservationId: string,
    record: PinRecord,
    blocks?: readonly QuotaBlockMeasurement[],
  ): void {
    const reservation = this.reservations.get(reservationId);
    if (reservation === undefined || reservation.input.cid !== record.cid) {
      throw new Error('quota reservation does not match committed pin');
    }
    this.release(reservationId);
    this.recordPin(record, blocks);
  }

  /** 回傳含未提交保留影響的目前配額快照。 */
  snapshot(): QuotaSnapshot {
    let reservedPhysicalBytes = 0;
    for (const reservation of this.reservations.values()) {
      reservedPhysicalBytes += reservation.physicalDelta;
    }
    return {
      totalPins: this.byCid.size,
      totalLogicalSizeBytes: this.totalLogicalSizeBytes,
      physicalSizeBytes: this.physicalSizeBytes,
      globalMaxSizeBytes: this.globalMaxSizeBytes,
      acceptingPins:
        this.accountingAvailable &&
        this.physicalSizeBytes + reservedPhysicalBytes < this.globalMaxSizeBytes,
    };
  }

  /** 查詢指定根 CID 在准入時記錄的實體位元組歸因。 */
  physicalSizeBytesFor(cid: string): number {
    return this.byCid.get(cid)?.physicalSizeBytes ?? 0;
  }

  /** Root context 是供應授權的一部分；共享 child 只在指定 root 仍入帳且 traversal 含它時成立。 */
  hasRootBlock(rootCid: string, blockCid: string): boolean {
    return this.byCid.get(rootCid)?.blocks.some((block) => block.cid === blockCid) ?? false;
  }
}
