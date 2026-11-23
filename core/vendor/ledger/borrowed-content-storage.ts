import type { HeliaInit } from 'helia';
import type { OriginStorageLock } from '../pwa-offline/origin-storage-lock';

type Blockstore = NonNullable<HeliaInit['blockstore']>;
type Datastore = NonNullable<HeliaInit['datastore']>;
type DatastoreBatch = ReturnType<Datastore['batch']>;

/** 借給單一可替換線上 Ledger／Helia generation 的非自有 raw 內容 store。 */
export interface BorrowedLedgerContentStorage {
  /** 完整 raw blockstore surface；讀取直接轉送，mutation 共用 origin lock。 */
  blockstore: Blockstore;
  /** 完整 raw datastore surface；讀取直接轉送，mutation 共用 origin lock。 */
  datastore: Datastore;
}

/**
 * 在 origin lock 下 drain streamed mutation，再於解鎖後 replay 其 buffered 結果。
 * 來源／backing 錯誤會 reject consumer，且不公開部分結果。
 *
 * @param lock drain backing iterable 期間持有的共用 origin lock。
 * @param run 取得 lock 後延遲建立 backing mutation iterable。
 * @returns 僅在釋放 lock 後 yield buffered 結果的 async iterable。
 */
async function* lockAndReplay<T>(
  lock: OriginStorageLock,
  run: () => Iterable<T> | AsyncIterable<T>,
): AsyncGenerator<T> {
  const results = await lock.runExclusive(async () => {
    const buffered: T[] = [];
    for await (const result of run()) buffered.push(result);
    return buffered;
  });
  yield* results;
}

/**
 * 包裝權威自有 store，供可替換線上 Ledger generation 使用。
 *
 * @param options 權威自有 blockstore／datastore 及其共用 origin lock。
 * @returns 不含 open／close／start／stop 生命週期 method 的完整非自有 adapter。
 * @throws mutation 傳播原始 lock、abort、來源與 backing-store 錯誤。讀取操作保留 backing store
 * 的同步、promise 或 iterable 錯誤行為。
 */
export function borrowLedgerContentStorage(options: {
  blockstore: Blockstore;
  datastore: Datastore;
  lock: OriginStorageLock;
}): BorrowedLedgerContentStorage {
  const { blockstore, datastore, lock } = options;
  return {
    blockstore: {
      has: (key, methodOptions) => blockstore.has(key, methodOptions),
      put: (key, value, methodOptions) =>
        lock.runExclusive(async () => await blockstore.put(key, value, methodOptions)),
      putMany: (source, methodOptions) =>
        lockAndReplay(lock, () => blockstore.putMany(source, methodOptions)),
      get: (key, methodOptions) => blockstore.get(key, methodOptions),
      getMany: (source, methodOptions) => blockstore.getMany(source, methodOptions),
      delete: (key, methodOptions) =>
        lock.runExclusive(async () => await blockstore.delete(key, methodOptions)),
      deleteMany: (source, methodOptions) =>
        lockAndReplay(lock, () => blockstore.deleteMany(source, methodOptions)),
      getAll: (methodOptions) => blockstore.getAll(methodOptions),
    },
    datastore: {
      has: (key, methodOptions) => datastore.has(key, methodOptions),
      put: (key, value, methodOptions) =>
        lock.runExclusive(async () => await datastore.put(key, value, methodOptions)),
      putMany: (source, methodOptions) =>
        lockAndReplay(lock, () => datastore.putMany(source, methodOptions)),
      get: (key, methodOptions) => datastore.get(key, methodOptions),
      getMany: (source, methodOptions) => datastore.getMany(source, methodOptions),
      delete: (key, methodOptions) =>
        lock.runExclusive(async () => await datastore.delete(key, methodOptions)),
      deleteMany: (source, methodOptions) =>
        lockAndReplay(lock, () => datastore.deleteMany(source, methodOptions)),
      batch: (): DatastoreBatch => {
        const batch = datastore.batch();
        return {
          put: (key, value) => batch.put(key, value),
          delete: (key) => batch.delete(key),
          commit: (methodOptions) =>
            lock.runExclusive(async () => await batch.commit(methodOptions)),
        };
      },
      query: (query, methodOptions) => datastore.query(query, methodOptions),
      queryKeys: (query, methodOptions) => datastore.queryKeys(query, methodOptions),
    },
  };
}
