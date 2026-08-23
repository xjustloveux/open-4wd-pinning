/**
 * OrbitDB Events 的窄版 database adapter：保留 core Log/Sync wire 相容性，但將每個
 * remote head 的 join 包在 traversal quota，並在 Log 建立前 seed checkpoint index。
 */
import { Entry, Log, type OrbitEventsDb, type OrbitStorage } from '@orbitdb/core';
import { base58btc } from 'multiformats/bases/base58';
import { CID as MultiformatsCID } from 'multiformats/cid';
import { TraversalBudgetStorage, canonicalEntryHash } from './bounded-storage';
import { BoundedSync } from './bounded-sync';
import { ledgerOperationAdmissionFailure } from './ledger-admission';
import {
  LEDGER_ADMISSION_V1,
  admissionBaseDigest,
  requiredAdmissionBits,
  type LedgerAdmissionScheme,
  type LedgerOrbitBaseEntry,
  validateCanonicalLedgerEntryBytes,
} from './ledger-entry-admission';
import { LedgerEntryProtectionRegistry } from './ledger-entry-protection';

type Listener = (...args: unknown[]) => void;

function compareLedgerEntries(left: OrbitEntry, right: OrbitEntry): number {
  const time = left.clock.time - right.clock.time;
  if (time !== 0) return time;
  if (left.clock.id !== right.clock.id) return left.clock.id < right.clock.id ? -1 : 1;
  const a = MultiformatsCID.parse(canonicalEntryHash(left.hash), base58btc).bytes;
  const b = MultiformatsCID.parse(canonicalEntryHash(right.hash), base58btc).bytes;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

class LocalEmitter {
  /** Event name 至 observers 的本地集合。 */
  private readonly listeners = new Map<string, Set<Listener>>();
  on(name: string, listener: Listener): this {
    const set = this.listeners.get(name) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(name, set);
    return this;
  }
  off(name: string, listener: Listener): this {
    this.listeners.get(name)?.delete(listener);
    return this;
  }
  emit(name: string, ...args: unknown[]): boolean {
    const listeners = [...(this.listeners.get(name) ?? [])];
    for (const listener of listeners) {
      try {
        listener(...args);
      } catch {
        // 一個 observer 不得阻止其後的 durable-state consumers 收到已 commit entry。
      }
    }
    return listeners.length > 0;
  }
}

interface AccessController {
  canAppend(entry: unknown): Promise<boolean>;
  close?(): Promise<void>;
  drop?(): Promise<void>;
  type: string;
  write?: readonly string[];
}

interface DatabaseParams {
  ipfs: Parameters<typeof BoundedSync>[0]['ipfs'];
  identity: unknown;
  address: string;
  name: string;
  access: AccessController;
  meta?: unknown;
  headsStorage: OrbitStorage;
  entryStorage: OrbitStorage;
  indexStorage: OrbitStorage;
  referencesCount?: number;
  syncAutomatically?: boolean;
  onUpdate?: (log: OrbitLog, entry: OrbitEntry) => void | Promise<void>;
  encryption?: unknown;
}

interface OrbitEntry {
  hash: string;
  id: string;
  clock: { id: string; time: number };
  payload: { op: string; key: string | null; value: unknown };
  next: string[];
  refs: string[];
}

/** 單一 ledger entry 可直接引用的 parent links 上限。 */
export const LEDGER_ENTRY_MAX_NEXT_LINKS = 64;
/** 單一 ledger entry 可攜帶的 skip/reference links 上限。 */
export const LEDGER_ENTRY_MAX_REFERENCE_LINKS = 128;
/** 同時可接受的 OrbitDB frontier heads 數上限。 */
export const LEDGER_HEADS_MAX = 64;
/** Canonical heads metadata 的編碼 byte 上限。 */
export const LEDGER_HEADS_VALUE_MAX_BYTES = 65_536;

interface StagedEntry {
  hash: string;
  bytes: Uint8Array;
}

/** rollback 本身失敗代表 storage 狀態不可再信任，runtime 必須 fail-closed。 */
export class LedgerJoinRollbackError extends Error {}

function requireRollback(
  storage: OrbitStorage,
  label: string,
): asserts storage is OrbitStorage & {
  del(key: string): Promise<void>;
} {
  if (storage.del === undefined)
    throw new Error(`${label} storage does not support atomic rollback`);
}

async function restoreValue(
  storage: OrbitStorage & { del(key: string): Promise<void> },
  key: string,
  previous: Uint8Array | undefined,
): Promise<void> {
  if (previous === undefined) await storage.del(key);
  else await storage.put(key, previous);
}

/**
 * 將已完整驗證／編碼的 remote join 一次提交；任一步驟失敗即還原 entry、index、heads。
 *
 * @param staged 尚未對 log 可見的 entries。
 * @param headBytes 新 head metadata。
 * @param storages OrbitDB 三層 storage。
 */
export async function commitJoinedEntriesAtomically(
  staged: readonly StagedEntry[],
  headBytes: Uint8Array,
  storages: {
    entry: OrbitStorage;
    index: OrbitStorage;
    heads: OrbitStorage;
  },
): Promise<void> {
  requireRollback(storages.entry, 'entry');
  requireRollback(storages.index, 'index');
  requireRollback(storages.heads, 'heads');
  const previousEntries = new Map<string, Uint8Array | undefined>();
  const previousIndexes = new Map<string, Uint8Array | undefined>();
  for (const entry of staged) {
    previousEntries.set(entry.hash, await storages.entry.get(entry.hash));
    previousIndexes.set(entry.hash, await storages.index.get(entry.hash));
  }
  const previousHeads = await storages.heads.get('heads');
  const touched: {
    storage: OrbitStorage & { del(key: string): Promise<void> };
    key: string;
    previous: Uint8Array | undefined;
  }[] = [];
  try {
    for (const entry of staged) {
      touched.push({
        storage: storages.entry,
        key: entry.hash,
        previous: previousEntries.get(entry.hash),
      });
      await storages.entry.put(entry.hash, entry.bytes);
    }
    for (const entry of staged) {
      touched.push({
        storage: storages.index,
        key: entry.hash,
        previous: previousIndexes.get(entry.hash),
      });
      await storages.index.put(entry.hash, new Uint8Array([1]));
    }
    touched.push({ storage: storages.heads, key: 'heads', previous: previousHeads });
    await storages.heads.put('heads', headBytes);
  } catch (cause) {
    const rollbackFailures: unknown[] = [];
    for (const item of touched.reverse()) {
      try {
        await restoreValue(item.storage, item.key, item.previous);
      } catch (error) {
        rollbackFailures.push(error);
      }
    }
    if (rollbackFailures.length > 0)
      throw new LedgerJoinRollbackError('ledger join rollback failed', {
        cause: new AggregateError([cause, ...rollbackFailures]),
      });
    throw cause;
  }
}

/** 驗證 entry links 數量、canonical CID、唯一性與禁止 self-link。 */
export function validateLedgerEntryLinks(entry: Pick<OrbitEntry, 'hash' | 'next' | 'refs'>): void {
  if (entry.next.length > LEDGER_ENTRY_MAX_NEXT_LINKS)
    throw new RangeError('remote ledger entry has too many next links');
  if (entry.refs.length > LEDGER_ENTRY_MAX_REFERENCE_LINKS)
    throw new RangeError('remote ledger entry has too many reference links');
  const links = new Set<string>();
  for (const hash of [...entry.next, ...entry.refs]) {
    if (typeof hash !== 'string' || hash.length === 0 || canonicalEntryHash(hash) !== hash)
      throw new Error('remote ledger entry contains an invalid link');
    if (hash === entry.hash || links.has(hash))
      throw new Error('remote ledger entry contains a duplicate or self link');
    links.add(hash);
  }
}

interface OrbitLog {
  id: string;
  get(hash: string): Promise<OrbitEntry | undefined>;
  iterator(options?: Record<string, unknown>): AsyncIterable<OrbitEntry>;
  heads(): Promise<OrbitEntry[]>;
  traverse(
    roots: readonly OrbitEntry[],
    shouldStop?: (entry: OrbitEntry) => boolean | Promise<boolean>,
  ): AsyncIterable<OrbitEntry>;
  close(): Promise<void>;
  clear(): Promise<void>;
  storage: OrbitStorage;
  encryption: {
    replication?: { decrypt?: unknown };
    data?: { decrypt?: unknown };
  };
}

interface SyncInstance {
  add(entry: OrbitEntry): Promise<void>;
  fetchEntry(hash: string, peer: string): Promise<Uint8Array>;
  start(): Promise<void>;
  stop(): Promise<void>;
  peers: Set<string>;
}

/** 建立 bounded Orbit Events adapter 的 storage、checkpoint 與 admission 選項。 */
export interface BoundedEventsDatabaseOptions {
  entryStorage: TraversalBudgetStorage;
  checkpointBoundary: () => readonly string[] | null;
  integrityStorage: OrbitStorage;
  entryProtection?: LedgerEntryProtectionRegistry;
  admissionScheme?: LedgerAdmissionScheme;
  /** 目前精確帳本位址；OrbitDB open 後立即可取得 genesis。 */
  ledgerAddress?: () => string | null;
  /** Unit-test seam；production 一律省略並使用 canonical Admission validator。 */
  validateEntryBytes?: (
    bytes: Uint8Array,
    expectedCid: string,
    scheme: LedgerAdmissionScheme,
  ) => Promise<ValidatedLedgerEntryBytes>;
  /** metadata/coverage rebuild 完成前由 openOrbitEventLog 延後啟動網路同步。 */
  deferSynchronizationStart?: boolean;
  /** 組裝層提供的 authenticated PeerId string parser。 */
  peerTargetFromString?: (peer: string) => unknown | Promise<unknown>;
}

/** 刻意保持狹窄的內部 validator seam；production 提供完整 sealed entry。 */
export interface ValidatedLedgerEntryBytes {
  readonly cid: string;
  readonly bytes: Uint8Array;
  readonly entry: unknown;
  readonly parentHashes: readonly string[];
  readonly requiredBits: number;
}

/** 尚未挖 admission nonce、但已 canonical 編碼並受 protection 持有的 entry。 */
export interface PreparedLedgerEntry {
  readonly baseEntry: LedgerOrbitBaseEntry;
  readonly baseEntryBytes: Uint8Array;
  readonly baseDigest: Uint8Array;
  readonly requiredBits: number;
  readonly parentHashes: readonly string[];
  readonly protectionOwner: string;
}

/** Prepared entry 提交後的 CID 與既存冪等結果。 */
export interface PreparedCommitResult {
  readonly hash: string;
  readonly alreadyPresent: boolean;
}

const POISON_KEY = '__open4wd_ledger_join_poison_v1__';

/** rollback 失敗必須先 durable 標記，下一個 runtime 才能在讀取不一致狀態前拒開。 */
export async function persistLedgerRollbackPoison(
  error: unknown,
  storage: OrbitStorage,
): Promise<boolean> {
  if (!(error instanceof LedgerJoinRollbackError)) return false;
  await storage.put(POISON_KEY, new Uint8Array([1]));
  return true;
}

/**
 * 建立給 `orbitdb.open({ Database })` 的 Events factory。
 *
 * @param options 已配置 quota 的 entry storage 與本機 checkpoint boundary。
 * @returns OrbitDB-compatible Events database factory。
 */
export function BoundedEventsDatabase(options: BoundedEventsDatabaseOptions): unknown {
  const factory = async (params: DatabaseParams): Promise<OrbitEventsDb> => {
    const entryProtection = options.entryProtection ?? new LedgerEntryProtectionRegistry();
    const admissionScheme = options.admissionScheme ?? LEDGER_ADMISSION_V1;
    const validateEntryBytes = options.validateEntryBytes ?? validateCanonicalLedgerEntryBytes;
    if ((await options.integrityStorage.get(POISON_KEY)) !== undefined)
      throw new Error('ledger cache is poisoned; explicit local ledger cache rebuild required');
    const encryption = params.encryption as
      | {
          replication?: { encrypt?: unknown; decrypt?: unknown };
          data?: { encrypt?: unknown; decrypt?: unknown };
        }
      | undefined;
    if (
      encryption?.replication?.encrypt !== undefined ||
      encryption?.replication?.decrypt !== undefined ||
      encryption?.data?.encrypt !== undefined ||
      encryption?.data?.decrypt !== undefined
    )
      throw new Error('Admission v1 ledger does not support encrypted Orbit entries');
    const referencesCount =
      Number.isInteger(params.referencesCount) && (params.referencesCount ?? -1) >= 0
        ? params.referencesCount!
        : 16;
    if (params.entryStorage !== options.entryStorage)
      throw new Error('bounded database entry storage mismatch');
    if (
      !options.entryStorage.supportsDelete ||
      params.indexStorage.del === undefined ||
      params.headsStorage.del === undefined
    )
      throw new Error('bounded database requires rollback-capable storages');

    const initialBoundary = options.checkpointBoundary();
    if (initialBoundary !== null) {
      const decodedBoundaries: OrbitEntry[] = [];
      for (const rawBoundary of initialBoundary) {
        const boundary = canonicalEntryHash(rawBoundary);
        const bytes = await params.entryStorage.get(boundary);
        if (bytes === undefined) throw new Error('checkpoint boundary entry is unavailable');
        const validated = await validateEntryBytes(bytes, boundary, admissionScheme);
        const decoded = validated.entry as unknown as OrbitEntry;
        if (decoded.hash !== boundary || decoded.id !== params.address)
          throw new Error('checkpoint boundary entry does not belong to this ledger');
        if (!(await params.access.canAppend(decoded)))
          throw new Error('checkpoint boundary entry access verification failed');
        if (!(await Entry.verify(params.identity, decoded)))
          throw new Error('checkpoint boundary entry signature verification failed');
        await params.indexStorage.put(boundary, new Uint8Array([1]));
        decodedBoundaries.push(decoded);
      }
      if ((await params.headsStorage.get('heads')) === undefined) {
        const encodedHeads = new TextEncoder().encode(
          JSON.stringify(
            decodedBoundaries.map((decoded) => ({
              hash: decoded.hash,
              next: (decoded as OrbitEntry & { next: string[] }).next,
            })),
          ),
        );
        await params.headsStorage.put('heads', encodedHeads);
      }
    }

    const log = (await Log(params.identity, {
      logId: params.address,
      access: params.access,
      entryStorage: params.entryStorage,
      headsStorage: params.headsStorage,
      indexStorage: params.indexStorage,
      encryption: params.encryption,
    })) as OrbitLog;
    const events = new LocalEmitter();
    let storagePoisoned = false;
    const poisonAfterRollbackFailure = async (error: unknown): Promise<boolean> => {
      if (!(error instanceof LedgerJoinRollbackError)) return false;
      // 記憶體閘必須先關；durable marker 自身失敗也不得讓同 runtime 繼續操作半套 storage。
      storagePoisoned = true;
      try {
        await persistLedgerRollbackPoison(error, options.integrityStorage);
      } catch (markerFailure) {
        throw new LedgerJoinRollbackError('ledger poison marker persistence failed', {
          cause: new AggregateError([error, markerFailure]),
        });
      }
      return true;
    };
    let queue = Promise.resolve();
    let prepareSequence = 0;
    let lifecycle: 'open' | 'dropping' | 'dropped' | 'closed' = 'open';
    let dropPromise: Promise<void> | null = null;
    const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
      const result = queue.then(work, work);
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };

    const joinFromBoundary = async (
      head: OrbitEntry,
      source: string | null,
      rawHeadBytes: Uint8Array,
    ): Promise<OrbitEntry[]> => {
      if (storagePoisoned) throw new Error('ledger storage is poisoned after failed rollback');
      if ((await params.indexStorage.get(head.hash)) !== undefined) return [];
      const encodedHead = { hash: head.hash, bytes: rawHeadBytes };
      options.entryStorage.chargeExternal(rawHeadBytes.byteLength);
      const currentHeadsBytes = await params.headsStorage.get('heads');
      if (
        currentHeadsBytes !== undefined &&
        currentHeadsBytes.byteLength > LEDGER_HEADS_VALUE_MAX_BYTES
      )
        throw new RangeError('ledger heads metadata exceeds byte limit');
      const currentHeads = currentHeadsBytes
        ? (JSON.parse(new TextDecoder().decode(currentHeadsBytes)) as {
            hash: string;
            next: string[];
          }[])
        : [];
      if (currentHeads.length > LEDGER_HEADS_MAX)
        throw new RangeError('ledger head count exceeds limit');
      const currentHeadHashes = new Set(currentHeads.map((entry) => entry.hash));
      const connectedHeads = new Set<string>();
      const entries = new Map<string, OrbitEntry>();
      const encodedEntries = new Map<string, Uint8Array>([[head.hash, encodedHead.bytes]]);
      const pending: OrbitEntry[] = [head];
      let connected = currentHeads.length === 0 && options.checkpointBoundary() === null;
      const rawBoundary = options.checkpointBoundary();
      const boundaries = new Set(
        rawBoundary === null ? [] : rawBoundary.map((hash) => canonicalEntryHash(hash)),
      );
      while (pending.length > 0) {
        const entry = pending.pop()!;
        if (entries.has(entry.hash)) continue;
        if (
          entry.id !== params.address ||
          !Array.isArray(entry.next) ||
          !Array.isArray(entry.refs) ||
          !(await params.access.canAppend(entry)) ||
          !(await Entry.verify(params.identity, entry))
        )
          throw new Error('remote ledger entry verification failed');
        validateLedgerEntryLinks(entry);
        if (entries.size >= 2048) throw new RangeError('ledger traversal quota exceeded');
        entries.set(entry.hash, entry);
        // refs 是 OrbitDB 的 skip-list 查詢捷徑，不是因果 parent；完整性由逐筆 next
        // 鏈與 entry 簽章/CID 證明。刻意不追 refs，避免其繞過 checkpoint traversal 截斷。
        for (const hash of entry.next) {
          if (boundaries.has(hash)) {
            connected = true;
            if (currentHeadHashes.has(hash)) connectedHeads.add(hash);
            continue; // verified checkpoint boundary：不得 get/follow 其 next/refs
          }
          if ((await params.indexStorage.get(hash)) !== undefined) {
            connected = true;
            if (currentHeadHashes.has(hash)) {
              connectedHeads.add(hash);
            }
            continue;
          }
          if (entries.has(hash)) continue;
          let bytes = await params.entryStorage.get(hash);
          if (bytes === undefined) {
            if (source === null) throw new Error('local prepared entry parent is unavailable');
            bytes = await sync.fetchEntry(hash, source);
            options.entryStorage.chargeExternal(bytes.byteLength);
          }
          const validated = await validateEntryBytes(bytes, hash, admissionScheme);
          const ancestor = validated.entry as unknown as OrbitEntry;
          encodedEntries.set(hash, validated.bytes);
          pending.push(ancestor);
        }
      }
      if (!connected)
        throw new Error('remote ledger head is disconnected from current head or checkpoint');
      const staged: StagedEntry[] = [];
      for (const entry of entries.values()) {
        let bytes = encodedEntries.get(entry.hash);
        if (bytes === undefined) {
          const encoded = (await Entry.encode(entry)) as { hash: string; bytes: Uint8Array };
          if (encoded.hash !== entry.hash) throw new Error('ledger entry encoding mismatch');
          bytes = encoded.bytes;
          encodedEntries.set(entry.hash, bytes);
        }
        staged.push({ hash: entry.hash, bytes });
      }
      const remaining = new Set(entries.keys());
      const ordered: OrbitEntry[] = [];
      while (remaining.size > 0) {
        const ready = [...remaining]
          .filter((hash) => entries.get(hash)!.next.every((parent) => !remaining.has(parent)))
          .map((hash) => entries.get(hash)!)
          .sort(compareLedgerEntries);
        if (ready.length === 0) throw new Error('remote ledger entries contain a cycle');
        for (const entry of ready) {
          remaining.delete(entry.hash);
          ordered.push(entry);
        }
      }
      const nextHeads = currentHeads.filter((entry) => !connectedHeads.has(entry.hash));
      nextHeads.push({ hash: head.hash, next: head.next });
      if (nextHeads.length > LEDGER_HEADS_MAX)
        throw new RangeError('ledger head count exceeds limit');
      const nextHeadsBytes = new TextEncoder().encode(JSON.stringify(nextHeads));
      if (nextHeadsBytes.byteLength > LEDGER_HEADS_VALUE_MAX_BYTES)
        throw new RangeError('ledger heads metadata exceeds byte limit');
      try {
        await commitJoinedEntriesAtomically(staged, nextHeadsBytes, {
          entry: params.entryStorage,
          index: params.indexStorage,
          heads: params.headsStorage,
        });
      } catch (error) {
        await poisonAfterRollbackFailure(error);
        throw error;
      }
      return ordered;
    };

    const applyOperation = (
      entry: OrbitEntry,
      source: string,
      rawBytes: Uint8Array,
    ): Promise<void> =>
      lifecycle !== 'open'
        ? Promise.reject(new Error(`ledger database is ${lifecycle}`))
        : enqueue(async () => {
            const validated = await validateEntryBytes(rawBytes, entry.hash, admissionScheme);
            const committed = await options.entryStorage.runWithTraversalBudget(() =>
              joinFromBoundary(validated.entry as unknown as OrbitEntry, source, validated.bytes),
            );
            for (const committedEntry of committed) {
              try {
                await params.onUpdate?.(log, committedEntry);
              } catch {
                // storage 已 commit；仍須讓其餘本地 consumers 收到，不能回報可重試假象。
              }
              events.emit('update', committedEntry);
            }
          });
    const sync = (await BoundedSync({
      ipfs: params.ipfs,
      log,
      events,
      onSynced: applyOperation,
      start: false,
      headsSync: params.syncAutomatically ?? true,
      peerTargetFromString: options.peerTargetFromString,
    })) as SyncInstance;
    let synchronizationStarted = false;
    const startBoundedSynchronization = async (): Promise<void> => {
      if (synchronizationStarted || !(params.syncAutomatically ?? true)) return;
      await sync.start();
      synchronizationStarted = true;
    };
    if (!options.deferSynchronizationStart) await startBoundedSynchronization();

    const collectReferences = async (
      heads: readonly OrbitEntry[],
      amount: number,
    ): Promise<string[]> => {
      const refs: string[] = [];
      const shouldStop = (): boolean => refs.length >= amount && amount !== -1;
      for await (const { hash } of log.traverse(heads, shouldStop)) refs.push(hash);
      return refs.slice(heads.length + 1, amount);
    };

    const prepare = (value: unknown): Promise<PreparedLedgerEntry> =>
      lifecycle !== 'open'
        ? Promise.reject(new Error(`ledger database is ${lifecycle}`))
        : enqueue(async () => {
            const operation = { op: 'ADD', key: null, value } as const;
            const admissionFailure = ledgerOperationAdmissionFailure(
              operation,
              options.ledgerAddress?.() ?? undefined,
            );
            if (admissionFailure !== null)
              throw new Error(`ledger event is not admissible: ${admissionFailure}`);
            const heads = await log.heads();
            if (heads.length > LEDGER_HEADS_MAX)
              throw new RangeError('ledger head count exceeds limit');
            const next = heads.map(({ hash }) => canonicalEntryHash(hash));
            const maxTime = heads.reduce((maximum, head) => Math.max(maximum, head.clock.time), 0);
            const refs =
              options.checkpointBoundary() === null
                ? await collectReferences([...heads], referencesCount + heads.length)
                : [];
            validateLedgerEntryLinks({ hash: '', next, refs });
            const identity = params.identity as { publicKey?: unknown };
            if (typeof identity.publicKey !== 'string' || identity.publicKey.length === 0)
              throw new Error('Orbit identity public key is unavailable');
            const protectionOwner = `prepare:${++prepareSequence}`;
            const parentHashes = Object.freeze([...next, ...refs]);
            entryProtection.hold(protectionOwner, parentHashes);
            try {
              const created = (await Entry.create(
                params.identity,
                params.address,
                operation,
                undefined,
                { id: identity.publicKey, time: maxTime + 1 },
                next,
                refs,
              )) as unknown as LedgerOrbitBaseEntry;
              const encoded = await Entry.encode(created);
              return Object.freeze({
                baseEntry: created,
                baseEntryBytes: encoded.bytes,
                baseDigest: admissionBaseDigest(encoded.bytes),
                requiredBits: requiredAdmissionBits(encoded.bytes.byteLength, admissionScheme),
                parentHashes,
                protectionOwner,
              });
            } catch (cause) {
              entryProtection.release(protectionOwner);
              throw cause;
            }
          });

    const commitPrepared = (bytes: Uint8Array, cid: string): Promise<PreparedCommitResult> =>
      lifecycle !== 'open'
        ? Promise.reject(new Error(`ledger database is ${lifecycle}`))
        : enqueue(async () => {
            if ((await params.indexStorage.get(cid)) !== undefined)
              return { hash: cid, alreadyPresent: true };
            const validated = await validateEntryBytes(bytes, cid, admissionScheme);
            const committed = await options.entryStorage.runWithTraversalBudget(() =>
              joinFromBoundary(validated.entry as unknown as OrbitEntry, null, validated.bytes),
            );
            for (const committedEntry of committed) {
              try {
                await params.onUpdate?.(log, committedEntry);
              } catch {
                // durable commit 已完成；observer failure 不改寫成功結果。
              }
              events.emit('update', committedEntry);
            }
            if (committed.length > 0 && lifecycle === 'open')
              try {
                await sync.add(committed.at(-1)!);
              } catch {
                // exact outbox retry／heads sync 可重送；durable success 不回報假失敗。
              }
            return { hash: cid, alreadyPresent: committed.length === 0 };
          });

    const iterator = async function* (filters: Record<string, unknown> = {}) {
      for await (const entry of log.iterator(filters))
        yield { hash: entry.hash, value: entry.payload.value };
    };
    const all = async (): Promise<{ hash: string; value: unknown }[]> => {
      const values: { hash: string; value: unknown }[] = [];
      for await (const value of iterator()) values.unshift(value);
      return values;
    };
    const close = async (): Promise<void> => {
      lifecycle = 'closed';
      await sync.stop();
      await queue;
      await log.close();
      await params.access.close?.();
      events.emit('close');
    };
    const drop = async (): Promise<void> => {
      if (lifecycle === 'dropped') return;
      if (dropPromise !== null) return dropPromise;
      lifecycle = 'dropping';
      dropPromise = (async () => {
        // 先關 transport，既有 accepted operation 由同一 queue 完成；新 local/remote
        // 已由 lifecycle gate 拒絕，故 clear 後不可能再復活。
        await sync.stop();
        await enqueue(async () => {
          await log.clear();
          await params.access.drop?.();
          await options.integrityStorage.del?.(POISON_KEY);
          lifecycle = 'dropped';
          events.emit('drop');
        });
      })();
      try {
        await dropPromise;
      } finally {
        if ((lifecycle as string) !== 'dropped') dropPromise = null;
      }
    };

    return {
      address: params.address,
      name: params.name,
      type: 'events',
      access: params.access,
      prepare,
      commitPrepared,
      releasePrepared: async (owner: string) => void entryProtection.release(owner),
      add: () =>
        Promise.reject(
          new Error('direct ledger add is disabled; use the prepared Admission writer'),
        ),
      async get(hash: string) {
        const entry = await log.get(hash);
        return entry?.payload.value;
      },
      iterator,
      all,
      log,
      startBoundedSynchronization,
      events,
      close,
      drop,
      sync,
      peers: sync.peers,
    } as unknown as OrbitEventsDb;
  };
  Object.assign(factory, { type: 'events' });
  return factory;
}
