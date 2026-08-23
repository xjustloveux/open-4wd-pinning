/**
 * OrbitDB 事件鏈適配層。entry 使用 traversal + block quota、remote sync 在 decode 前
 * 限制 raw head，Events join 以 checkpoint boundary 截斷並 staged commit；heads/index
 * 使用 protected LRU。custom `open4wd-ledger` access-controller 在 persistence 前驗
 * Orbit identity 與 deterministic event admission，live 時效／業務共識仍由收件與 fold
 * 守門。排序契約：all()＝舊→新、iterator()＝新→舊，entriesAfter 反轉供 replay。
 */
import {
  ComposedStorage,
  createOrbitDB,
  Entry,
  Identities,
  KeyStore,
  LevelStorage,
  LRUStorage,
  type OrbitDBInstance,
  type OrbitEventsDb,
  type OrbitIdentities,
  type OrbitKeyStore,
  type OrbitLogEntry,
  type OrbitStorage,
} from '@orbitdb/core';
import { base58btc } from 'multiformats/bases/base58';
import { CID as MultiformatsCID } from 'multiformats/cid';
import type { CID, LedgerAdmissionActivity, Unsubscribe } from '@open4wd/interfaces';
import { createDeadlineSignal } from '../deadline-signal';
import {
  LEDGER_CONTENT_BLOCK_MAX_BYTES,
  cidMatchesBytes,
  cidOfDagCborBytes,
  cidOfRawBytes,
} from './content-cid';
import {
  ensureOpen4wdLedgerAccessControllerRegistered,
  OPEN4WD_LEDGER_ACCESS_TYPE,
  Open4wdLedgerAccessController,
} from './ledger-access-controller';
import { BoundedEventsDatabase } from './bounded-events-database';
import {
  canonicalEntryHash,
  createBoundedLedgerBlockstore,
  createLocalEntryStorage,
  protectedLruStorage,
  TraversalBudgetStorage,
} from './bounded-storage';
import { LedgerEntryProtectionRegistry } from './ledger-entry-protection';
import {
  LEDGER_ADMISSION_V1,
  validateCanonicalLedgerEntryBytes,
  type LedgerAdmissionScheme,
} from './ledger-entry-admission';
import type { LedgerAdmissionOutbox } from './ledger-admission-outbox';
import type { AdmissionMiner } from './ledger-admission-miner';
import { LedgerAdmissionWriter } from './ledger-admission-writer';

/** 起始值（客戶端儲存調參、非共識；發版後依 storage estimate 動態調） */
export const LRU_ENTRY_LIMIT = 10000;

/**
 * 面向 OrbitDB 的單一線上 Ledger generation Helia surface。內容 block 與 pin 狀態可由
 * shell 生命週期權威儲存支持，而 Orbit entry blockstore 一律由此 generation 擁有。
 * {@link stop} 會停止網路資源與自有 entry store，但絕不開啟或關閉借用的權威儲存。
 */
export interface LedgerIpfs {
  /** 內容定址 block surface，可能由非自有權威 adapter 支持。 */
  blockstore: {
    put(cid: unknown, bytes: Uint8Array, options?: unknown): Promise<unknown>;
    get(cid: unknown, options?: { signal?: AbortSignal }): unknown;
    delete?(cid: unknown, options?: unknown): Promise<unknown>;
  };
  /**
   * generation 自有的本機 Orbit entry store；絕非 Helia／Bitswap broker 或共用內容 store，
   * 且由 generation 生命週期精確關閉一次。
   */
  entryBlockstore: {
    put(cid: unknown, bytes: Uint8Array, options?: unknown): Promise<unknown>;
    get(cid: unknown, options?: { signal?: AbortSignal }): unknown;
    has(cid: unknown, options?: unknown): Promise<boolean>;
    delete(cid: unknown, options?: unknown): Promise<unknown>;
    getAll():
      AsyncIterable<{ cid: unknown; bytes: unknown }> | Iterable<{ cid: unknown; bytes: unknown }>;
  };
  pins: {
    add(cid: unknown, options?: unknown): AsyncIterable<unknown>;
    isPinned(cid: unknown, options?: unknown): Promise<boolean>;
  };
  /** OrbitDB 使用且由 generation 擁有的網路 surface。 */
  libp2p: { peerId: unknown; services: Record<string, unknown> };
  /**
   * 停止 generation 自有網路與 entry-store 資源，且不關閉借用的內容 blockstore
   * 或 datastore 權威。
   *
   * @returns generation 清理後 settled 的 promise。
   * @throws 第一個網路或自有 entry-store 清理失敗。
   */
  stop?(): Promise<void>;
}

/** Ledger fold 可消費的 Orbit entry 最小形。 */
export interface LogEntry {
  hash: string;
  value: unknown;
  /** Ledger consensus Lamport clock；full-DAG fold 不可退化成到達順序。 */
  clock: { id: string; time: number };
  /** 因果 parents；live incremental 用來維護已 fold frontier。 */
  next?: readonly string[];
}

/** 選取 active head 所需的 hash 與 Lamport clock。 */
export interface DeterministicLogHead {
  hash: string;
  clock: { id?: string; time: number };
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index++) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function compareEntryCidBytes(left: string, right: string): number {
  return compareBytes(
    MultiformatsCID.parse(canonicalEntryHash(left), base58btc).bytes,
    MultiformatsCID.parse(canonicalEntryHash(right), base58btc).bytes,
  );
}

/**
 * Ledger consensus full-DAG total order。正常 clock 與 OrbitDB LWW 一致；惡意或
 * crash-replayed same-identity/same-time fork 再以 entry CID bytes 穩定化，避免到達序分歧。
 */
export function canonicalLedgerEntryOrder(left: LogEntry, right: LogEntry): number {
  const time = left.clock.time - right.clock.time;
  if (time !== 0) return time;
  if (left.clock.id !== right.clock.id) return left.clock.id < right.clock.id ? -1 : 1;
  return compareEntryCidBytes(left.hash, right.hash);
}

/** checkpoint head-set 的 canonical serialization（與 reducer LWW 排序刻意分離）。 */
export function canonicalizeLedgerHeadCids(heads: readonly string[]): string[] {
  if (heads.length === 0) throw new RangeError('ledger head set must be non-empty');
  if (heads.length > 64) throw new RangeError('ledger head set exceeds 64');
  const canonical = heads.map(canonicalEntryHash);
  if (new Set(canonical).size !== canonical.length)
    throw new Error('ledger head set must be unique');
  return canonical.sort(compareEntryCidBytes);
}

/** 多 head active view：clock 最大；平手取 hash 字典序最小，輸入順序完全不影響。 */
export function selectDeterministicLogHead<T extends DeterministicLogHead>(
  heads: readonly T[],
): T | null {
  let selected: T | null = null;
  for (const candidate of heads) {
    if (
      selected === null ||
      candidate.clock.time > selected.clock.time ||
      (candidate.clock.time === selected.clock.time && candidate.hash < selected.hash)
    )
      selected = candidate;
  }
  return selected;
}

/** 事件鏈埠——LedgerApi 依此消費（OrbitDB 適配之外測試可注入記憶體實作） */
export interface EventLogStore {
  readonly address: string;
  /** 寫入一筆、回條目 hash（＝EventId） */
  add(value: unknown): Promise<string>;
  /** 全量、舊→新（OrbitDB 決定性線性化＝跨 peer 同序） */
  all(): Promise<LogEntry[]>;
  /** 完整 frontier，CID bytes canonical order。 */
  heads(): Promise<string[]>;
  /** Reach(untilHeads) \\ Reach(afterHeads)，依 ledger consensus total order 舊→新。 */
  entriesBetween(afterHeads: readonly string[], untilHeads: readonly string[]): Promise<LogEntry[]>;
  /** (afterHash, untilHash] 區段、舊→新；兩參數皆可省 */
  entriesAfter(afterHash?: string, untilHash?: string): Promise<LogEntry[]>;
  /** 決定性單一 head（多 head 併發時取 clock 最大、hash 字典序最小） */
  head(): Promise<string | null>;
  onUpdate(handler: (entry: LogEntry) => void): Unsubscribe;
  /** Admission 工作狀態；記憶體／測試埠可省略。 */
  onAdmissionActivity?(handler: (activity: LedgerAdmissionActivity) => void): Unsubscribe;
  /** 取消 prepare/mine，或在 submitting 後停止本機 exact retry。 */
  cancelAdmissionWork?(): Promise<void>;
  /** read-only 驗證新 boundary，回傳不含 await、不可失敗的 in-memory commit。 */
  prepareCheckpointBoundary?(heads: readonly string[]): Promise<{
    /** synchronous in-memory commit；不得 await。 */
    commit(): void;
    /** setLatest 失敗時同步還原舊 boundary/coverage。 */
    rollback(): void;
  }>;
  /** finalized checkpoint 持久化成功後推進本機 storage eviction boundary。 */
  advanceCheckpointBoundary?(heads: readonly string[]): Promise<void>;
  /** 真 Orbit runtime 的完整 teardown；測試埠可省略而只實作 close。 */
  stop?(): Promise<void>;
  close(): Promise<void>;
}

/** Current frontier 無法完整延續 previous frontier 時的重折疊訊號。 */
export class LedgerFrontierContinuityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerFrontierContinuityError';
  }
}

/**
 * Orbit adapter 與確定性 DAG fixture 共用的 production frontier traversal。
 * 每個目前 head 都必須獨立到達前一 frontier，且每個前一 head 都必須持續受到涵蓋；
 * 因此 `[A] -> [A,B]` 這類 sibling 成長不符合增量連續性，必須從 checkpoint／genesis
 * 邊界執行完整 DAG refold。
 */
export async function collectLedgerEntriesBetween(
  afterHeads: readonly string[],
  untilHeads: readonly string[],
  getEntry: (hash: string) => Promise<LogEntry | undefined>,
): Promise<LogEntry[]> {
  const previous = afterHeads.length === 0 ? [] : canonicalizeLedgerHeadCids(afterHeads);
  const current = canonicalizeLedgerHeadCids(untilHeads);
  const previousSet = new Set(previous);
  const reachedPrevious = new Set<string>();
  const collected = new Map<string, LogEntry>();

  for (const start of current) {
    const pending = [start];
    const visited = new Set<string>();
    let reachedFromCurrent = previous.length === 0;
    while (pending.length > 0) {
      const hash = canonicalEntryHash(pending.pop()!);
      if (previousSet.has(hash)) {
        reachedPrevious.add(hash);
        reachedFromCurrent = true;
        continue;
      }
      if (visited.has(hash)) continue;
      if (collected.size >= LRU_ENTRY_LIMIT)
        throw new RangeError('ledger frontier traversal exceeds local limit');
      const entry = await getEntry(hash);
      if (entry === undefined) throw new Error('ledger frontier entry is unavailable');
      if (canonicalEntryHash(entry.hash) !== hash)
        throw new Error('ledger frontier lookup returned a different entry CID');
      visited.add(hash);
      collected.set(hash, entry);
      for (const parent of entry.next ?? []) pending.push(parent);
    }
    if (!reachedFromCurrent)
      throw new LedgerFrontierContinuityError(
        'current ledger head does not reach the previous frontier',
      );
  }
  if (previous.some((head) => !reachedPrevious.has(head)))
    throw new LedgerFrontierContinuityError(
      'previous ledger frontier contains an uncovered branch',
    );
  return [...collected.values()].sort(canonicalLedgerEntryOrder);
}

/** 開啟正式 Orbit event log 的網路、storage、checkpoint 與 admission 選項。 */
export interface OpenOrbitEventLogOptions {
  ipfs: LedgerIpfs;
  /** 既有 exact `/orbitdb/<CIDv1-base58btc>` 位址或明確 genesis 用新庫名。 */
  addressOrName?: string;
  /** 單機（測試）可關同步；預設 true */
  sync?: boolean;
  /** OrbitDB 身分金鑰儲存（測試注入 MemoryStorage；預設落 directory 下 level） */
  keystoreStorage?: OrbitStorage;
  directory?: string;
  /** 覆寫 entry 儲存（預設＝LRU＋專屬本機 bounded entry blockstore） */
  entryStorage?: OrbitStorage;
  headsStorage?: OrbitStorage;
  /** 注意：Node 測試務必注入 MemoryStorage——預設 level 會在 CWD 落盤（瀏覽器＝IDB 無此事） */
  indexStorage?: OrbitStorage;
  accessControllerStorage?: OrbitStorage;
  /** join rollback poison marker；production 預設 Level/IDB。 */
  integrityStorage?: OrbitStorage;
  /** 最新 finalized checkpoint 的完整 frontier；用來 seed index 並截斷 next/refs traversal。 */
  checkpointBoundary?: () => Promise<readonly string[] | null>;
  /** prepare／outbox parent protection；省略時建立此 log 專用 registry。 */
  entryProtection?: LedgerEntryProtectionRegistry;
  /** Runtime composition 注入的 PeerId parser；ledger 核心不直接依賴 libp2p identity 實作。 */
  peerTargetFromString?: (peer: string) => unknown | Promise<unknown>;
  /** Durable final-entry outbox 與 Worker miner；正式 Orbit log 不允許裸 append。 */
  admission: {
    readonly outbox: LedgerAdmissionOutbox;
    readonly miner: AdmissionMiner;
    /** Unit/integration-test seam；production 省略並固定 Admission v1。 */
    readonly scheme?: LedgerAdmissionScheme;
  };
}

const DEFAULT_DB_NAME = 'open4wd-ledger';

/**
 * 驗證正式 OrbitDB address 的 exact wire shape：`/orbitdb/<CIDv1-base58btc>`。
 *
 * @param value 不可信部署值。
 * @returns 合法時回 canonical address，否則 null。
 */
export function exactOrbitDbAddress(value: string): string | null {
  const match = /^\/orbitdb\/([^/]+)$/.exec(value);
  if (match === null || !match[1]!.startsWith('z')) return null;
  try {
    const cid = MultiformatsCID.parse(match[1]!, base58btc);
    return cid.version === 1 && cid.toString(base58btc) === match[1] ? value : null;
  } catch {
    return null;
  }
}

/** 能完整停止 OrbitDB owned resources 的 production event log。 */
export interface OrbitEventLog extends EventLogStore {
  /** 連帶停掉 OrbitDB 實例（keystore 等）；不停 ipfs（呼叫端所有） */
  stop(): Promise<void>;
}

/** 開啟或加入 bounded、admission-protected 的 Orbit ledger event log。 */
export async function openOrbitEventLog(options: OpenOrbitEventLogOptions): Promise<OrbitEventLog> {
  const { ipfs } = options;
  const requested = options.addressOrName;
  const requestedExact = requested === undefined ? null : exactOrbitDbAddress(requested);
  if (requested?.startsWith('/orbitdb/') && requestedExact === null)
    throw new RangeError('LEDGER_DB_ADDRESS must be an exact OrbitDB address');
  let keystore: OrbitKeyStore | undefined;
  let identities: OrbitIdentities | undefined;
  let orbitdb: OrbitDBInstance | undefined;
  let orbitdbKeystore: OrbitKeyStore | undefined;
  let entryStorage: OrbitStorage | undefined;
  let headsStorage: OrbitStorage | undefined;
  let indexStorage: OrbitStorage | undefined;
  let integrityStorage: OrbitStorage | undefined;
  let db: OrbitEventsDb | undefined;
  let writer: LedgerAdmissionWriter | undefined;
  const admissionScheme = options.admission.scheme ?? LEDGER_ADMISSION_V1;
  let ledgerAddressForAdmission = requestedExact;
  const currentLedgerAddress = (): string | null => ledgerAddressForAdmission;
  const initialCheckpointBoundary = (await options.checkpointBoundary?.()) ?? null;
  let checkpointBoundary =
    initialCheckpointBoundary === null
      ? null
      : canonicalizeLedgerHeadCids(initialCheckpointBoundary);
  const checkpointCovered = new Set<string>();
  const entryProtection = options.entryProtection ?? new LedgerEntryProtectionRegistry();
  const rebuildDefaultRuntimeMetadata =
    options.entryStorage === undefined &&
    options.headsStorage === undefined &&
    options.indexStorage === undefined;
  const deferSynchronizationStart = options.sync ?? true;
  let auxiliaryStorageClosed = false;
  const closeAuxiliaryStorage = async (): Promise<void> => {
    if (
      auxiliaryStorageClosed ||
      integrityStorage === undefined ||
      integrityStorage === indexStorage
    )
      return;
    auxiliaryStorageClosed = true;
    await integrityStorage.close?.();
  };
  try {
    if (options.keystoreStorage !== undefined) {
      keystore = await KeyStore({ storage: options.keystoreStorage });
      identities = await Identities({ keystore, ipfs });
    }
    orbitdb = await createOrbitDB({
      ipfs,
      identities,
      directory: options.directory ?? 'open4wd/orbitdb',
    });
    orbitdbKeystore = (orbitdb as unknown as { keystore?: OrbitKeyStore }).keystore ?? keystore;
    const orbitIdentity = orbitdb.identity as { hash?: unknown };
    if (typeof orbitIdentity.hash !== 'string' || orbitIdentity.hash.length === 0)
      throw new Error('Orbit identity hash is unavailable for Admission outbox');
    const restoredOutbox = await options.admission.outbox.list(orbitIdentity.hash);
    const restorableOutbox = restoredOutbox.filter((record) => record.state !== 'permanent-reject');
    entryProtection.restoreOutbox(restorableOutbox);
    let rawEntryStorage: OrbitStorage;
    if (options.entryStorage !== undefined) rawEntryStorage = options.entryStorage;
    else {
      const primary = await LRUStorage({ size: LRU_ENTRY_LIMIT });
      let fallback: OrbitStorage | undefined;
      try {
        const boundedEntries = await createBoundedLedgerBlockstore(
          ipfs.entryBlockstore,
          (hash) =>
            (checkpointBoundary?.includes(hash) ?? false) || entryProtection.isProtected(hash),
          Date.now,
          (hash) => checkpointCovered.has(hash),
          requestedExact !== null,
        );
        fallback = createLocalEntryStorage(boundedEntries);
        rawEntryStorage = await ComposedStorage(primary, fallback);
      } catch (error) {
        try {
          await fallback?.close?.();
        } catch {
          /* preserve construction failure */
        }
        try {
          await primary.close?.();
        } catch {
          /* preserve construction failure */
        }
        throw error;
      }
    }
    entryStorage = new TraversalBudgetStorage(rawEntryStorage);
    headsStorage = options.headsStorage ?? protectedLruStorage(64);
    indexStorage =
      options.indexStorage ??
      protectedLruStorage(
        LRU_ENTRY_LIMIT,
        (key) => (checkpointBoundary?.includes(key) ?? false) || entryProtection.isProtected(key),
      );
    integrityStorage =
      options.integrityStorage ??
      options.indexStorage ??
      (await LevelStorage({ path: `${options.directory ?? 'open4wd/orbitdb'}/entry-integrity` }));
    ensureOpen4wdLedgerAccessControllerRegistered(ipfs, admissionScheme, currentLedgerAddress);
    db = await orbitdb.open(options.addressOrName ?? DEFAULT_DB_NAME, {
      type: 'events',
      sync: options.sync ?? true,
      entryStorage,
      headsStorage,
      indexStorage,
      Database: BoundedEventsDatabase({
        entryStorage: entryStorage as TraversalBudgetStorage,
        checkpointBoundary: () => checkpointBoundary,
        integrityStorage,
        entryProtection,
        admissionScheme,
        ledgerAddress: currentLedgerAddress,
        deferSynchronizationStart,
        peerTargetFromString: options.peerTargetFromString,
      }),
      AccessController: Open4wdLedgerAccessController({
        storage: options.accessControllerStorage,
        admissionScheme,
        ledgerAddress: currentLedgerAddress,
      }),
    });
    ledgerAddressForAdmission = db.address;
    if (
      requestedExact !== null &&
      (db.address !== requestedExact ||
        db.name !== DEFAULT_DB_NAME ||
        db.type !== 'events' ||
        db.access.type !== OPEN4WD_LEDGER_ACCESS_TYPE ||
        db.access.write?.length !== 1 ||
        db.access.write[0] !== '*')
    ) {
      try {
        await db.close();
      } catch {
        /* orbitdb.stop below still gets a chance */
      }
      throw new Error('OrbitDB runtime contract mismatch');
    }
    if (rebuildDefaultRuntimeMetadata) {
      if (
        entryStorage.iterator === undefined ||
        indexStorage.clear === undefined ||
        headsStorage.clear === undefined
      )
        throw new Error('ledger runtime metadata rebuild requires enumerable storages');
      type RebuildEntry = OrbitLogEntry & { id: string; refs: string[] };
      const verifiedEntries = new Map<string, RebuildEntry>();
      for await (const [rawHash, bytes] of entryStorage.iterator()) {
        if (verifiedEntries.size >= LRU_ENTRY_LIMIT)
          throw new RangeError('ledger runtime metadata rebuild exceeds local limit');
        const hash = canonicalEntryHash(rawHash);
        let validated;
        try {
          validated = await validateCanonicalLedgerEntryBytes(bytes, hash, admissionScheme);
        } catch (cause) {
          throw new Error('ledger runtime metadata entry is corrupt during restart', { cause });
        }
        const entry = validated.entry as unknown as RebuildEntry;
        if (entry.hash !== hash || entry.id !== db.address)
          throw new Error('ledger runtime metadata entry CID/address mismatch');
        if (db.access.canAppend === undefined || !(await db.access.canAppend(entry)))
          throw new Error('ledger runtime metadata entry access verification failed');
        if (!(await Entry.verify(orbitdb.identity, entry)))
          throw new Error('ledger runtime metadata entry signature verification failed');
        verifiedEntries.set(hash, entry);
      }
      const selected = new Set<string>();
      if (checkpointBoundary === null) {
        for (const hash of verifiedEntries.keys()) selected.add(hash);
      } else {
        const boundaries = checkpointBoundary.map(canonicalEntryHash);
        if (boundaries.some((boundary) => !verifiedEntries.has(boundary)))
          throw new Error('checkpoint frontier is unavailable during metadata rebuild');
        const children = new Map<string, string[]>();
        for (const [hash, entry] of verifiedEntries)
          for (const parent of entry.next) {
            const values = children.get(parent) ?? [];
            values.push(hash);
            children.set(parent, values);
          }
        const pending = [...boundaries];
        while (pending.length > 0) {
          const hash = pending.pop()!;
          if (selected.has(hash)) continue;
          selected.add(hash);
          for (const child of children.get(hash) ?? []) pending.push(child);
        }
      }
      const referenced = new Set<string>();
      for (const hash of selected)
        for (const parent of verifiedEntries.get(hash)!.next)
          if (selected.has(parent)) referenced.add(parent);
      const rebuiltHeads = [...selected]
        .filter((hash) => !referenced.has(hash))
        .sort()
        .map((hash) => ({ hash, next: verifiedEntries.get(hash)!.next }));
      if (rebuiltHeads.length > 64) throw new RangeError('ledger rebuilt head count exceeds limit');
      const rebuiltHeadsBytes = new TextEncoder().encode(JSON.stringify(rebuiltHeads));
      if (rebuiltHeadsBytes.byteLength > 65_536)
        throw new RangeError('ledger rebuilt heads metadata exceeds byte limit');
      await indexStorage.clear();
      await headsStorage.clear();
      for (const hash of selected) await indexStorage.put(hash, new Uint8Array([1]));
      if (rebuiltHeads.length > 0) await headsStorage.put('heads', rebuiltHeadsBytes);
    }
    if (checkpointBoundary !== null) {
      checkpointBoundary = canonicalizeLedgerHeadCids(checkpointBoundary);
      const boundaryEntries: (OrbitLogEntry | undefined)[] = [];
      for (const boundary of checkpointBoundary) boundaryEntries.push(await db.log.get(boundary));
      if (boundaryEntries.some((entry) => entry === undefined))
        throw new Error('checkpoint frontier is unavailable');
      const pending = boundaryEntries.flatMap((entry) => entry!.next);
      const visited = new Set<string>();
      while (pending.length > 0) {
        const hash = canonicalEntryHash(pending.pop()!);
        if (visited.has(hash)) continue;
        if (visited.size >= LRU_ENTRY_LIMIT)
          throw new RangeError('checkpoint coverage restoration exceeds local limit');
        const bytes = await entryStorage.get(hash);
        if (bytes === undefined) {
          // 缺塊可能是已安全淘汰；但專屬 store 仍宣稱存在卻無法 decode 代表
          // checksum/version/bytes 損壞，不能誤當 evicted 而授予 coverage 淘汰權。
          if (await ipfs.entryBlockstore.has(MultiformatsCID.parse(hash, base58btc)))
            throw new Error('checkpoint-covered entry is corrupt during restart');
          continue;
        }
        let validated;
        try {
          validated = await validateCanonicalLedgerEntryBytes(bytes, hash, admissionScheme);
        } catch (cause) {
          throw new Error('checkpoint-covered entry is corrupt during restart', { cause });
        }
        const entry = validated.entry as unknown as OrbitLogEntry;
        if (
          entry.hash !== hash ||
          !(await db.access.canAppend?.(entry)) ||
          !(await Entry.verify(orbitdb.identity, entry))
        )
          throw new Error('checkpoint-covered entry verification failed during restart');
        visited.add(hash);
        checkpointCovered.add(hash);
        for (const parent of entry.next) pending.push(parent);
      }
    }
    writer = new LedgerAdmissionWriter({
      identity: orbitIdentity.hash,
      database: db,
      outbox: options.admission.outbox,
      miner: options.admission.miner,
      protection: entryProtection,
      admissionScheme,
      restoredOutboxCids: restorableOutbox.map(({ cid }) => cid),
    });
    await writer.recover();
    if (deferSynchronizationStart) {
      const start = (
        db as OrbitEventsDb & {
          startBoundedSynchronization?: () => Promise<void>;
        }
      ).startBoundedSynchronization;
      if (start === undefined)
        throw new Error('bounded database does not expose deferred synchronization start');
      await start();
    }
  } catch (error) {
    try {
      await writer?.close();
    } catch {
      /* preserve open failure */
    }
    if (orbitdb !== undefined) {
      try {
        await orbitdb.stop();
      } catch {
        try {
          await orbitdbKeystore?.close();
        } catch {
          /* preserve open failure */
        }
      }
    } else {
      try {
        await keystore?.close();
      } catch {
        /* preserve open failure */
      }
    }
    const storages = [
      entryStorage,
      headsStorage,
      indexStorage,
      options.accessControllerStorage,
      integrityStorage,
    ];
    const closed = new Set<OrbitStorage>();
    for (const storage of storages) {
      if (storage === undefined || closed.has(storage)) continue;
      closed.add(storage);
      try {
        await storage.close?.();
      } catch {
        /* preserve open failure */
      }
    }
    try {
      await options.admission.outbox.close();
    } catch {
      /* preserve open failure */
    }
    throw error;
  }

  const asLogEntry = (entry: OrbitLogEntry): LogEntry => ({
    hash: canonicalEntryHash(entry.hash),
    value: entry.payload.value,
    clock: { id: entry.clock.id, time: entry.clock.time },
    next: entry.next.map(canonicalEntryHash),
  });

  const heads = async (): Promise<string[]> => {
    const current = await db.log.heads();
    return current.length === 0
      ? []
      : canonicalizeLedgerHeadCids(current.map((entry) => entry.hash));
  };

  const entriesBetween = async (
    afterHeads: readonly string[],
    untilHeads: readonly string[],
  ): Promise<LogEntry[]> =>
    collectLedgerEntriesBetween(afterHeads, untilHeads, async (hash) => {
      const entry = await db.log.get(hash);
      return entry === undefined ? undefined : asLogEntry(entry);
    });

  const entriesAfter = async (afterHash?: string, untilHash?: string): Promise<LogEntry[]> => {
    const current = untilHash === undefined ? await heads() : [untilHash];
    if (current.length === 0) return [];
    return entriesBetween(afterHash === undefined ? [] : [afterHash], current);
  };

  const head = async (): Promise<string | null> => {
    const heads = await db.log.heads();
    return selectDeterministicLogHead(heads)?.hash ?? null;
  };

  const onUpdate = (handler: (entry: LogEntry) => void): Unsubscribe => {
    const listener = (entry: OrbitLogEntry): void => {
      handler(asLogEntry(entry));
    };
    db.events.on('update', listener);
    return () => void db.events.off('update', listener);
  };

  const prepareCheckpointBoundary = async (
    nextHeads: readonly string[],
  ): Promise<{ commit(): void; rollback(): void }> => {
    const nextBoundary = canonicalizeLedgerHeadCids(nextHeads);
    if (
      checkpointBoundary !== null &&
      nextBoundary.length === checkpointBoundary.length &&
      nextBoundary.every((head, index) => head === checkpointBoundary![index])
    )
      return { commit: () => undefined, rollback: () => undefined };
    const previous = checkpointBoundary;
    const previousSet = new Set(previous ?? []);
    const reachedPrevious = new Set<string>();
    const previousCovered = new Set(checkpointCovered);
    const visited = new Set<string>();
    for (const start of nextBoundary) {
      const pending = [start];
      const branchVisited = new Set<string>();
      let branchReachedPrevious = previous === null;
      while (pending.length > 0) {
        const current = canonicalEntryHash(pending.pop()!);
        if (previousSet.has(current)) {
          reachedPrevious.add(current);
          branchReachedPrevious = true;
          continue;
        }
        if (branchVisited.has(current)) continue;
        if (visited.size >= LRU_ENTRY_LIMIT)
          throw new RangeError('checkpoint frontier traversal exceeds local ledger limit');
        let entry;
        try {
          entry = await db.log.get(current);
        } catch {
          throw new Error('checkpoint frontier is not in the verified local log');
        }
        if (entry === undefined)
          throw new Error('checkpoint frontier is not in the verified local log');
        if (canonicalEntryHash(entry.hash) !== current)
          throw new Error('checkpoint frontier lookup returned a different entry CID');
        branchVisited.add(current);
        visited.add(current);
        for (const parent of entry.next) pending.push(parent);
      }
      if (!branchReachedPrevious)
        throw new Error('current checkpoint head does not reach the previous frontier');
    }
    if (previous?.some((head) => !reachedPrevious.has(head)))
      throw new Error('previous checkpoint frontier contains an uncovered branch');
    const nextCovered = new Set(checkpointCovered);
    for (const head of previous ?? []) nextCovered.add(head);
    const nextHeadSet = new Set(nextBoundary);
    for (const covered of visited) if (!nextHeadSet.has(covered)) nextCovered.add(covered);
    // 所有非同步驗證完成後才原子替換可淘汰集合／boundary；失敗維持舊狀態。
    let committed = false;
    return {
      commit: () => {
        checkpointCovered.clear();
        for (const covered of nextCovered) checkpointCovered.add(covered);
        checkpointBoundary = nextBoundary;
        committed = true;
      },
      rollback: () => {
        if (!committed) return;
        checkpointCovered.clear();
        for (const covered of previousCovered) checkpointCovered.add(covered);
        checkpointBoundary = previous;
        committed = false;
      },
    };
  };
  const advanceCheckpointBoundary = async (heads: readonly string[]): Promise<void> => {
    const prepared = await prepareCheckpointBoundary(heads);
    prepared.commit();
  };

  return {
    address: db.address,
    add: (value) => writer.add(value),
    all: async () => {
      const current = await heads();
      return current.length === 0 ? [] : entriesBetween([], current);
    },
    heads,
    entriesBetween,
    entriesAfter,
    head,
    onUpdate,
    onAdmissionActivity: (handler) => writer.subscribe(handler),
    cancelAdmissionWork: () => writer.cancelCurrent(),
    prepareCheckpointBoundary,
    advanceCheckpointBoundary,
    close: async () => {
      let failure: unknown;
      try {
        await writer.close();
      } catch (error) {
        failure = error;
      }
      try {
        await db.close();
      } catch (error) {
        failure ??= error;
      }
      try {
        await options.admission.outbox.close();
      } catch (error) {
        failure ??= error;
      }
      try {
        await closeAuxiliaryStorage();
      } catch (error) {
        failure ??= error;
      }
      if (failure !== undefined) throw failure;
    },
    stop: async () => {
      let failure: unknown;
      let databaseClosed = true;
      let orbitdbStopped = true;
      try {
        await writer.close();
      } catch (error) {
        failure = error;
      }
      try {
        await db.close();
      } catch (error) {
        databaseClosed = false;
        failure ??= error;
      }
      try {
        await options.admission.outbox.close();
      } catch (error) {
        failure ??= error;
      }
      try {
        await orbitdb.stop();
      } catch (error) {
        orbitdbStopped = false;
        failure ??= error;
      }
      try {
        await closeAuxiliaryStorage();
      } catch (error) {
        failure ??= error;
      }
      if (!databaseClosed && !orbitdbStopped) {
        const storages = [
          entryStorage,
          headsStorage,
          indexStorage,
          options.accessControllerStorage,
          integrityStorage,
        ];
        const closed = new Set<OrbitStorage>();
        for (const storage of storages) {
          if (storage === undefined || closed.has(storage)) continue;
          closed.add(storage);
          try {
            await storage.close?.();
          } catch {
            /* preserve the first shutdown failure */
          }
        }
      }
      if (!orbitdbStopped) {
        try {
          await orbitdbKeystore?.close();
        } catch {
          /* preserve the first shutdown failure */
        }
      }
      if (failure !== undefined) throw failure;
    },
  };
}

// ── 內容定址塊存取（derived state／cold partition／signer set 塊） ──

/** 定義帳本流程交換的 BlockAccess 資料欄位與約束。 */
export interface BlockAccess {
  /** 寫入 canonical DAG-CBOR bytes、回 CIDv1(dag-cbor)（內容定址） */
  putDagCbor(bytes: Uint8Array): Promise<CID>;
  /** 寫入 opaque bytes、回 CIDv1(raw)（UGC GLB 等非 IPLD 結構內容） */
  putRaw(bytes: Uint8Array): Promise<CID>;
  /** 僅在提供的 CID digest 與精確 bytes 相符時寫入 raw 或 IPLD block。 */
  putExact?(cid: CID, bytes: Uint8Array): Promise<boolean>;
  /** timeout 內取回；缺塊／逾時回 null（呼叫端決定 defer／降級） */
  get(cid: CID, timeoutMs: number, maxBytes?: number): Promise<Uint8Array | null>;
  /** 冪等 pin（已 pin 略過） */
  pin(cid: CID): Promise<void>;
}

/** checkpoint/derived/cold/signer content block 單塊硬上限。 */
export function createBlockAccess(ipfs: LedgerIpfs): BlockAccess {
  const put = async (cid: CID, bytes: Uint8Array): Promise<CID> => {
    if (bytes.byteLength > LEDGER_CONTENT_BLOCK_MAX_BYTES)
      throw new RangeError('ledger content block too large');
    await ipfs.blockstore.put(MultiformatsCID.parse(cid), bytes);
    return cid;
  };
  return {
    putDagCbor: (bytes) => put(cidOfDagCborBytes(bytes), bytes),
    putRaw: (bytes) => put(cidOfRawBytes(bytes), bytes),
    putExact: async (cid, bytes) => {
      if (!cidMatchesBytes(cid, bytes)) return false;
      await put(cid, bytes);
      return true;
    },
    get: async (cid, timeoutMs, maxBytes = LEDGER_CONTENT_BLOCK_MAX_BYTES) => {
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 0 ||
        maxBytes > LEDGER_CONTENT_BLOCK_MAX_BYTES
      )
        return null;
      const owner = new AbortController();
      const deadline = createDeadlineSignal(timeoutMs, owner.signal);
      try {
        const source = await ipfs.blockstore.get(MultiformatsCID.parse(cid), {
          signal: deadline.signal,
        });
        if (source instanceof Uint8Array)
          return source.byteLength <= maxBytes && cidMatchesBytes(cid, source) ? source : null;
        if (typeof source !== 'object' || source === null || !(Symbol.asyncIterator in source))
          return null;
        const chunks: Uint8Array[] = [];
        let total = 0;
        for await (const chunk of source as AsyncIterable<unknown>) {
          if (!(chunk instanceof Uint8Array)) return null;
          total += chunk.byteLength;
          if (total > maxBytes) {
            owner.abort();
            return null;
          }
          chunks.push(chunk);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return cidMatchesBytes(cid, bytes) ? bytes : null;
      } catch {
        return null;
      } finally {
        deadline.dispose();
      }
    },
    pin: async (cid) => {
      const parsed = MultiformatsCID.parse(cid);
      if (await ipfs.pins.isPinned(parsed)) return;
      // pins.add 回 AsyncIterable——drain 完成才算 pin 完
      for await (const _ of ipfs.pins.add(parsed)) void _;
    },
  };
}
