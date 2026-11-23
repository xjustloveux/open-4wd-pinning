/**
 * 帳本檢查點的 Node 端持久儲存——classic-level 之上疊一層 in-process 寫入序列化，
 * 讓 compareAndSwap 的「讀現值→比對→寫入」在單一行程內不可分割（本服務單一寫者，
 * 足夠充當 CheckpointControlStorage 要求的原子 CAS）。
 */
import { ClassicLevel } from 'classic-level';
import type { CheckpointControlStorage, CheckpointStorage } from '../core';

function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// classic-level 在 'view' valueEncoding 下實際回傳 Node Buffer（Uint8Array 子類、
// 且可能共用內部小物件記憶體池）；正規化成純 Uint8Array 複本，避免把 Buffer 特有
// 身分／池化記憶體外洩給呼叫端。
function normalize(value: Uint8Array | undefined): Uint8Array | undefined {
  return value === undefined ? undefined : new Uint8Array(value);
}

/** 開啟依序寫入的 Level 檢查點與控制儲存。 */
export async function createLevelCheckpointStorage(
  path: string,
): Promise<CheckpointStorage & CheckpointControlStorage> {
  const db = new ClassicLevel<string, Uint8Array>(path, { valueEncoding: 'view' });
  await db.open();

  let chain: Promise<unknown> = Promise.resolve();
  const run = <T>(op: () => Promise<T>): Promise<T> => {
    const result = chain.then(op);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  // 只吞「鍵不存在」；其餘錯誤（如底層儲存真故障）原樣重擲，不得偽裝成空值。
  const getOr = async (key: string): Promise<Uint8Array | undefined> => {
    try {
      return normalize(await db.get(key));
    } catch (error) {
      if ((error as { code?: string }).code === 'LEVEL_NOT_FOUND') return undefined;
      throw error;
    }
  };

  return {
    get: (key) => run(() => getOr(key)),
    put: (key, value) => run(() => db.put(key, value)),
    compareAndSwap: (key, expected, next) =>
      run(async () => {
        const current = await getOr(key);
        if (!bytesEqual(current, expected)) return false;
        await db.put(key, next);
        return true;
      }),
    // 入序列鏈：確保任何仍在鏈上排隊、尚未執行的 fire-and-forget op
    // 不會在 close 之後才動手，撞上 LEVEL_DATABASE_NOT_OPEN。
    close: () => run(() => db.close()),
  };
}
