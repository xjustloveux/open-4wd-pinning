/**
 * network/signaling — 連線握手常數（非共識）
 */

export const HANDSHAKE_TIMEOUT_MS = 30_000;
export const TURN_TOKEN_TTL_SEC = 300; // signaling 發放、coturn 以 shared secret 驗證
export const TURN_TOKEN_RESPONSE_MAX_BYTES = 32 * 1024;
export const RETRY_MAX = 3;
export const RETRY_BACKOFF_MS = Object.freeze([1000, 2000, 4000]) as readonly number[];
