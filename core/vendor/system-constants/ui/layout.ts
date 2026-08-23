/**
 * ui/layout — 版面與主題資產預算常數（純客戶端）
 * 斷點語意：CSS 邏輯像素、media query 一律以 em 實作（40／64／90em）、可用寬度分桶禁機型綁定
 */

/** 主題不可覆蓋的 gameplay 資訊 token（語意狀態、HUD 可讀性、競賽辨識色）。 */
export const THEME_RESERVED_TOKENS: readonly string[] = Object.freeze([
  '--color-danger',
  '--color-warning',
  '--color-success',
  '--size-hit-min',
  '--size-hud-button',
  '--size-hud-button-touch',
  '--font-size-hud',
  '--line-height-hud',
  '--o4-gameplay-overheat-cool',
  '--o4-gameplay-overheat-warm',
  '--o4-gameplay-overheat-critical',
  '--o4-gameplay-fatigue-ok',
  '--o4-gameplay-fatigue-warning',
  '--o4-gameplay-fatigue-critical',
  '--o4-gameplay-self-ring',
  '--o4-gameplay-eliminated',
  '--o4-gameplay-racer-1',
  '--o4-gameplay-racer-2',
  '--o4-gameplay-racer-3',
  '--o4-gameplay-racer-4',
  '--o4-gameplay-racer-5',
  '--o4-gameplay-racer-6',
  '--o4-gameplay-racer-7',
  '--o4-gameplay-racer-8',
]);
export const THEME_SIZE_MAX_MB = 20; // 初估
export const THEME_FONT_MAX_FILES = 4;
export const THEME_FONT_MAX_BYTES = 524288; // 512 KiB（WOFF2 壓縮 bytes 合計）
