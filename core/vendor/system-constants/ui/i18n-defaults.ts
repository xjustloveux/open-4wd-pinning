/**
 * ui/i18n-defaults — 語系預設（純客戶端）
 */

export const DEFAULT_LANG = 'zh-TW' as const;
export const FALLBACK_LANG = 'en' as const;
export const SUPPORTED_LANGS = Object.freeze(['zh-TW', 'zh-CN', 'en', 'ja']) as readonly string[];
