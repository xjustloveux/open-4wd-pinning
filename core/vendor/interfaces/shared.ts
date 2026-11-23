/**
 * 共用型別 — 五個已接線介面與 AssetStorage seam 的基座：Result／識別符 Brand 再匯出
 */
export type { CID, PeerId, Signature } from '../system-constants/brands';

/** UNIX 毫秒 */
export type Timestamp = number;

/** 結果型別（避免 throw；錯誤走值傳遞） */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

/** 建立成功 Result 的便利函式。 */
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
/** 建立失敗 Result 的便利函式。 */
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** 取消訂閱把手 */
export type Unsubscribe = () => void;
