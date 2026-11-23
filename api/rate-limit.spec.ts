import { describe, expect, it } from 'vitest';
import { checkRate, pruneRateWindows, type TokenBucketState } from './rate-limit';

describe('checkRate（token bucket）', () => {
  it('容量內的突發全部放行，滿載後同一瞬間再打一次即擋', () => {
    const config = { capacity: 3, refillPerSec: 1 };
    let state: TokenBucketState | undefined;
    for (let i = 0; i < 3; i++) {
      const r = checkRate(state, 1000, config);
      expect(r.allowed).toBe(true);
      state = r.state;
    }
    const fourth = checkRate(state, 1000, config);
    expect(fourth.allowed).toBe(false);
  });

  it('耗盡後隨補充速率經過時間可再放行（突發容量耗盡後隨時間補充可再過）', () => {
    const config = { capacity: 1, refillPerSec: 1 };
    const consumed = checkRate(undefined, 0, config);
    expect(consumed.allowed).toBe(true);
    expect(checkRate(consumed.state, 100, config).allowed).toBe(false); // 100ms 還補不到 1 顆
    expect(checkRate(consumed.state, 1000, config).allowed).toBe(true); // 1000ms 補滿 1 顆
  });

  it('首次見到的來源（無既存 state）以滿桶起算', () => {
    const r = checkRate(undefined, 12345, { capacity: 5, refillPerSec: 1 });
    expect(r.allowed).toBe(true);
    expect(r.state.tokens).toBe(4);
  });

  it('補充不超過容量上限——長時間閒置不會累積超額 tokens', () => {
    const config = { capacity: 2, refillPerSec: 100 };
    const first = checkRate(undefined, 0, config); // 消耗 1 顆，剩 1
    const muchLater = checkRate(first.state, 1_000_000, config); // 補充遠超容量
    expect(muchLater.allowed).toBe(true);
    // 補到頂後扣 1：應恰為 capacity - 1，而非某個因補充量未夾上限而暴增的值
    expect(muchLater.state.tokens).toBe(1);
  });

  it('時鐘倒流（now 早於上次 updatedAtMs）不倒扣 tokens', () => {
    const config = { capacity: 2, refillPerSec: 1 };
    const first = checkRate(undefined, 1000, config); // tokens=1, updatedAtMs=1000
    const backwards = checkRate(first.state, 500, config); // now 早於 1000
    expect(backwards.allowed).toBe(true);
    expect(backwards.state.tokens).toBe(0); // 沒有補充（elapsed 夾在 0），單純再扣 1
  });

  it('不同來源（呼叫端各自持有獨立 state）互不影響', () => {
    const config = { capacity: 1, refillPerSec: 1 };
    const a = checkRate(undefined, 0, config);
    const b = checkRate(undefined, 0, config);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
  });
});

describe('pruneRateWindows（rateWindows Map 回收——防大量不同 IP 把它撐爆）', () => {
  it('閒置時間達到「補滿所需時間」的條目會被清掉（TTL 等價於「這個來源沒出現過」）', () => {
    const config = { capacity: 2, refillPerSec: 1 }; // 補滿需要 2000ms
    const windows = new Map<string, TokenBucketState>([
      ['192.0.2.1', { tokens: 0, updatedAtMs: 0 }],
    ]);

    pruneRateWindows(windows, 1999, config); // 還沒到補滿所需時間
    expect(windows.has('192.0.2.1')).toBe(true);

    pruneRateWindows(windows, 2000, config); // 剛好達到
    expect(windows.has('192.0.2.1')).toBe(false);
  });

  it('尚未閒置到 TTL 的條目原樣保留，不受牽連', () => {
    const config = { capacity: 5, refillPerSec: 1 };
    const windows = new Map<string, TokenBucketState>([
      ['192.0.2.1', { tokens: 2, updatedAtMs: 1000 }],
    ]);

    pruneRateWindows(windows, 1500, config);

    expect(windows.get('192.0.2.1')).toEqual({ tokens: 2, updatedAtMs: 1000 });
  });

  it('refillPerSec=0（永不自動回填）的桶不會被 TTL 誤判為到期，只受硬上限約束', () => {
    const config = { capacity: 1, refillPerSec: 0 };
    const windows = new Map<string, TokenBucketState>([
      ['192.0.2.1', { tokens: 0, updatedAtMs: 0 }],
    ]);

    pruneRateWindows(windows, 10_000_000, config);

    expect(windows.has('192.0.2.1')).toBe(true);
  });

  it('硬上限逐出：條目數超過上限時，逐出 updatedAtMs 最舊的直到回到上限', () => {
    const config = { capacity: 1000, refillPerSec: 0.001 }; // TTL 極長，逼近全靠硬上限逐出
    const maxEntries = 5;
    const windows = new Map<string, TokenBucketState>();
    for (let i = 0; i < maxEntries + 3; i += 1) {
      windows.set(`ip-${i}`, { tokens: 1, updatedAtMs: i });
    }

    pruneRateWindows(windows, maxEntries + 3, config, maxEntries);

    expect(windows.size).toBe(maxEntries);
    expect(windows.has('ip-0')).toBe(false);
    expect(windows.has('ip-1')).toBe(false);
    expect(windows.has('ip-2')).toBe(false);
    expect(windows.has(`ip-${maxEntries + 2}`)).toBe(true); // 最新的留著
  });

  it('大量不同來源持續打過後，map 尺寸恆維持在上限內（模擬 IP 輪替／殭屍網路攻擊）', () => {
    const config = { capacity: 20, refillPerSec: 1 };
    const maxEntries = 50;
    const windows = new Map<string, TokenBucketState>();

    for (let i = 0; i < maxEntries * 5; i += 1) {
      const now = i; // 每「毫秒」一個從未出現過的新來源，永遠不會被同一來源的重複造訪稀釋
      // 呼叫順序比照 api/server.ts 的 checkClientRate：先存回這次請求的桶狀態，再回收——
      // 剛寫入的條目 updatedAtMs 必為最新，硬上限逐出不會選中它，size 在每次呼叫後都不
      // 超過上限，不會有插入後暫時超額一筆的空窗。
      windows.set(`ip-${i}`, checkRate(windows.get(`ip-${i}`), now, config).state);
      pruneRateWindows(windows, now, config, maxEntries);
      expect(windows.size).toBeLessThanOrEqual(maxEntries);
    }
  });
});
