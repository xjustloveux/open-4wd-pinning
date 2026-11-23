import { UI } from '@open4wd/system-constants';

/** 玩家選擇提供給可重用 UGC 的本機儲存空間容量。 */
export type UgcContributionLevel = 'off' | 'standard' | 'generous';

/** UGC 快取一次 GC 使用的原子壓力門檻組合。 */
export interface UgcCacheUsagePolicy {
  /** 用量達此比例時啟動一般 LRU 回收。 */
  triggerUsageRatio: number;
  /** 一般 LRU 回收的目標用量比例；必須低於 trigger。 */
  targetUsageRatio: number;
}

/**
 * 建立並凍結一組不可拆分的用量門檻，避免同次 GC 混用不同層級的 ratio。
 *
 * @param triggerUsageRatio 啟動一般 LRU 回收的用量比例。
 * @param targetUsageRatio 一般 LRU 回收完成後的目標用量比例。
 * @returns 凍結的原子用量政策。
 */
const policy = (triggerUsageRatio: number, targetUsageRatio: number): UgcCacheUsagePolicy =>
  Object.freeze({ triggerUsageRatio, targetUsageRatio });

const UGC_CACHE_USAGE_POLICIES: Readonly<
  Record<'desktop' | 'ios', Readonly<Record<UgcContributionLevel, UgcCacheUsagePolicy>>>
> = Object.freeze({
  desktop: Object.freeze({
    off: policy(
      UI.storage.UGC_CACHE_DESKTOP_OFF_TRIGGER_USAGE_RATIO,
      UI.storage.UGC_CACHE_DESKTOP_OFF_TARGET_USAGE_RATIO,
    ),
    standard: policy(
      UI.storage.UGC_CACHE_DESKTOP_STANDARD_TRIGGER_USAGE_RATIO,
      UI.storage.UGC_CACHE_DESKTOP_STANDARD_TARGET_USAGE_RATIO,
    ),
    generous: policy(
      UI.storage.UGC_CACHE_DESKTOP_GENEROUS_TRIGGER_USAGE_RATIO,
      UI.storage.UGC_CACHE_DESKTOP_GENEROUS_TARGET_USAGE_RATIO,
    ),
  }),
  ios: Object.freeze({
    off: policy(
      UI.storage.UGC_CACHE_IOS_OFF_TRIGGER_USAGE_RATIO,
      UI.storage.UGC_CACHE_IOS_OFF_TARGET_USAGE_RATIO,
    ),
    standard: policy(
      UI.storage.UGC_CACHE_IOS_STANDARD_TRIGGER_USAGE_RATIO,
      UI.storage.UGC_CACHE_IOS_STANDARD_TARGET_USAGE_RATIO,
    ),
    generous: policy(
      UI.storage.UGC_CACHE_IOS_GENEROUS_TRIGGER_USAGE_RATIO,
      UI.storage.UGC_CACHE_IOS_GENEROUS_TARGET_USAGE_RATIO,
    ),
  }),
});

/**
 * 依已保存的貢獻等級與平台取得下一次快取決策應使用的原子用量政策。
 *
 * @param level 使用者保存的 UGC 貢獻等級。
 * @param isIos `true` 時使用 iOS/iPadOS 較保守的政策表；否則使用 desktop/non-iOS 表。
 * @returns 凍結且含相符 trigger/target 比例的一組用量政策。
 */
export function ugcCacheUsagePolicy(
  level: UgcContributionLevel,
  isIos: boolean,
): UgcCacheUsagePolicy {
  return UGC_CACHE_USAGE_POLICIES[isIos ? 'ios' : 'desktop'][level];
}
