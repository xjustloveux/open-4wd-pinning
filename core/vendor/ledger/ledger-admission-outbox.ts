import { Protocol } from '@open4wd/system-constants';
import { base58btc } from 'multiformats/bases/base58';
import { CID } from 'multiformats/cid';
import {
  LEDGER_ADMISSION_V1,
  validateCanonicalLedgerEntryBytes,
  type LedgerAdmissionScheme,
} from './ledger-entry-admission';
import { SerialTaskQueue } from './serial-task-queue';

/** Durable entry 從 sealed 到提交、重試或永久拒絕的狀態。 */
export type LedgerOutboxState = 'sealed' | 'submitting' | 'retry-pending' | 'permanent-reject';

/** 可在重啟後恢復提交的完整 sealed ledger entry。 */
export interface LedgerAdmissionOutboxRecord {
  readonly cid: string;
  readonly identity: string;
  readonly entryBytes: Uint8Array;
  readonly parentHashes: readonly string[];
  readonly createdAt: number;
  readonly byteSize: number;
  readonly state: LedgerOutboxState;
  readonly broadcastAttempted: boolean;
  readonly rejectionCode: string | null;
}

/** 提交過程允許原子更新的 outbox 狀態欄位。 */
export type LedgerAdmissionOutboxPatch = Pick<
  LedgerAdmissionOutboxRecord,
  'state' | 'broadcastAttempted' | 'rejectionCode'
>;

/** Durable admission outbox 的列舉、寫入、更新與移除契約。 */
export interface LedgerAdmissionOutbox {
  list(identity: string): Promise<readonly LedgerAdmissionOutboxRecord[]>;
  put(record: LedgerAdmissionOutboxRecord): Promise<void>;
  update(cid: string, patch: LedgerAdmissionOutboxPatch): Promise<void>;
  remove(cid: string): Promise<void>;
  close(): Promise<void>;
}

const RECORD_KEYS = Object.freeze([
  'broadcastAttempted',
  'byteSize',
  'cid',
  'createdAt',
  'entryBytes',
  'identity',
  'parentHashes',
  'rejectionCode',
  'state',
]);
const STATES = new Set<LedgerOutboxState>([
  'sealed',
  'submitting',
  'retry-pending',
  'permanent-reject',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === RECORD_KEYS.length && keys.every((key, index) => key === RECORD_KEYS[index])
  );
}

function isCanonicalEntryCid(value: string): boolean {
  try {
    return CID.parse(value, base58btc).toString(base58btc) === value;
  } catch {
    return false;
  }
}

/** 驗證 outbox key 是 canonical base58btc entry CID。 */
export function assertLedgerAdmissionOutboxCid(value: string): void {
  if (!isCanonicalEntryCid(value)) throw new Error('invalid ledger Admission outbox CID');
}

/** 深拷 entry bytes 與 parent hashes，隔離 caller mutation。 */
export function cloneLedgerAdmissionOutboxRecord(
  record: LedgerAdmissionOutboxRecord,
): LedgerAdmissionOutboxRecord {
  return {
    ...record,
    entryBytes: Uint8Array.from(record.entryBytes),
    parentHashes: [...record.parentHashes],
  };
}

/** 每次 ingress 與 reload 都驗證持久資料；損壞 row 絕不修復或丟棄。 */
export async function validateLedgerAdmissionOutboxRecord(
  value: unknown,
  scheme: LedgerAdmissionScheme = LEDGER_ADMISSION_V1,
): Promise<LedgerAdmissionOutboxRecord> {
  if (!isRecord(value) || !exactKeys(value))
    throw new Error('invalid ledger Admission outbox record shape');
  const state = value['state'];
  const rejectionCode = value['rejectionCode'];
  if (
    typeof value['cid'] !== 'string' ||
    typeof value['identity'] !== 'string' ||
    value['identity'].length === 0 ||
    !(value['entryBytes'] instanceof Uint8Array) ||
    !Array.isArray(value['parentHashes']) ||
    !value['parentHashes'].every((hash) => typeof hash === 'string' && isCanonicalEntryCid(hash)) ||
    new Set(value['parentHashes']).size !== value['parentHashes'].length ||
    !Number.isSafeInteger(value['createdAt']) ||
    (value['createdAt'] as number) < 0 ||
    !Number.isSafeInteger(value['byteSize']) ||
    value['byteSize'] !== value['entryBytes'].byteLength ||
    typeof state !== 'string' ||
    !STATES.has(state as LedgerOutboxState) ||
    typeof value['broadcastAttempted'] !== 'boolean' ||
    (rejectionCode !== null && (typeof rejectionCode !== 'string' || rejectionCode.length === 0))
  )
    throw new Error('invalid ledger Admission outbox record fields');

  const validated = await validateCanonicalLedgerEntryBytes(
    value['entryBytes'],
    value['cid'],
    scheme,
  );
  if (validated.entry.identity !== value['identity'])
    throw new Error('ledger Admission outbox identity mismatch');
  const parentHashes = value['parentHashes'] as string[];
  if (
    validated.parentHashes.length !== parentHashes.length ||
    !validated.parentHashes.every((hash, index) => hash === parentHashes[index])
  )
    throw new Error('ledger Admission outbox parent mismatch');
  return cloneLedgerAdmissionOutboxRecord(value as unknown as LedgerAdmissionOutboxRecord);
}

/** 測試使用、仍完整驗證 wire 與序列化 mutation 的記憶體 outbox。 */
export class MemoryLedgerAdmissionOutbox implements LedgerAdmissionOutbox {
  /** CID 至 immutable outbox record 的記憶體表。 */
  readonly #records = new Map<string, LedgerAdmissionOutboxRecord>();
  /** 每次 ingress/reload 驗證使用的 admission scheme。 */
  readonly #scheme: LedgerAdmissionScheme;
  /** 序列化 mutations 並在 close 後阻止新操作。 */
  readonly #queue = new SerialTaskQueue('ledger Admission outbox is closed');

  constructor(scheme: LedgerAdmissionScheme = LEDGER_ADMISSION_V1) {
    this.#scheme = scheme;
  }

  /** 列出指定身分尚未完成的 admission outbox 紀錄，供啟動恢復流程使用。 */
  list(identity: string): Promise<readonly LedgerAdmissionOutboxRecord[]> {
    return this.#queue.enqueue(async () => {
      if (typeof identity !== 'string' || identity.length === 0)
        throw new Error('invalid ledger Admission outbox identity');
      const validated = await Promise.all(
        [...this.#records.values()].map((record) =>
          validateLedgerAdmissionOutboxRecord(record, this.#scheme),
        ),
      );
      return validated
        .filter((record) => record.identity === identity)
        .sort(
          (left, right) => left.createdAt - right.createdAt || left.cid.localeCompare(right.cid),
        );
    });
  }

  /** 新增或覆寫 admission outbox 紀錄，使未完成工作可在重新啟動後恢復。 */
  put(record: LedgerAdmissionOutboxRecord): Promise<void> {
    return this.#queue.enqueue(async () => {
      const validated = await validateLedgerAdmissionOutboxRecord(record, this.#scheme);
      const records = await Promise.all(
        [...this.#records.values()].map((value) =>
          validateLedgerAdmissionOutboxRecord(value, this.#scheme),
        ),
      );
      const existing = records.find((value) => value.cid === validated.cid);
      const nextCount = records.length + (existing === undefined ? 1 : 0);
      const nextBytes =
        records.reduce((sum, value) => sum + value.byteSize, 0) -
        (existing?.byteSize ?? 0) +
        validated.byteSize;
      if (nextCount > Protocol.ledger.LEDGER_ADMISSION_OUTBOX_MAX_ENTRIES)
        throw new Error('outbox entry quota exceeded');
      if (nextBytes > Protocol.ledger.LEDGER_ADMISSION_OUTBOX_MAX_BYTES)
        throw new Error('outbox byte quota exceeded');
      this.#records.set(validated.cid, cloneLedgerAdmissionOutboxRecord(validated));
    });
  }

  /** 原子更新指定 outbox 紀錄的狀態與重試資訊，保留其他欄位。 */
  update(cid: string, patch: LedgerAdmissionOutboxPatch): Promise<void> {
    return this.#queue.enqueue(async () => {
      assertLedgerAdmissionOutboxCid(cid);
      const existing = this.#records.get(cid);
      if (existing === undefined) throw new Error('ledger Admission outbox record not found');
      const updated = await validateLedgerAdmissionOutboxRecord(
        { ...existing, ...patch },
        this.#scheme,
      );
      this.#records.set(cid, updated);
    });
  }

  /** 移除已完成或永久失敗的 admission outbox 紀錄。 */
  remove(cid: string): Promise<void> {
    return this.#queue.enqueue(async () => {
      assertLedgerAdmissionOutboxCid(cid);
      const existing = this.#records.get(cid);
      if (existing !== undefined) await validateLedgerAdmissionOutboxRecord(existing, this.#scheme);
      this.#records.delete(cid);
    });
  }

  /** 停止目前帳本或儲存元件並釋放監聽、連線與背景工作。 */
  async close(): Promise<void> {
    await this.#queue.close();
  }
}
