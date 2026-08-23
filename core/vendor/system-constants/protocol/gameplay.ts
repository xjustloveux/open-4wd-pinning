/**
 * protocol/gameplay — 比賽常數（跨 peer 共識必須一致）
 * 三層語意：一場比賽（match）含 N 回合（round）；RACE_*＝回合內即時 race（圈數／時限 per 回合）
 */

export const MATCH_ROUND_COUNT_DEFAULT = 3;
export const MATCH_ROUND_COUNT_MIN = 1;
export const MATCH_ROUND_COUNT_MAX = 5; // 暫定、待 playtest
export const RACE_DURATION_DEFAULT_SEC = 600; // per 回合
export const RACE_DURATION_MIN_SEC = 60;
export const RACE_DURATION_MAX_SEC = 1800;
export const RECONNECT_TIMEOUT_MS = 15_000;
export const LOADOUT_SUBMIT_WINDOW_SEC = 60; // 初估、待 playtest
/** GO 前有限里程碑沒有任何嚴格前進時，取消原 match 並回房重組 roster。 */
export const RACE_READY_STALL_TIMEOUT_MS = 30_000; // 初估、待 playtest
export const SETTLEMENT_TIMEOUT_SEC = 30;
export const SETTLEMENT_TAKEOVER_WAIT_SEC = 5;
export const RACE_LAP_COUNT_DEFAULT = 3; // 僅 lap_mode: loop；per 回合
export const RACE_LAP_COUNT_MIN = 1;
export const RACE_LAP_COUNT_MAX = 10;
export const STARTUP_COUNTDOWN_SEC = 3;
/** 正式賽前倒數相鄰數字的單調時鐘間隔。 */
export const STARTUP_COUNTDOWN_TICK_MS = 1000;
export const LAUNCH_FIRE_INTERVAL_MS = 250; // 初估、待 playtest
/** 場上已無未完賽存活車後，失能車滑行等待的最長回合級視窗。 */
export const ROUND_ENDGAME_MAX_FRAMES = 120; // 2.0 秒；初估、待 playtest
/** 全部未完賽失能車低速時，連續滿足此幀數可提早結束。 */
export const ROUND_ENDGAME_SETTLED_FRAMES = 15; // 0.25 秒；初估、待 playtest
export const ROUND_DISABLED_LINEAR_SPEED_MAX_MPS = 0.05; // 初估、待 playtest
export const ROUND_DISABLED_ANGULAR_SPEED_MAX_RAD_S = 0.1; // 初估、待 playtest
