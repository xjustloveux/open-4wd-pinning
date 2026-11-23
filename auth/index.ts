/**
 * auth 模組對外出口——匯出 SignedPayload 驗證（signed-request）與授權判定（authorize）的公開
 * 型別與函式。
 */
export {
  verifyPinRequest,
  NonceCache,
  type VerifyResult,
  type PinPayload,
  type UnpinPayload,
  type PinRequestPayload,
} from './signed-request';

export {
  authorize,
  type AuthConfig,
  type AuthDeps,
  type AuthVerdict,
  type PinRequestType,
} from './authorize';
