/**
 * network/perf — 賽內效能預算口徑常數（D-20261028-04）。
 * 非協定：不進 wire、快照或 hash，改值不升 protocol；只影響本機效能閘與警告。
 */

/** 最低支援裝置相對參考機的慢速倍數 k；L0 預算＝T ÷ k。 */
export const PERF_LOW_END_FACTOR = 2;
/** L1 穩態餘裕除數：P50 每幀實付 ≤ T ÷ 此值。 */
export const PERF_STEADY_HEADROOM_DIVISOR = 2;
/** L2 回滾頓挫預算（幀數）：P95 最深回滾事件耗時 ≤ 此值 × T；不除以 k。 */
export const PERF_ROLLBACK_STUTTER_FRAMES = 3;
/** 快照 bytes 目標除數：目標＝上限 ÷ 此值。 */
export const PERF_SNAPSHOT_BYTES_TARGET_DIVISOR = 4;
