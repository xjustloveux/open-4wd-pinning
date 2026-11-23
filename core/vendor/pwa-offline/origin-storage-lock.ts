/** 所有同源持久化 UGC 內容變更與 LRU 操作共用的 Web Lock 名稱。 */
export const UGC_CACHE_ORIGIN_LOCK_NAME = 'open4wd:ugc-cache-lru';

/**
 * 將單一非同步操作與同源儲存權限的所有使用者依序執行。
 * 回傳的 Promise 會採用回呼結果，並以原始鎖定或回呼錯誤拒絕。
 */
export interface OriginStorageLock {
  /**
   * @param run 持有同源鎖定期間要執行的非同步操作。
   * @returns 操作結果的 Promise；發生錯誤時以原始鎖定或操作錯誤拒絕。
   */
  runExclusive<T>(run: () => Promise<T>): Promise<T>;
}

/**
 * 建立以瀏覽器 Web Locks 實作的同源儲存鎖定。
 *
 * @returns 無狀態的鎖定介面，每次操作都會請求共用的獨占名稱。
 * @throws Web Locks 無法使用或鎖定回呼拒絕時，會透過回傳的 Promise 拋出錯誤。
 */
export function browserOriginStorageLock(): OriginStorageLock {
  return {
    runExclusive<T>(run: () => Promise<T>): Promise<T> {
      const locks = globalThis.navigator?.locks;
      if (locks === undefined)
        return Promise.reject(new Error('errors.storage.origin-lock-unavailable'));
      return locks.request(UGC_CACHE_ORIGIN_LOCK_NAME, { mode: 'exclusive' }, () => run());
    },
  };
}
