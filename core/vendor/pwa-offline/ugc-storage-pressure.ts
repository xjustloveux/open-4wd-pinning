import type { UgcCacheUsagePolicy } from './ugc-contribution-policy';
import { STORAGE_CRITICAL_USAGE_RATIO } from './storage';

/**
 * 說明非 OK 儲存壓力結果。`null` 表示作用中政策不需要警告。
 *
 * - `cleanup-deferred-offline`：一般清理等待連線。
 * - `insufficient-evictable-space`：已驗證清理未達作用中目標。
 * - `cleanup-failed`：清理未執行、遭拒或事後無法驗證。
 * - `critical-after-cleanup`：已驗證清理後用量仍嚴格高於 0.9。
 */
export type UgcStoragePressureReason =
  | 'cleanup-deferred-offline'
  | 'insufficient-evictable-space'
  | 'cleanup-failed'
  | 'critical-after-cleanup'
  | null;

/** 單一目前政策快照的已評估儲存壓力狀態。 */
export interface UgcStoragePressureStatus {
  /** `ok` 不需警告；`warning` 需要注意；`critical` 仍高於臨界路徑。 */
  level: 'ok' | 'warning' | 'critical';
  /** 非 OK 狀態的機器可讀說明；`ok` 時為 `null`。 */
  reason: UgcStoragePressureReason;
  /** 考慮清理前量測的比率；只有初始估算不可用時為零。 */
  beforeRatio: number;
  /**
   * 成功清理後驗證的比率；清理或事後驗證失敗時為如實的清理前比率。
   */
  afterRatio: number;
}

/** 擁有瀏覽器儲存與序列化 LRU 清理的 runtime 所提供相依項目。 */
export interface UgcStoragePressureDeps {
  /**
   * 估算目前 origin 用量與額度。
   *
   * @returns 瀏覽器提供的 usage／quota 配對；任一欄位可能缺少。
   */
  estimate(): Promise<{ usage?: number; quota?: number }>;
  /**
   * 一般（非 critical）清理前確認連線。
   *
   * @returns 僅在一般清理可繼續時為 `true`。
   */
  verifyConnectivity(): Promise<boolean>;
  /**
   * 為此次評估解析一次作用中 trigger／target 配對。
   *
   * @returns 目前原子用量政策快照。
   */
  policy(): UgcCacheUsagePolicy;
  /**
   * 執行序列化清理。
   *
   * @param options 選用 critical startup 模式；`forceWhenCritical: true` 允許 LRU 服務
   * 在離線時清理嚴格 critical startup 壓力。
   * @returns GC 是否實際執行及釋放的 LRU 中繼資料 bytes。`ranGc: false` 表示沒有清理結果可驗證。
   */
  maybeRunGc(options?: { forceWhenCritical?: boolean }): Promise<{
    ranGc: boolean;
    freedBytes: number;
  }>;
  /** 允許嚴格 `> 0.9` startup 壓力在離線時強制清理。 */
  startup: boolean;
}

const ratioOf = (estimate: { usage?: number; quota?: number }): number => {
  const quota = estimate.quota ?? 0;
  return quota > 0 ? (estimate.usage ?? 0) / quota : 0;
};

const ok = (beforeRatio: number, afterRatio = beforeRatio): UgcStoragePressureStatus => ({
  level: 'ok',
  reason: null,
  beforeRatio,
  afterRatio,
});

const cleanupFailed = (beforeRatio: number): UgcStoragePressureStatus => ({
  level: beforeRatio > STORAGE_CRITICAL_USAGE_RATIO ? 'critical' : 'warning',
  reason: 'cleanup-failed',
  beforeRatio,
  afterRatio: beforeRatio,
});

/**
 * 解析作用中層級壓力，保留僅 startup 使用的離線 critical 清理逃生口。
 *
 * @param deps runtime 儲存、連線、政策與序列化 GC 相依項目。
 * @returns 單一政策快照目前的警告狀態與比率。
 * @remarks 初始 estimate rejection 視為零比率 `ok`，避免捏造警告。GC rejection、resolved no-op
 * 或 GC 後 estimate rejection 為 `cleanup-failed`，並保留如實 GC 前比率；僅當該比率嚴格高於
 * 0.9 時嚴重度為 critical。
 * @throws 傳播 `policy()` rejection；一般清理需要時也傳播 `verifyConnectivity()` rejection。
 * `estimate()` 與 `maybeRunGc()` rejection 轉換為上述已記錄狀態結果。
 */
export async function evaluateUgcStoragePressure(
  deps: UgcStoragePressureDeps,
): Promise<UgcStoragePressureStatus> {
  let beforeRatio: number;
  try {
    beforeRatio = ratioOf(await deps.estimate());
  } catch {
    return ok(0, 0);
  }

  const policy = deps.policy();
  const criticalBeforeCleanup = beforeRatio > STORAGE_CRITICAL_USAGE_RATIO;
  const forceWhenCritical = deps.startup && criticalBeforeCleanup;

  if (!forceWhenCritical && beforeRatio <= policy.triggerUsageRatio) return ok(beforeRatio);

  if (!forceWhenCritical && !(await deps.verifyConnectivity())) {
    return {
      level: 'warning',
      reason: 'cleanup-deferred-offline',
      beforeRatio,
      afterRatio: beforeRatio,
    };
  }

  try {
    const result = await deps.maybeRunGc({ forceWhenCritical });
    if (!result.ranGc) return cleanupFailed(beforeRatio);
  } catch {
    return cleanupFailed(beforeRatio);
  }

  let afterRatio: number;
  try {
    afterRatio = ratioOf(await deps.estimate());
  } catch {
    return cleanupFailed(beforeRatio);
  }
  if (afterRatio > STORAGE_CRITICAL_USAGE_RATIO) {
    return {
      level: 'critical',
      reason: 'critical-after-cleanup',
      beforeRatio,
      afterRatio,
    };
  }
  if (afterRatio > policy.targetUsageRatio) {
    return {
      level: 'warning',
      reason: 'insufficient-evictable-space',
      beforeRatio,
      afterRatio,
    };
  }
  return ok(beforeRatio, afterRatio);
}
