/**
 * ui/seo — SEO 常數（純客戶端）
 * hreflang：四語系＋x-default＝en
 */

export const CANONICAL_BASE_URL = 'https://open4wd.org';
export const OG_IMAGE_PATH = '/assets/og/cover.jpg';
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;
export const HREFLANG_MAP = Object.freeze({
  'zh-TW': '/zh-TW/',
  'zh-CN': '/zh-CN/',
  en: '/en/',
  ja: '/ja/',
  'x-default': '/en/',
}) as Readonly<Record<string, string>>;
