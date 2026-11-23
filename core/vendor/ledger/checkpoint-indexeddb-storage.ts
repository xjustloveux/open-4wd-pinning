import { waitForTransactionRequest } from '../pwa-offline/idb-transaction';
import type { CheckpointControlStorage } from './checkpoint-store';
import { chainStorageName, type ChainId } from './chain-identity';

const DATABASE_NAME = 'open4wd-ledger-checkpoints';
const DATABASE_VERSION = 1;
const STORE_NAME = 'blocks';

function equalBytes(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function openCheckpointDatabase(chainId?: ChainId): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(
      chainId === undefined ? DATABASE_NAME : chainStorageName(DATABASE_NAME, chainId),
      DATABASE_VERSION,
    );
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('checkpoint IndexedDB open failed'));
    request.onblocked = () => reject(new Error('checkpoint IndexedDB open blocked'));
  });
}

/** Browser production checkpoint storage; CAS 的讀、比對、寫入共用單一 IDB transaction。 */
export async function createIndexedDbCheckpointStorage(
  chainId?: ChainId,
): Promise<CheckpointControlStorage> {
  const database = await openCheckpointDatabase(chainId);
  return {
    get: async (key) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(key) as IDBRequest<
        Uint8Array | undefined
      >;
      const value = await waitForTransactionRequest(transaction, request, 'checkpoint get');
      return value === undefined ? undefined : new Uint8Array(value);
    },
    put: async (key, value) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const request = transaction.objectStore(STORE_NAME).put(new Uint8Array(value), key);
      await waitForTransactionRequest(transaction, request, 'checkpoint put');
    },
    compareAndSwap: async (key, expectedValue, nextValue) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      return new Promise<boolean>((resolve, reject) => {
        let matched = false;
        let failure: Error | null = null;
        const request = store.get(key) as IDBRequest<Uint8Array | undefined>;
        request.onsuccess = () => {
          const current = request.result;
          if (!equalBytes(current, expectedValue)) return;
          matched = true;
          const put = store.put(new Uint8Array(nextValue), key);
          put.onerror = () => {
            failure = put.error ?? new Error('checkpoint CAS write failed');
          };
        };
        request.onerror = () => {
          failure = request.error ?? new Error('checkpoint CAS read failed');
        };
        transaction.onerror = () =>
          reject(failure ?? transaction.error ?? new Error('checkpoint CAS transaction failed'));
        transaction.onabort = () =>
          reject(failure ?? transaction.error ?? new Error('checkpoint CAS transaction aborted'));
        transaction.oncomplete = () => {
          if (failure !== null) return reject(failure);
          resolve(matched);
        };
      });
    },
    close: async () => database.close(),
  };
}
