import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLevelCheckpointStorage } from './checkpoint-storage';

// 逐一追蹤本檔建立過的暫存目錄，afterEach 清除——避免每次測試跑都在系統 tmp 底下堆積殘留。
const createdDirs: string[] = [];
const dir = () => {
  const path = mkdtempSync(join(tmpdir(), 'o4wd-ckpt-'));
  createdDirs.push(path);
  return path;
};

afterEach(() => {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
});

describe('createLevelCheckpointStorage', () => {
  it('put/get 往返且跨開啟持久', async () => {
    const path = dir();
    const a = await createLevelCheckpointStorage(path);
    await a.put('k1', new Uint8Array([1, 2, 3]));
    expect(await a.get('k1')).toEqual(new Uint8Array([1, 2, 3]));
    await a.close?.();
    const b = await createLevelCheckpointStorage(path);
    expect(await b.get('k1')).toEqual(new Uint8Array([1, 2, 3]));
    await b.close?.();
  });

  it('compareAndSwap 僅在 expected 相符時寫入', async () => {
    const s = await createLevelCheckpointStorage(dir());
    await s.put('c', new Uint8Array([1]));
    expect(await s.compareAndSwap('c', new Uint8Array([1]), new Uint8Array([2]))).toBe(true);
    expect(await s.compareAndSwap('c', new Uint8Array([9]), new Uint8Array([3]))).toBe(false);
    expect(await s.get('c')).toEqual(new Uint8Array([2]));
    await s.close?.();
  });

  // ⚠️ vendored CheckpointStorage/CheckpointControlStorage 無 delete 方法（僅
  // put/get/close?/compareAndSwap）；改測 compareAndSwap 對缺鍵鍵以
  // expected=undefined 視為「尚不存在」的初始寫入語意——這正是
  // createCheckpointStore 首次寫入 control envelope 時依賴的路徑。
  it('get 缺鍵回 undefined；compareAndSwap 以 expected=undefined 完成初始寫入', async () => {
    const s = await createLevelCheckpointStorage(dir());
    expect(await s.get('nope')).toBeUndefined();
    expect(await s.compareAndSwap('nope', undefined, new Uint8Array([7]))).toBe(true);
    expect(await s.get('nope')).toEqual(new Uint8Array([7]));
    expect(await s.compareAndSwap('nope', undefined, new Uint8Array([8]))).toBe(false);
    await s.close?.();
  });

  // close 後底層 db 已關閉；get 必須讓「儲存層真故障」原樣冒出，
  // 不得被 NOT_FOUND 專用的 catch 誤吞成看似正常的 undefined。
  it('close 後呼叫 get 會拒絕，而非誤回 undefined', async () => {
    const s = await createLevelCheckpointStorage(dir());
    await s.close?.();
    await expect(s.get('k')).rejects.toThrow();
  });
});
