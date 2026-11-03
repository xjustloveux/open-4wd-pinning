/**
 * network/versioning — 版本升版常數（A 軸 client 版本；非共識）
 * B 軸（資產 schema）動態最低支援版＝ledger 衍生、非靜態常數、不在此
 */
import type { ClientVersion, ProtocolVersion } from '../brands';

/** 目前協定基線：SavedState v1＋strict input/catch-up admission。 */
export const PROTOCOL_VERSION_CURRENT = '1.0.0' as ProtocolVersion;
export const CLIENT_VERSION_CURRENT = '0.1.0' as ClientVersion;
/**
 * 物理引擎 runtime 完整核心版本（含內嵌 WASM digest，與 `rapierVersion()` 全等）；配對全等比對，
 * 同套件版號但不同核心不得混場。generate:pwa 核對 file pin 的核心身份與實際安裝的 JS/WASM。
 */
export const RAPIER_VERSION_CURRENT =
  '0.20.0-open4wd+open4wd.687a79b2970ef05cd15b42272c6957f2826ad72fa99d47192789613c138aeadc';
/** DerivedState 推導邏輯版本（演算法變動＝連帶 client major） */
export const DERIVE_LOGIC_VERSION_CURRENT = 1;
/** 公版資產物理參數版本（參數變動＝連帶 client major；純美術不 bump） */
export const BUILTIN_ASSETS_VERSION_CURRENT = 1;
export const UPDATE_CHECK_INTERVAL_MS = 3_600_000; // 每小時
export const UPDATE_FORCE_GRACE_PERIOD_MS = 86_400_000; // 24 小時軟性寬限
export const VERSION_COLLECT_TIMEOUT_MS = 3_000;
export const VERSION_COLLECT_RETRY = 1;
