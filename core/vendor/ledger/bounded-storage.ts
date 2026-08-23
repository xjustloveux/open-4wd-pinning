/** OrbitDB ledger 的本機資源邊界：blockstore byte quota、metadata LRU、單次 traversal quota。 */
import { base58btc } from 'multiformats/bases/base58';
import { CID } from 'multiformats/cid';
import type { OrbitStorage } from '@orbitdb/core';

/** 單一 ledger entry block 可落入本地 store 的 byte 上限。 */
export const LEDGER_ENTRY_BLOCK_MAX_BYTES = 262_144;
/** Ledger blockstore LRU 可保留的總 bytes 上限。 */
export const LEDGER_BLOCKSTORE_MAX_BYTES = 128 * 1024 * 1024;
/** Ledger blockstore LRU 可保留的 entry 數上限。 */
export const LEDGER_BLOCKSTORE_MAX_ENTRIES = 10_000;
/** 單次 remote DAG traversal 可讀取的總 bytes 上限。 */
export const LEDGER_TRAVERSAL_MAX_BYTES = 64 * 1024 * 1024;
/** 單次 remote DAG traversal 可讀取的 entry 數上限。 */
export const LEDGER_TRAVERSAL_MAX_ENTRIES = 2048;

interface BlockstoreLike {
  put(cid: unknown, bytes: Uint8Array, options?: unknown): Promise<unknown>;
  get(cid: unknown, options?: unknown): unknown;
  delete?(cid: unknown, options?: unknown): Promise<unknown>;
  getAll?():
    AsyncIterable<{ cid: unknown; bytes: unknown }> | Iterable<{ cid: unknown; bytes: unknown }>;
}

/** 專屬本機 entry blockstore 轉 OrbitStorage；刻意不含 Helia/Bitswap 網路 broker。 */
export function createLocalEntryStorage(blockstore: BlockstoreLike): OrbitStorage {
  const parse = (hash: string): CID => CID.parse(hash, base58btc);
  const concatenate = (chunks: readonly Uint8Array[]): Uint8Array => {
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  };
  return {
    async put(hash, bytes) {
      await blockstore.put(parse(hash), bytes);
    },
    async get(hash) {
      try {
        return concatenate(
          await collectBoundedBlockChunks(
            blockstore.get(parse(hash)),
            LEDGER_ENTRY_BLOCK_MAX_BYTES,
          ),
        );
      } catch (error) {
        if (error instanceof RangeError) throw error;
        return undefined;
      }
    },
    async del(hash) {
      if (blockstore.delete === undefined) throw new Error('entry blockstore delete unsupported');
      await blockstore.delete(parse(hash));
    },
    async *iterator() {
      if (blockstore.getAll === undefined) return;
      for await (const pair of blockstore.getAll()) {
        const cid =
          CID.asCID(pair.cid) ??
          (String(pair.cid).startsWith('z')
            ? CID.parse(String(pair.cid), base58btc)
            : CID.parse(String(pair.cid)));
        yield [
          cid.toString(base58btc),
          concatenate(await collectBoundedBlockChunks(pair.bytes, LEDGER_ENTRY_BLOCK_MAX_BYTES)),
        ];
      }
    },
    async merge(other) {
      for await (const [hash, bytes] of other.iterator?.() ?? emptyIterator())
        await blockstore.put(parse(hash), bytes);
    },
    async clear() {
      if (blockstore.getAll === undefined || blockstore.delete === undefined)
        throw new Error('entry blockstore clear unsupported');
      for await (const pair of blockstore.getAll()) await blockstore.delete(pair.cid);
    },
    async close() {
      // lifecycle 由 LedgerIpfs.entryBlockstore 所有；Orbit storage close 不重複關閉。
    },
  };
}

interface TrackedBlock {
  cid: unknown;
  bytes: number;
  lastSeen: number;
}

async function collectBoundedBlockChunks(
  source: unknown,
  maximum = Number.POSITIVE_INFINITY,
): Promise<Uint8Array[]> {
  const resolved = await source;
  if (resolved instanceof Uint8Array) {
    if (resolved.byteLength > maximum) throw new RangeError('ledger entry block too large');
    return [resolved];
  }
  if (
    typeof resolved !== 'object' ||
    resolved === null ||
    (!(Symbol.asyncIterator in resolved) && !(Symbol.iterator in resolved))
  )
    throw new TypeError('blockstore.get returned a non-iterable value');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of resolved as AsyncIterable<unknown> | Iterable<unknown>) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError('blockstore chunk is not Uint8Array');
    total += chunk.byteLength;
    if (total > maximum) throw new RangeError('ledger entry block too large');
    chunks.push(chunk);
  }
  return chunks;
}

/**
 * 建立只供 OrbitDB entry storage 使用的有界 blockstore proxy。
 *
 * @param blockstore Helia blockstore。
 * @param isProtectedHash checkpoint frontier／transient／outbox 共用保護判定。
 * @param now LRU 時序提供者。
 * @param isCheckpointCovered hash 是否已被 finalized checkpoint 覆蓋。
 * @param requireBootstrapAccounting 開既有 address 時要求底層可完整列舉，否則拒絕。
 */
export async function createBoundedLedgerBlockstore(
  blockstore: BlockstoreLike,
  isProtectedHash: (hash: string) => boolean,
  now: () => number = Date.now,
  isCheckpointCovered: (hash: string) => boolean = () => false,
  requireBootstrapAccounting = false,
): Promise<BlockstoreLike> {
  const tracked = new Map<string, TrackedBlock>();
  const accounted = new Map<string, number>();
  let totalBytes = 0;
  let bootstrapSaturated = false;
  const isProtected = (hash: string): boolean => isProtectedHash(hash);

  const keyOf = (cid: unknown): string => {
    if (typeof cid === 'string') return cid;
    if (typeof cid === 'object' && cid !== null && 'toString' in cid)
      return (cid as { toString(base?: unknown): string }).toString(base58btc);
    throw new TypeError('invalid block CID');
  };

  const remove = async (key: string): Promise<boolean> => {
    const item = tracked.get(key);
    if (item === undefined || isProtected(key) || !isCheckpointCovered(key)) return false;
    if (blockstore.delete === undefined) return false;
    await blockstore.delete(item.cid);
    tracked.delete(key);
    totalBytes -= accounted.get(key) ?? item.bytes;
    accounted.delete(key);
    return true;
  };

  const makeRoom = async (key: string, bytes: number): Promise<void> => {
    if (bytes > LEDGER_ENTRY_BLOCK_MAX_BYTES) throw new RangeError('ledger entry block too large');
    if (bootstrapSaturated) throw new RangeError('ledger blockstore bootstrap quota exceeded');
    const prior = accounted.get(key) ?? 0;
    while (
      accounted.size + (accounted.has(key) ? 0 : 1) > LEDGER_BLOCKSTORE_MAX_ENTRIES ||
      totalBytes - prior + bytes > LEDGER_BLOCKSTORE_MAX_BYTES
    ) {
      const candidates = [...tracked.entries()]
        .filter(
          ([candidate]) =>
            candidate !== key && !isProtected(candidate) && isCheckpointCovered(candidate),
        )
        .sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      const victim = candidates[0];
      if (victim === undefined || !(await remove(victim[0])))
        throw new RangeError('ledger blockstore quota exhausted');
    }
  };

  const track = (key: string, cid: unknown, bytes: number): void => {
    const prior = tracked.get(key);
    if (prior !== undefined) totalBytes -= accounted.get(key) ?? prior.bytes;
    else if (accounted.has(key)) totalBytes -= accounted.get(key)!;
    tracked.set(key, { cid, bytes, lastSeen: now() });
    accounted.set(key, bytes);
    totalBytes += bytes;
  };

  if (requireBootstrapAccounting && blockstore.getAll === undefined)
    throw new Error('existing ledger blockstore does not support bootstrap accounting');
  if (blockstore.getAll !== undefined) {
    for await (const pair of blockstore.getAll()) {
      const key = keyOf(pair.cid);
      try {
        const chunks = await collectBoundedBlockChunks(pair.bytes, LEDGER_ENTRY_BLOCK_MAX_BYTES);
        const bytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        accounted.set(key, bytes);
        tracked.set(key, { cid: pair.cid, bytes, lastSeen: now() });
        totalBytes += bytes;
      } catch {
        bootstrapSaturated = true;
        break;
      }
      if (
        accounted.size > LEDGER_BLOCKSTORE_MAX_ENTRIES ||
        totalBytes > LEDGER_BLOCKSTORE_MAX_BYTES
      ) {
        bootstrapSaturated = true;
        break;
      }
    }
  }

  return {
    async put(cid, bytes, options) {
      const key = keyOf(cid);
      await makeRoom(key, bytes.byteLength);
      const result = await blockstore.put(cid, bytes, options);
      track(key, cid, bytes.byteLength);
      return result;
    },
    async *get(cid, options) {
      const key = keyOf(cid);
      const wasAccounted = accounted.has(key);
      let chunks: Uint8Array[];
      try {
        chunks = await collectBoundedBlockChunks(
          blockstore.get(cid, options),
          LEDGER_ENTRY_BLOCK_MAX_BYTES,
        );
      } catch (error) {
        if (!wasAccounted && blockstore.delete !== undefined && !isProtected(key))
          await blockstore.delete(cid);
        throw error;
      }
      const bytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      try {
        await makeRoom(key, bytes);
      } catch (error) {
        // 只清掉本次網路抓回、尚未納入 accounting 的新 block；既存 block 可能仍是
        // checkpoint 後重建所需，quota 失敗不得順手破壞它。
        if (!wasAccounted && blockstore.delete !== undefined && !isProtected(key))
          await blockstore.delete(cid);
        throw error;
      }
      track(key, cid, bytes);
      for (const chunk of chunks) yield chunk;
    },
    async delete(cid, options) {
      if (blockstore.delete === undefined) return undefined;
      const key = keyOf(cid);
      const result = await blockstore.delete(cid, options);
      tracked.delete(key);
      const bytes = accounted.get(key);
      if (bytes !== undefined) {
        totalBytes -= bytes;
        accounted.delete(key);
      }
      return result;
    },
    async *getAll() {
      if (blockstore.getAll === undefined)
        throw new Error('ledger blockstore does not support enumeration');
      // enumeration 本身不透過 get()/網路，也不改 LRU；bootstrap 已對同一專屬 store
      // 完成 byte/count accounting。供 verified restart rebuild 與 explicit drop 使用。
      for await (const pair of blockstore.getAll()) yield pair;
    },
  };
}

/** 記憶體 LRU storage；protected key 永不因容量被逐出。 */
export function protectedLruStorage(
  maxEntries: number,
  isProtectedKey: (key: string) => boolean = () => false,
): OrbitStorage {
  if (!Number.isInteger(maxEntries) || maxEntries < 1)
    throw new RangeError('maxEntries must be a positive integer');
  const entries = new Map<string, Uint8Array>();
  const isProtected = (key: string): boolean => isProtectedKey(key);
  const touch = (key: string, value: Uint8Array): void => {
    entries.delete(key);
    entries.set(key, value);
  };
  return {
    async put(key, value) {
      const before = [...entries.entries()];
      try {
        touch(key, value);
        while (entries.size > maxEntries) {
          const victim = [...entries.keys()].find(
            (candidate) => candidate !== key && !isProtected(candidate),
          );
          if (victim === undefined) throw new RangeError('protected storage quota exhausted');
          entries.delete(victim);
        }
      } catch (cause) {
        entries.clear();
        for (const entry of before) entries.set(...entry);
        throw cause;
      }
    },
    async get(key) {
      const value = entries.get(key);
      if (value !== undefined) touch(key, value);
      return value;
    },
    async del(key) {
      entries.delete(key);
    },
    async *iterator() {
      for (const entry of entries) yield entry;
    },
    async clear() {
      entries.clear();
    },
    async close() {
      entries.clear();
    },
  };
}

/** entry storage wrapper；`runWithTraversalBudget` 期間所有 get 共用硬上限。 */
export class TraversalBudgetStorage implements OrbitStorage {
  /** 目前 traversal 共用的 entry/byte 計數；null 表示不在 traversal。 */
  private active: { entries: number; bytes: number } | null = null;

  /** @param inner 實際 entry storage。 */
  constructor(
    /** 保存實際 OrbitDB 儲存實作；所有存取都先由本層套用遍歷預算。 */ private readonly inner: OrbitStorage,
  ) {}

  /** transactional remote join 是否能可靠刪回尚未存在的 key。 */
  get supportsDelete(): boolean {
    return this.inner.del !== undefined;
  }

  /**
   * @param work 單一 remote head 的 join/traversal 工作。
   * @returns work 結果；超過 entry/byte quota 時拒絕且不進入 index/head commit。
   */
  async runWithTraversalBudget<T>(work: () => Promise<T>): Promise<T> {
    if (this.active !== null) throw new Error('nested ledger traversal is not supported');
    this.active = { entries: 0, bytes: 0 };
    try {
      return await work();
    } finally {
      this.active = null;
    }
  }

  /** 在目前儲存預算內寫入指定鍵值；超過遍歷或容量界線時拒絕繼續擴張。 */
  async put(key: string, value: Uint8Array): Promise<void> {
    if (value.byteLength > LEDGER_ENTRY_BLOCK_MAX_BYTES)
      throw new RangeError('ledger entry block too large');
    await this.inner.put(key, value);
  }

  /** 在受限遍歷預算內讀取指定鍵的位元資料；不存在時回傳空值。 */
  async get(key: string): Promise<Uint8Array | undefined> {
    const value = await this.inner.get(key);
    if (value !== undefined && this.active !== null) {
      this.active.entries++;
      this.active.bytes += value.byteLength;
      if (
        this.active.entries > LEDGER_TRAVERSAL_MAX_ENTRIES ||
        this.active.bytes > LEDGER_TRAVERSAL_MAX_BYTES
      )
        throw new RangeError('ledger traversal quota exceeded');
    }
    return value;
  }

  /** 專用 entry-fetch protocol 收到、尚未持久化的 ancestor 也計入同一 traversal quota。 */
  chargeExternal(bytes: number): void {
    if (this.active === null) throw new Error('external traversal charge outside join');
    this.active.entries++;
    this.active.bytes += bytes;
    if (
      this.active.entries > LEDGER_TRAVERSAL_MAX_ENTRIES ||
      this.active.bytes > LEDGER_TRAVERSAL_MAX_BYTES
    )
      throw new RangeError('ledger traversal quota exceeded');
  }

  /** 刪除指定鍵的儲存內容，並將操作計入本次遍歷預算。 */
  del(key: string): Promise<void> {
    if (this.inner.del === undefined)
      return Promise.reject(new Error('storage delete unsupported'));
    return this.inner.del(key);
  }

  /** 建立受預算限制的鍵值迭代器，避免單次同步無界掃描底層儲存。 */
  iterator(options?: { amount?: number; reverse?: boolean }) {
    return this.inner.iterator?.(options) ?? emptyIterator();
  }
  /** 合併另一儲存批次，並沿用相同的遍歷與容量限制。 */
  merge(other: OrbitStorage): Promise<void> {
    return this.inner.merge?.(other) ?? Promise.resolve();
  }
  /** 清除目前儲存視圖中的資料，同時維持底層儲存生命週期。 */
  clear(): Promise<void> {
    return this.inner.clear?.() ?? Promise.resolve();
  }
  /** 停止目前帳本或儲存元件並釋放監聽、連線與背景工作。 */
  close(): Promise<void> {
    return this.inner.close?.() ?? Promise.resolve();
  }
}

async function* emptyIterator(): AsyncIterable<[string, Uint8Array]> {
  yield* [];
}

/** CID 字串轉 canonical base58btc，供 checkpoint boundary 比對。 */
export function canonicalEntryHash(hash: string): string {
  return CID.parse(hash, base58btc).toString(base58btc);
}
