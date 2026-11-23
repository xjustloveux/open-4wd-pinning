import { describe, expect, it } from 'vitest';
import { addBusinessDays } from './business-days';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 從 fromMs 起往未來找最近一個（可能就是自己）符合 targetUtcDay 的 UTC 日期起點。
 * 刻意不寫死任何西元日期——不管本機或 CI 何時執行本測試都能自我證明「這個時間點確實是
 * 星期幾」，避免測試本身依賴人工背誦的日曆換算。
 */
function nearestUtcWeekday(fromMs: number, targetUtcDay: number): number {
  let t = fromMs;
  while (new Date(t).getUTCDay() !== targetUtcDay) t += MS_PER_DAY;
  return t;
}

describe('addBusinessDays', () => {
  it('平日加一個工作日＝隔天', () => {
    const monday = nearestUtcWeekday(Date.now(), 1);
    const result = addBusinessDays(monday, 1);
    expect(new Date(result).getUTCDay()).toBe(2);
    expect(result - monday).toBe(MS_PER_DAY);
  });

  it('週五加一個工作日跳過週末＝下週一', () => {
    const friday = nearestUtcWeekday(Date.now(), 5);
    const result = addBusinessDays(friday, 1);
    expect(new Date(result).getUTCDay()).toBe(1);
    expect(result - friday).toBe(3 * MS_PER_DAY);
  });

  it('週六起算加一個工作日＝下週一（逐日前進、踩到工作日才計數）', () => {
    const saturday = nearestUtcWeekday(Date.now(), 6);
    const result = addBusinessDays(saturday, 1);
    expect(new Date(result).getUTCDay()).toBe(1);
    expect(result - saturday).toBe(2 * MS_PER_DAY);
  });

  it('週日起算加一個工作日＝隔天週一', () => {
    const sunday = nearestUtcWeekday(Date.now(), 0);
    const result = addBusinessDays(sunday, 1);
    expect(new Date(result).getUTCDay()).toBe(1);
    expect(result - sunday).toBe(MS_PER_DAY);
  });

  it('14 個工作日＝橫跨兩個完整週末，共 18 個日曆天、落在週五', () => {
    const monday = nearestUtcWeekday(Date.now(), 1);
    const result = addBusinessDays(monday, 14);
    expect(new Date(result).getUTCDay()).toBe(5);
    expect(result - monday).toBe(18 * MS_PER_DAY);
  });

  it('累加 N 個工作日，區間內確實恰好有 N 個非週末日期（獨立計數法交叉驗證）', () => {
    const start = nearestUtcWeekday(Date.now(), 1);
    const days = 22;
    const result = addBusinessDays(start, days);
    let count = 0;
    for (let t = start + MS_PER_DAY; t <= result; t += MS_PER_DAY) {
      const d = new Date(t).getUTCDay();
      if (d !== 0 && d !== 6) count++;
    }
    expect(count).toBe(days);
  });

  it('0 個工作日＝時間不變', () => {
    const now = Date.now();
    expect(addBusinessDays(now, 0)).toBe(now);
  });

  it('明示假日不計入工作日', () => {
    const monday = Date.UTC(2026, 7, 3, 12);
    const result = addBusinessDays(monday, 1, new Set(['2026-08-04']));
    expect(new Date(result).toISOString().slice(0, 10)).toBe('2026-08-05');
  });
});
