/**
 * P2P 訊息驗簽 — 白名單＋時戳＋nonce＋簽章四關；全過才收、nonce 才入集合
 */
import { Protocol } from '@open4wd/system-constants';
import type { PeerId, Result, SignedPayload } from '@open4wd/interfaces';
import { err, ok } from '@open4wd/interfaces';
import { verifySignedPayload } from '../key-manager';
import type { NonceSet } from './nonce-set';
import { APP_SECURITY_LOG } from './security-log';

/** 拒收原因（結構化；UI 層如需顯示以 code 映射 i18n） */
export type P2pRejectReason =
  | 'malformed-message'
  | 'untrusted-peer'
  | 'timestamp-out-of-range'
  | 'nonce-replay'
  | 'invalid-signature'
  | 'nonce-capacity';

const TOLERANCE_MS = Protocol.security.P2P_MESSAGE_TIMESTAMP_TOLERANCE_SEC * 1000;

function reject<E extends P2pRejectReason>(reason: E, now: () => number): Result<never, E> {
  APP_SECURITY_LOG.log({ type: 'sig-verify-fail', timestamp: now(), details: { reason } });
  return err(reason);
}

function hasValidEnvelopeShape<T>(signed: SignedPayload<T>): boolean {
  if (typeof signed !== 'object' || signed === null) return false;
  const value = signed as SignedPayload<T> & Record<string, unknown>;
  const keys = Object.keys(value);
  return (
    keys.length === 5 &&
    keys.every((key) => ['payload', 'timestamp', 'nonce', 'signer', 'signature'].includes(key)) &&
    Object.prototype.hasOwnProperty.call(value, 'payload') &&
    typeof value.signer === 'string' &&
    value.signer.length > 0 &&
    value.signer.length <= Protocol.security.P2P_MESSAGE_SIGNER_MAX_CHARS &&
    Number.isSafeInteger(value.timestamp) &&
    value.nonce instanceof Uint8Array &&
    value.nonce.byteLength === Protocol.security.P2P_MESSAGE_NONCE_BYTES &&
    value.signature instanceof Uint8Array
  );
}

/**
 * 驗證 envelope 結構、信任集合、時窗與簽章，但不讀寫 replay state。
 * 供有 authenticated transport source 的呼叫端先完成 signer/source 綁定，再配置
 * per-source nonce 狀態；避免未驗證輸入灌滿 admission maps。
 *
 * @param signed 不可信簽章 envelope。
 * @param trustedPeers 允許的 signer 集合。
 * @param now 本機牆鐘毫秒提供者。
 * @returns payload 或結構化拒收原因。
 */
export function verifyP2PMessageAuthenticity<T>(
  signed: SignedPayload<T>,
  trustedPeers: ReadonlySet<PeerId>,
  now: () => number = Date.now,
): Result<T, Exclude<P2pRejectReason, 'nonce-replay' | 'nonce-capacity'>> {
  if (!hasValidEnvelopeShape(signed)) return reject('malformed-message', now);
  if (!trustedPeers.has(signed.signer)) return reject('untrusted-peer', now);
  if (Math.abs(now() - signed.timestamp) > TOLERANCE_MS)
    return reject('timestamp-out-of-range', now);
  if (signed.signature.byteLength !== Protocol.security.ED25519_SIGNATURE_BYTES)
    return reject('invalid-signature', now);
  try {
    if (!verifySignedPayload(signed)) return reject('invalid-signature', now);
  } catch {
    return reject('invalid-signature', now);
  }
  return ok(signed.payload);
}

/**
 * 驗證 P2P envelope，但不收錄 nonce；供呼叫端先做已驗證 signer 的限流。
 * 成功後呼叫端必須同步呼叫 `nonceSet.add`，否則 replay protection 不完整。
 *
 * @param signed 不可信簽章 envelope。
 * @param trustedPeers 允許的 signer 集合。
 * @param nonceSet replay window 狀態。
 * @param now 本機牆鐘毫秒提供者。
 * @returns payload 或結構化拒收原因；不修改 nonceSet。
 */
export function verifyP2PMessageWithoutNonceCommit<T>(
  signed: SignedPayload<T>,
  trustedPeers: ReadonlySet<PeerId>,
  nonceSet: NonceSet,
  now: () => number = Date.now,
): Result<T, P2pRejectReason> {
  const verified = verifyP2PMessageAuthenticity(signed, trustedPeers, now);
  if (!verified.ok) return verified;
  if (nonceSet.has(signed.nonce)) return reject('nonce-replay', now);
  return verified;
}

/**
 * 白名單、時戳、nonce、簽章全驗證並原子收錄 nonce。
 *
 * @param signed 不可信簽章 envelope。
 * @param trustedPeers 允許的 signer 集合。
 * @param nonceSet replay window 狀態。
 * @param now 本機牆鐘毫秒提供者。
 * @returns payload 或結構化拒收原因。
 */
export function verifyP2PMessage<T>(
  signed: SignedPayload<T>,
  trustedPeers: ReadonlySet<PeerId>,
  nonceSet: NonceSet,
  now: () => number = Date.now,
): Result<T, P2pRejectReason> {
  const verified = verifyP2PMessageWithoutNonceCommit(signed, trustedPeers, nonceSet, now);
  if (!verified.ok) return verified;
  if (!nonceSet.add(signed.nonce, signed.timestamp)) return reject('nonce-capacity', now);
  return verified;
}
