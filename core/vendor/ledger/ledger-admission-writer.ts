import { Protocol } from '@open4wd/system-constants';
import type { LedgerAdmissionActivity, LedgerAdmissionPhase } from '@open4wd/interfaces';
import type { PreparedCommitResult, PreparedLedgerEntry } from './bounded-events-database';
import {
  LEDGER_ADMISSION_V1,
  LedgerAdmissionPermanentError,
  sealLedgerEntry,
  validateCanonicalLedgerEntryBytes,
  type LedgerAdmissionScheme,
  type LedgerOrbitBaseEntry,
  type SealedLedgerEntry,
} from './ledger-entry-admission';
import type { LedgerAdmissionOutbox, LedgerAdmissionOutboxRecord } from './ledger-admission-outbox';
import type { AdmissionMiner } from './ledger-admission-miner';
import { LedgerEntryProtectionRegistry } from './ledger-entry-protection';

export type { LedgerAdmissionActivity, LedgerAdmissionPhase } from '@open4wd/interfaces';

/** Writer 在 enqueue、cancel、retry 與終止邊界的穩定錯誤碼。 */
export type LedgerAdmissionWriterCode =
  'queue-full' | 'outbox-full' | 'retry-pending' | 'permanent-reject' | 'cancelled' | 'closed';

/** 帶可供 UI/恢復流程分流 code 的 writer error。 */
export class LedgerAdmissionWriterError extends Error {
  constructor(
    readonly code: LedgerAdmissionWriterCode,
    options?: ErrorOptions,
  ) {
    super(`ledger Admission writer: ${code}`, options);
    this.name = 'LedgerAdmissionWriterError';
  }
}

/** Prepare/commit entry 並管理暫時 protection owner 的 database 介面。 */
export interface PreparedLedgerDatabase {
  prepare(value: unknown): Promise<PreparedLedgerEntry>;
  commitPrepared(bytes: Uint8Array, cid: string): Promise<PreparedCommitResult>;
  releasePrepared(owner: string): Promise<void>;
}

type SealEntry = (
  baseEntry: LedgerOrbitBaseEntry,
  nonce: Uint8Array,
  scheme: LedgerAdmissionScheme,
) => Promise<SealedLedgerEntry>;

/** 建立可靠 admission writer 的身分、outbox、miner 與保護依賴。 */
export interface LedgerAdmissionWriterOptions {
  readonly identity: string;
  readonly database: PreparedLedgerDatabase;
  readonly outbox: LedgerAdmissionOutbox;
  readonly miner: AdmissionMiner;
  readonly protection: LedgerEntryProtectionRegistry;
  readonly admissionScheme?: LedgerAdmissionScheme;
  readonly now?: () => number;
  /** startup 已在建立有界儲存前還原這些持久 owner。 */
  readonly restoredOutboxCids?: readonly string[];
  /** 單元測試 seam；production 一律使用 sealLedgerEntry。 */
  readonly sealEntry?: SealEntry;
}

interface Intent {
  readonly value: unknown;
  readonly resolve: (hash: string) => void;
  readonly reject: (error: unknown) => void;
}

const PERMANENT_CODES = new Set([
  'entry-too-large',
  'non-canonical-entry',
  'cid-mismatch',
  'invalid-entry-shape',
  'invalid-proof-shape',
  'insufficient-work',
]);

function causeCode(cause: unknown): string | null {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return null;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

function isPermanentFailure(cause: unknown): boolean {
  const code = causeCode(cause);
  return (
    cause instanceof LedgerAdmissionPermanentError || (code !== null && PERMANENT_CODES.has(code))
  );
}

function immutableActivity(
  phase: LedgerAdmissionPhase,
  queued: number,
  startedAt: number | null,
  cid: string | null,
  canCancel: boolean,
  code: string | null,
): LedgerAdmissionActivity {
  return Object.freeze({ phase, queued, startedAt, cid, canCancel, code });
}

/** 將 intent 依序 prepare、mine、seal、持久化並提交的可靠寫入狀態機。 */
export class LedgerAdmissionWriter {
  /** 此 writer 可恢復與提交的 Orbit identity。 */
  readonly #identity: string;
  /** 提供 prepare 與 atomic commit 的 bounded database。 */
  readonly #database: PreparedLedgerDatabase;
  /** 在 broadcast 前持久化完整 sealed entry 的 outbox。 */
  readonly #outbox: LedgerAdmissionOutbox;
  /** 可取消的 admission work 執行器。 */
  readonly #miner: AdmissionMiner;
  /** 防止 prepared/outbox parents 被 LRU eviction 的 registry。 */
  readonly #protection: LedgerEntryProtectionRegistry;
  /** Seal 與 reload 驗證共用的 admission scheme。 */
  readonly #scheme: LedgerAdmissionScheme;
  /** Activity timestamps 與 outbox createdAt 使用的本地時鐘。 */
  readonly #now: () => number;
  /** Production seal function 或測試 seam。 */
  readonly #sealEntry: SealEntry;
  /** Admission activity observers；個別例外不影響 writer。 */
  readonly #observers = new Set<(activity: LedgerAdmissionActivity) => void>();
  /** 尚未開始 prepare 的 FIFO write intents。 */
  readonly #queue: Intent[] = [];
  /** 此 writer 已恢復或建立、目前持有 protection 的 outbox CIDs。 */
  readonly #ownedOutboxCids = new Set<string>();
  /** 對 UI 公布的 immutable admission activity。 */
  #activity = immutableActivity('idle', 0, null, null, false, null);
  /** Drain loop 是否已取得 writer 執行權。 */
  #active = false;
  /** 目前 drain loop，供 close 等待完整 settle。 */
  #drainPromise: Promise<void> | null = null;
  /** Close 後拒絕新 intents 並終止 loop。 */
  #closed = false;
  /** 取消目前 prepare/mine 工作的 controller。 */
  #currentController: AbortController | null = null;
  /** 目前 database prepare protection owner。 */
  #currentPreparedOwner: string | null = null;
  /** 目前 sealed/submitting entry CID。 */
  #currentCid: string | null = null;
  /** Commit/broadcast 已開始，取消只能轉 uncertain 而不能宣稱未送出。 */
  #submissionStarted = false;
  /** 使用者在 submission 後要求取消的記錄。 */
  #submissionCancelled = false;
  /** 已到 permanent-reject 或 retry-pending 的終態 CID。 */
  #terminalCid: string | null = null;
  /** Startup durable outbox recovery 是否正在執行。 */
  #recovering = false;

  constructor(options: LedgerAdmissionWriterOptions) {
    if (typeof options.identity !== 'string' || options.identity.length === 0)
      throw new TypeError('invalid ledger Admission writer identity');
    this.#identity = options.identity;
    this.#database = options.database;
    this.#outbox = options.outbox;
    this.#miner = options.miner;
    this.#protection = options.protection;
    this.#scheme = options.admissionScheme ?? LEDGER_ADMISSION_V1;
    this.#now = options.now ?? Date.now;
    this.#sealEntry = options.sealEntry ?? sealLedgerEntry;
    for (const cid of options.restoredOutboxCids ?? []) this.#ownedOutboxCids.add(cid);
  }

  /** 訂閱 admission 寫入器的活動狀態，並回傳可解除監聽的函式。 */
  subscribe(handler: (activity: LedgerAdmissionActivity) => void): () => void {
    this.#observers.add(handler);
    try {
      handler(this.#activity);
    } catch {
      // Observer isolation is part of the writer contract.
    }
    return () => this.#observers.delete(handler);
  }

  /** 更新 immutable activity 並隔離通知所有 observers。 */
  #transition(
    phase: LedgerAdmissionPhase,
    options: {
      startedAt?: number | null;
      cid?: string | null;
      canCancel?: boolean;
      code?: string | null;
    } = {},
  ): void {
    this.#activity = immutableActivity(
      phase,
      this.#queue.length,
      options.startedAt === undefined ? this.#activity.startedAt : options.startedAt,
      options.cid === undefined ? this.#activity.cid : options.cid,
      options.canCancel ?? false,
      options.code === undefined ? null : options.code,
    );
    for (const observer of [...this.#observers])
      try {
        observer(this.#activity);
      } catch {
        // A UI observer must not affect durable writer state.
      }
  }

  /** 準備、保護並提交新的帳本事件，成功時回傳其內容識別碼。 */
  add(value: unknown): Promise<string> {
    if (this.#closed) return Promise.reject(new LedgerAdmissionWriterError('closed'));
    const occupied = (this.#active ? 1 : 0) + this.#queue.length;
    if (occupied >= Protocol.ledger.LEDGER_ADMISSION_INTENT_QUEUE_MAX)
      return Promise.reject(new LedgerAdmissionWriterError('queue-full'));
    const promise = new Promise<string>((resolve, reject) => {
      this.#queue.push({ value, resolve, reject });
    });
    if (this.#active)
      this.#transition(this.#activity.phase, {
        startedAt: this.#activity.startedAt,
        cid: this.#activity.cid,
        canCancel: this.#activity.canCancel,
        code: this.#activity.code,
      });
    this.#startDrain();
    return promise;
  }

  /** Single-flight 啟動 FIFO intent drain loop。 */
  #startDrain(): void {
    if (this.#active) return;
    this.#active = true;
    this.#drainPromise = (async () => {
      while (this.#queue.length > 0) {
        const intent = this.#queue.shift()!;
        try {
          intent.resolve(await this.#process(intent.value));
        } catch (cause) {
          intent.reject(cause);
        }
        if (this.#closed) break;
      }
      this.#active = false;
      this.#drainPromise = null;
      if (!['retry-pending', 'permanent-reject', 'uncertain'].includes(this.#activity.phase))
        this.#transition('idle', { startedAt: null, cid: null, canCancel: false });
    })();
  }

  /** 啟動前檢查 outbox 紀錄是否仍可恢復，並重建需要保護的暫存資料。 */
  async #preflightOutbox(): Promise<void> {
    const records = await this.#outbox.list(this.#identity);
    const bytes = records.reduce((sum, record) => sum + record.byteSize, 0);
    if (
      records.length >= Protocol.ledger.LEDGER_ADMISSION_OUTBOX_MAX_ENTRIES ||
      bytes >= Protocol.ledger.LEDGER_ADMISSION_OUTBOX_MAX_BYTES
    )
      throw new LedgerAdmissionWriterError('outbox-full');
  }

  /** 釋放目前已準備事件占用的保護標記與暫存資源。 */
  async #releasePrepared(): Promise<void> {
    const owner = this.#currentPreparedOwner;
    if (owner === null) return;
    this.#currentPreparedOwner = null;
    await this.#database.releasePrepared(owner);
  }

  /** 完成單筆事件的編碼、工作量證明與提交，成功時回傳內容識別碼。 */
  async #process(value: unknown): Promise<string> {
    const startedAt = this.#now();
    const controller = new AbortController();
    this.#currentController = controller;
    this.#currentPreparedOwner = null;
    this.#currentCid = null;
    this.#submissionStarted = false;
    this.#submissionCancelled = false;
    this.#terminalCid = null;
    try {
      await this.#preflightOutbox();
      this.#transition('preparing', { startedAt, cid: null, canCancel: true });
      const prepared = await this.#database.prepare(value);
      this.#currentPreparedOwner = prepared.protectionOwner;
      if (controller.signal.aborted) throw new LedgerAdmissionWriterError('cancelled');

      this.#transition('mining', { startedAt, cid: null, canCancel: true });
      const nonce = await this.#miner.mine(
        { baseDigest: prepared.baseDigest, requiredBits: prepared.requiredBits },
        controller.signal,
      );
      if (controller.signal.aborted) throw new LedgerAdmissionWriterError('cancelled');

      this.#transition('sealing', { startedAt, cid: null, canCancel: true });
      const sealed = await this.#sealEntry(prepared.baseEntry, nonce, this.#scheme);
      this.#currentCid = sealed.cid;
      const record: LedgerAdmissionOutboxRecord = {
        cid: sealed.cid,
        identity: this.#identity,
        entryBytes: sealed.bytes,
        parentHashes: sealed.parentHashes,
        createdAt: this.#now(),
        byteSize: sealed.bytes.byteLength,
        state: 'sealed',
        broadcastAttempted: false,
        rejectionCode: null,
      };
      await this.#outbox.put(record);

      const prepareOwner = prepared.protectionOwner;
      const outboxOwner = `outbox:${sealed.cid}`;
      this.#protection.transfer(prepareOwner, outboxOwner);
      this.#currentPreparedOwner = null;
      this.#ownedOutboxCids.add(sealed.cid);
      if (controller.signal.aborted) {
        await this.#outbox.remove(sealed.cid);
        this.#releaseOutboxOwner(sealed.cid);
        throw new LedgerAdmissionWriterError('cancelled');
      }
      return await this.#submitRecord(record, startedAt);
    } catch (cause) {
      if (controller.signal.aborted && !this.#submissionStarted)
        throw new LedgerAdmissionWriterError('cancelled', { cause });
      throw cause;
    } finally {
      await this.#releasePrepared();
      this.#currentController = null;
      this.#currentPreparedOwner = null;
      this.#currentCid = null;
      this.#submissionStarted = false;
      this.#submissionCancelled = false;
    }
  }

  /** 在 outbox row 移除或永久終止後釋放對應 protection owner。 */
  #releaseOutboxOwner(cid: string): void {
    this.#protection.release(`outbox:${cid}`);
    this.#ownedOutboxCids.delete(cid);
    if (this.#terminalCid === cid) this.#terminalCid = null;
  }

  /** 將暫時失敗的 outbox 紀錄標記為待重試，保存原因後中止本次流程。 */
  async #markRetryPending(record: LedgerAdmissionOutboxRecord, cause: unknown): Promise<never> {
    let retryCause = cause;
    try {
      await this.#outbox.update(record.cid, {
        state: 'retry-pending',
        broadcastAttempted: true,
        rejectionCode: null,
      });
    } catch (updateFailure) {
      retryCause = new AggregateError(
        [cause, updateFailure],
        'outbox retry state persistence failed',
      );
    }
    this.#terminalCid = record.cid;
    this.#transition(this.#submissionCancelled ? 'uncertain' : 'retry-pending', {
      cid: record.cid,
      canCancel: true,
      code: causeCode(cause),
    });
    throw new LedgerAdmissionWriterError('retry-pending', { cause: retryCause });
  }

  /** 將不可恢復的 outbox 紀錄標記為永久失敗，保存診斷後中止本次流程。 */
  async #markPermanent(record: LedgerAdmissionOutboxRecord, cause: unknown): Promise<never> {
    const code = causeCode(cause) ?? 'permanent-reject';
    try {
      await this.#outbox.update(record.cid, {
        state: 'permanent-reject',
        broadcastAttempted: true,
        rejectionCode: code,
      });
    } catch (updateFailure) {
      return this.#markRetryPending(record, updateFailure);
    }
    this.#releaseOutboxOwner(record.cid);
    this.#terminalCid = record.cid;
    this.#transition('permanent-reject', {
      cid: record.cid,
      canCancel: true,
      code,
    });
    throw new LedgerAdmissionWriterError('permanent-reject', { cause });
  }

  /** 提交已準備的 outbox 紀錄，並依結果清除、重試或標記永久失敗。 */
  async #submitRecord(record: LedgerAdmissionOutboxRecord, startedAt: number): Promise<string> {
    this.#submissionStarted = true;
    try {
      await this.#outbox.update(record.cid, {
        state: 'submitting',
        broadcastAttempted: true,
        rejectionCode: null,
      });
      if (!this.#submissionCancelled)
        this.#transition('submitting', {
          startedAt,
          cid: record.cid,
          canCancel: true,
        });
      const result = await this.#database.commitPrepared(record.entryBytes, record.cid);
      if (result.hash !== record.cid) throw new Error('prepared commit returned a different CID');
      await this.#outbox.remove(record.cid);
      this.#releaseOutboxOwner(record.cid);
      this.#terminalCid = null;
      this.#transition('idle', { startedAt: null, cid: null, canCancel: false });
      return record.cid;
    } catch (cause) {
      if (isPermanentFailure(cause)) return this.#markPermanent(record, cause);
      return this.#markRetryPending(record, cause);
    }
  }

  /** 從持久 outbox 恢復未完成的 admission 工作，避免重新建立相同事件。 */
  async recover(): Promise<void> {
    if (this.#closed) throw new LedgerAdmissionWriterError('closed');
    if (this.#active || this.#recovering) throw new Error('ledger Admission writer is busy');
    this.#recovering = true;
    try {
      const records = await this.#outbox.list(this.#identity);
      const retryable: LedgerAdmissionOutboxRecord[] = [];
      const toleranceMs = Protocol.security.P2P_MESSAGE_TIMESTAMP_TOLERANCE_SEC * 1000;
      for (const record of records) {
        if (record.state === 'permanent-reject') continue;
        const validated = await validateCanonicalLedgerEntryBytes(
          record.entryBytes,
          record.cid,
          this.#scheme,
        );
        const event = validated.entry.payload.value as { timestamp?: unknown };
        if (
          !record.broadcastAttempted &&
          (typeof event?.timestamp !== 'number' ||
            !Number.isSafeInteger(event.timestamp) ||
            Math.abs(this.#now() - event.timestamp) > toleranceMs)
        ) {
          await this.#outbox.update(record.cid, {
            state: 'permanent-reject',
            broadcastAttempted: false,
            rejectionCode: 'timestamp-expired',
          });
          this.#releaseOutboxOwner(record.cid);
          this.#terminalCid = record.cid;
          this.#transition('permanent-reject', {
            startedAt: record.createdAt,
            cid: record.cid,
            canCancel: true,
            code: 'timestamp-expired',
          });
          continue;
        }
        retryable.push(record);
      }
      const missingOwners = retryable.filter((record) => !this.#ownedOutboxCids.has(record.cid));
      this.#protection.restoreOutbox(missingOwners);
      for (const record of missingOwners) this.#ownedOutboxCids.add(record.cid);
      for (const record of retryable) {
        this.#currentCid = record.cid;
        this.#submissionStarted = true;
        this.#submissionCancelled = false;
        try {
          await this.#submitRecord(record, this.#now());
        } catch (cause) {
          if (
            !(cause instanceof LedgerAdmissionWriterError) ||
            (cause.code !== 'retry-pending' && cause.code !== 'permanent-reject')
          )
            throw cause;
        } finally {
          this.#currentCid = null;
          this.#submissionStarted = false;
          this.#submissionCancelled = false;
        }
      }
    } finally {
      this.#recovering = false;
    }
  }

  /** 中止目前 admission 工作，並保留可在稍後安全重試的 outbox 狀態。 */
  async cancelCurrent(): Promise<void> {
    if (this.#terminalCid !== null) {
      const cid = this.#terminalCid;
      if (this.#activity.phase === 'permanent-reject') {
        await this.#outbox.remove(cid);
        this.#releaseOutboxOwner(cid);
        this.#terminalCid = null;
        this.#transition('idle', { startedAt: null, cid: null, canCancel: false });
      } else {
        await this.#outbox.update(cid, {
          state: 'retry-pending',
          broadcastAttempted: true,
          rejectionCode: null,
        });
        this.#transition('uncertain', { cid, canCancel: true, code: null });
      }
      return;
    }
    if (this.#currentController === null) return;
    this.#submissionCancelled = this.#submissionStarted;
    this.#currentController.abort();
    if (this.#submissionStarted && this.#currentCid !== null) {
      await this.#outbox.update(this.#currentCid, {
        state: 'retry-pending',
        broadcastAttempted: true,
        rejectionCode: null,
      });
      this.#transition('uncertain', {
        cid: this.#currentCid,
        canCancel: true,
        code: null,
      });
    }
  }

  /** 停止目前帳本或儲存元件並釋放監聽、連線與背景工作。 */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#currentController?.abort();
    while (this.#queue.length > 0)
      this.#queue.shift()!.reject(new LedgerAdmissionWriterError('closed'));
    await this.#drainPromise;
    this.#transition('idle', { startedAt: null, cid: null, canCancel: false });
    this.#observers.clear();
  }
}
