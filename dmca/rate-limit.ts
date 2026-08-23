/**
 * 固定窗 per-IP 計數，純函式：呼叫端負責保存與取回每個來源的窗狀態，因此同一份規則可
 * 搭配記憶體、Redis 或邊緣 KV 等任意後端。此處刻意使用固定窗，與管理 API 的 token
 * bucket 是不同契約；具名匯出保留演算法差異，避免跨模組誤用。
 */
export interface RateWindow {
  readonly count: number;
  readonly windowStart: number;
}

/** 回報固定時間窗對象是否仍在請求配額內。 */
export interface RateResult {
  readonly allowed: boolean;
  readonly window: RateWindow;
}

/** 對單一不受信任對象套用有界固定時間窗限流政策。 */
export function checkFixedWindowRate(
  window: RateWindow | undefined,
  now: number,
  limit: number,
  windowMs: number,
): RateResult {
  if (window === undefined || now - window.windowStart > windowMs)
    return { allowed: true, window: { count: 1, windowStart: now } };
  if (window.count >= limit) return { allowed: false, window };
  return { allowed: true, window: { count: window.count + 1, windowStart: window.windowStart } };
}
