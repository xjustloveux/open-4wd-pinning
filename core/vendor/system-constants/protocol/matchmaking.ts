/**
 * protocol/matchmaking — 配對常數（跨 peer 共識必須一致）
 */

export const PLAYERS_PER_RACE_MAX = 8;
/** 可驗算起跑格 protocol v1 的 participant entropy 長度。 */
export const START_GRID_NONCE_BYTES = 32;
/** commitment 與 reveal 各自的開賽前有界等待窗。 */
export const START_GRID_CEREMONY_PHASE_TIMEOUT_MS = 15_000;
/** ReadySet 全驗證完成後、正式交棒 preloading 前的玩家反悔倒數（初估）。 */
export const READY_COUNTDOWN_SEC = 5;
/** quick match discovery 等待既有公開房出現的 client policy 上限。 */
export const QUICK_MATCH_TIMEOUT_MS = 120_000;
export const PLAYERS_PER_RACE_MIN = 2;
// ── TrueSkill＝共識 derive → 全整數定點（μσ X1000）；FFA 不平手＝draw margin 0、無平手常數 ──
export const TRUESKILL_MU_INITIAL_X1000 = 25_000;
export const TRUESKILL_SIGMA_INITIAL_X1000 = 8_333;
export const TRUESKILL_SIGMA_MIN_X1000 = 6_000; // 頻繁斷線者 σ 不收斂下限
export const TRUESKILL_BETA_X1000 = 4166; // β = 25/6（初估）
export const TRUESKILL_TAU_X10000 = 833; // τ = 25/300（初估；尺度 X10000、使用處明確換算）
export { TRUESKILL_V_TABLE_X1000, TRUESKILL_W_TABLE_X1000 } from './trueskill-vw-table';
/** 限制 TrueSkill v／w 查表輸入 t 的千分比定點數範圍。 */
export const TRUESKILL_VW_T_CLAMP_X1000 = 6_000; // 查表入口 t clamp ±6、步長 10（=0.01）、不插值
/** 定義 TrueSkill v／w 查表輸入 t 的千分比定點步距。 */
export const TRUESKILL_VW_T_STEP_X1000 = 10;
/** 定義開始配對時允許的初始評分差距。 */
export const MATCH_RATING_WINDOW_INITIAL = 5; // displayRating ÷ 1000 整數分域
/** 定義等待每十秒後配對評分窗口增加的幅度。 */
export const MATCH_RATING_WINDOW_GROWTH_PER_10SEC = 5;
/** 限制配對搜尋可擴張至的最大評分差距。 */
export const MATCH_RATING_WINDOW_MAX = 30;
/** 定義近期斷線次數達到頻繁斷線標記的門檻。 */
export const FREQUENT_DISCONNECT_THRESHOLD = 5;
