/**
 * 純函式：從 fromMs 起算，往未來跳過週六、週日，累計 days 個工作天之後的時間戳。
 * 全程以 UTC 曆法計算（不受執行環境時區影響，避免測試在不同時區的機器/CI 上出現誤差一天的抖動）。
 * fromMs 本身若剛好落在週末，仍逐日前進、只在踩到工作日（週一～週五）時才遞減計數——
 * 等同「從這一刻起，往後數 N 個工作日」的直覺定義，不需要 fromMs 本身是工作日。
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 將 UTC 時間向後推進指定工作日數，並排除提供的假日。 */
export function addBusinessDays(
  fromMs: number,
  days: number,
  holidays: ReadonlySet<string> = new Set(),
): number {
  let current = fromMs;
  let remaining = days;
  while (remaining > 0) {
    current += MS_PER_DAY;
    const utcDay = new Date(current).getUTCDay(); // 0=週日 ... 6=週六
    const date = new Date(current).toISOString().slice(0, 10);
    if (utcDay !== 0 && utcDay !== 6 && !holidays.has(date)) remaining--;
  }
  return current;
}
