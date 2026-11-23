/** 等待 IndexedDB 交易確實完成，且不依賴任何單一請求。 */
export function waitForRequest<T>(
  request: IDBRequest<T>,
  label = 'IndexedDB operation',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`${label}: request failed`));
  });
}

/** 等待 IndexedDB 交易確實完成，且不依賴任何單一請求。 */
export function waitForTransaction(
  transaction: IDBTransaction,
  label = 'IndexedDB operation',
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (fallback: string): void => {
      if (settled) return;
      settled = true;
      reject(transaction.error ?? new Error(`${label}: ${fallback}`));
    };
    transaction.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    transaction.onerror = () => fail('transaction failed');
    transaction.onabort = () => fail('transaction aborted');
  });
}

/** 同時等待請求結果與其外層交易提交完成。 */
export function waitForTransactionRequest<T>(
  transaction: IDBTransaction,
  request: IDBRequest<T>,
  label = 'IndexedDB operation',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let result: T;
    let requestSucceeded = false;
    let settled = false;
    const fail = (fallback: string): void => {
      if (settled) return;
      settled = true;
      reject(transaction.error ?? request.error ?? new Error(`${label}: ${fallback}`));
    };
    request.onsuccess = () => {
      result = request.result;
      requestSucceeded = true;
    };
    request.onerror = () => fail('request failed');
    transaction.onerror = () => fail('transaction failed');
    transaction.onabort = () => fail('IndexedDB transaction aborted');
    transaction.oncomplete = () => {
      if (settled) return;
      if (!requestSucceeded) return fail('transaction completed without a request result');
      settled = true;
      resolve(result);
    };
  });
}
