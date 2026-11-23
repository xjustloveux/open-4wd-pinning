/**
 * pin／unpin 授權判定——白名單 ∪ 信譽閾值決定基本資格；repeat-infringer 對 pin 動作額外一票
 * 否決（unpin 不受此限，讓已被標記者仍能自行清理既有內容）。
 */
import type { PinRequestPayload } from './signed-request';

/** 沿用 payload 的 type 域字面量，呼叫端可直接傳 verifyPinRequest 回傳之 payload.type */
export type PinRequestType = PinRequestPayload['type'];

/** 設定簽署者允許清單與選用的信譽准入門檻。 */
export interface AuthConfig {
  /** 靜態白名單（模式一）——signer 字串完全比對 */
  readonly authorizedSigners: readonly string[];
  /** 信譽閾值（模式二）——未設定表示停用此模式 */
  readonly reputationThreshold?: number;
}

/** 向授權政策提供信譽與重複侵權者裁定。 */
export interface AuthDeps {
  /** 節點自身 derive 的信譽分數；查無資料回 undefined（視為不合格，不當作 0 分處理） */
  reputationOf(signer: string): number | undefined;
  /** repeat-infringer 判定；由呼叫端注入，與其判定依據解耦 */
  isRepeatInfringer(signer: string): boolean;
}

/** 表示授權成功或穩定的拒絕原因。 */
export type AuthVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: 'NOT_AUTHORIZED' | 'REPEAT_INFRINGER' };

function hasBaseAuthorization(signer: string, cfg: AuthConfig, deps: AuthDeps): boolean {
  if (cfg.authorizedSigners.includes(signer)) return true;
  if (cfg.reputationThreshold === undefined) return false;
  const reputation = deps.reputationOf(signer);
  return reputation !== undefined && reputation >= cfg.reputationThreshold;
}

/**
 * 判定某 signer 是否有權執行給定動作。
 *
 * 判定序：先看白名單 ∪ 信譽閾值是否給予基本資格，沒有就直接 NOT_AUTHORIZED；有基本資格後，
 * 若動作是 pin 且該 signer 被標記 repeat-infringer，一票否決改判 REPEAT_INFRINGER——unpin
 * 不受此否決影響，維持可放行。
 *
 * @param signer 請求者識別字串。
 * @param action 請求動作。
 * @param cfg 白名單與信譽閾值設定。
 * @param deps 信譽查詢與 repeat-infringer 判定（皆由呼叫端注入）。
 */
export function authorize(
  signer: string,
  action: PinRequestType,
  cfg: AuthConfig,
  deps: AuthDeps,
): AuthVerdict {
  if (!hasBaseAuthorization(signer, cfg, deps)) return { allowed: false, code: 'NOT_AUTHORIZED' };
  if (action === 'pinning-pin' && deps.isRepeatInfringer(signer)) {
    return { allowed: false, code: 'REPEAT_INFRINGER' };
  }
  return { allowed: true };
}
