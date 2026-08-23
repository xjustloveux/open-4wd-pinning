/**
 * 持久化儲存與通用 legacy 容量診斷——onboarding 階段請求 persistent storage
 * （防瀏覽器靜默清除）；通用 quota classifier 保留固定 >0.7 warning／>0.9 critical。
 * Active UGC contribution policy 不使用此固定 warning 門檻，而由 app-shell 的動態
 * platform／level trigger 與 target 評估。
 */
import { STORAGE_CRITICAL_USAGE_RATIO } from '../system-constants/ui/storage';

export { STORAGE_CRITICAL_USAGE_RATIO } from '../system-constants/ui/storage';

/** 由瀏覽器儲存空間用量推導的概略診斷嚴重度。 */
export type StorageQuotaLevel = 'ok' | 'warning' | 'critical';

/** 加入使用率與嚴重度正規化後的瀏覽器儲存空間估算。 */
export interface StorageQuotaReport {
  level: StorageQuotaLevel;
  usage: number;
  quota: number;
  /** 0–1；quota 不可得＝0 */
  ratio: number;
}

/** 通用 legacy 診斷門檻；不得用來判斷 active contribution storage pressure。 */
const WARNING_RATIO = 0.7;

/** 請求 persistent storage（已授予／不支援＝快速返回；拒絕＝false） */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || navigator.storage?.persist === undefined) return false;
  try {
    if ((await navigator.storage.persisted?.()) === true) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/**
 * 執行保留 API 相容性的通用 fixed-threshold quota 診斷。
 *
 * @remarks 此函式不是 active contribution policy authority；本機 UGC 額外保留警告由
 * app-shell 的 platform／level 動態 trigger 與 target 決定。
 */
export async function checkStorageQuota(
  estimate: () => Promise<{ usage?: number; quota?: number }> = () =>
    typeof navigator === 'undefined' || navigator.storage?.estimate === undefined
      ? Promise.resolve({})
      : navigator.storage.estimate(),
): Promise<StorageQuotaReport> {
  let usage = 0;
  let quota = 0;
  try {
    const report = await estimate();
    usage = report.usage ?? 0;
    quota = report.quota ?? 0;
  } catch {
    // 不可得＝視為 ok（無資料不誤報）
  }
  const ratio = quota > 0 ? usage / quota : 0;
  return {
    level:
      ratio > STORAGE_CRITICAL_USAGE_RATIO ? 'critical' : ratio > WARNING_RATIO ? 'warning' : 'ok',
    usage,
    quota,
    ratio,
  };
}
