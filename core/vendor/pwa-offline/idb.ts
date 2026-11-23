/**
 * 統一 IndexedDB——單一 DB `open-4wd`、**單一 upgrade 集中建
 * 全部 stores**（分散各模組自建＝版本競合經典地雷：無版本 open 不觸發 upgrade、
 * 缺 store 直接 throw）。各模組一律經 openUnifiedDb 取連線、**用畢即 close**（長持
 * 連線會擋未來版本升級）。加密金鑰**不在本 DB**＝獨立 `open4wd-keys`
 * （鎖定生命週期與安全隔離）。
 */

export const UNIFIED_DB_NAME = 'open-4wd';
export const UNIFIED_DB_VERSION = 1;

/** 由統一資料庫升級以原子方式建立的完整物件儲存區結構。 */
export const UNIFIED_DB_STORES: readonly { name: string; keyPath: string }[] = Object.freeze([
  { name: 'local-parts', keyPath: 'id' },
  { name: 'local-tracks', keyPath: 'id' },
  { name: 'settings', keyPath: 'key' },
  { name: 'cached-ugc-thumbnails', keyPath: 'cid' },
  { name: 'ugc-cache-meta', keyPath: 'cid' },
  { name: 'recent-teammates', keyPath: 'peerId' },
  { name: 'blocklist', keyPath: 'peerId' },
  { name: 'composed-vehicle-thumbnails', keyPath: 'cacheKey' },
  { name: 'ledger-admission-outbox', keyPath: 'cid' },
  { name: 'physics-manifest-receipts', keyPath: 'key' },
  { name: 'inbox-snapshots', keyPath: 'id' },
  { name: 'inbox-read-markers', keyPath: 'id' },
]);

/** 開啟統一 DB（upgrade 建缺席 stores；onblocked 顯式回報不卡死） */
export function openUnifiedDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(UNIFIED_DB_NAME, UNIFIED_DB_VERSION);
    let settled = false;
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const { name, keyPath } of UNIFIED_DB_STORES)
        if (!database.objectStoreNames.contains(name))
          database.createObjectStore(name, { keyPath });
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error('indexedDB open 失敗'));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error('indexedDB 開啟被既有連線阻擋'));
    };
  });
}
