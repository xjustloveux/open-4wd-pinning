/**
 * ui/audio — BGM 轉場與總輸出限幅（純客戶端）
 */

export const BGM_CROSSFADE_MS = 1000; // 異曲轉場（初估）

// 總輸出限幅器（DynamicsCompressorNode）：門檻以下的聲音不受影響，多聲源相加超過時才壓回。
/** 限幅門檻（dBFS）；低於滿刻度的部分留給起音期間的過衝（實測見 D-20261112-03）。 */
export const AUDIO_LIMITER_THRESHOLD_DB = -3;
/** knee 寬度（dB）；0＝硬轉折，門檻以下完全不壓縮。 */
export const AUDIO_LIMITER_KNEE_DB = 0;
/** 壓縮比；20 是 DynamicsCompressorNode 允許的最大值。 */
export const AUDIO_LIMITER_RATIO = 20;
/** 起音時間（秒）。 */
export const AUDIO_LIMITER_ATTACK_S = 0.003;
/** 釋放時間（秒）。 */
export const AUDIO_LIMITER_RELEASE_S = 0.25;
