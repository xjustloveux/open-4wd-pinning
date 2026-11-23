/**
 * Signaling v1 的端對端簽章封裝。JSON wire 只負責把 nonce／signature 轉成固定長度
 * lower-case hex；真正簽章仍覆蓋 canonical DAG-CBOR 的 SignedPayload 訊息。
 */
import type { PeerId, Result, SignalMessage, Signature, SignedPayload } from '@open4wd/interfaces';
import { err, ok } from '@open4wd/interfaces';
import { Protocol } from '@open4wd/system-constants';
import { lowercaseHex as toHex } from '../encoding/bytes';
import { buildSignedMessage, peerIdToPublicKey, verifySignedPayload } from '../key-manager';
import { parseRoomId } from '../room-identity';

const MAX_SDP_BYTES = 128 * 1024;
const MAX_CANDIDATE_CHARS = 4096;
const MAX_ICE_FIELD_CHARS = 256;
const NONCE_BYTES = Protocol.security.P2P_MESSAGE_NONCE_BYTES;
const SIGNATURE_BYTES = Protocol.security.ED25519_SIGNATURE_BYTES;
const TIMESTAMP_TOLERANCE_MS = Protocol.security.P2P_MESSAGE_TIMESTAMP_TOLERANCE_SEC * 1000;

/** 經嚴格欄位與大小驗證後，可進入簽章 payload 的 signaling 訊息。 */
export type NormalizedSignalMessage =
  | { readonly type: 'sdp-offer' | 'sdp-answer'; readonly sdp: string }
  | {
      readonly type: 'ice-candidate';
      readonly candidate: {
        readonly candidate: string;
        readonly sdpMid: string | null;
        readonly sdpMLineIndex: number | null;
        readonly usernameFragment: string | null;
      };
    };

/** 綁定 scope 與接收者、尚未附上簽章 metadata 的 signaling payload。 */
export interface SignalEnvelope {
  readonly type: 'signal-v1';
  readonly scope: string;
  readonly target: PeerId;
  readonly message: NormalizedSignalMessage;
}

/** 可在 JSON wire 傳輸並由接收者驗證時效、nonce 與簽章的完整封套。 */
export interface SignedSignalWire extends SignalEnvelope {
  readonly timestamp: number;
  readonly nonceHex: string;
  readonly signer: PeerId;
  readonly signatureHex: string;
}

/** 建立 signaling 簽章封套時由呼叫端提供的訊息與新鮮度材料。 */
export interface SignSignalEnvelopeInput {
  readonly scope: string;
  readonly target: PeerId;
  readonly message: SignalMessage;
  readonly now: number;
  readonly nonce: Uint8Array;
}

type SignalSigner = (message: Uint8Array) => Promise<Uint8Array>;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function boundedString(value: unknown, maxChars: number, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= maxChars;
}

function optionalIceString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || boundedString(value, MAX_ICE_FIELD_CHARS, true);
}

/** 僅允許正式房間實例 ID 與 match digest，避免 global lobby 或任意 namespace。 */
export function isSignalingScope(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ((value.startsWith('room:') && parseRoomId(value.slice('room:'.length)) !== null) ||
      /^match:[0-9a-f]{64}$/.test(value))
  );
}

/** 驗證不可信 signaling payload 並轉為無額外欄位的 canonical 形狀。 */
export function normalizeSignalMessage(message: unknown): Result<NormalizedSignalMessage> {
  const value = record(message);
  if (value === null || typeof value['type'] !== 'string')
    return err(new Error('invalid signal message'));

  if (value['type'] === 'sdp-offer' || value['type'] === 'sdp-answer') {
    if (
      !hasExactKeys(value, ['type', 'sdp']) ||
      typeof value['sdp'] !== 'string' ||
      value['sdp'].length === 0 ||
      new TextEncoder().encode(value['sdp']).byteLength > MAX_SDP_BYTES
    )
      return err(new Error('invalid SDP'));
    return ok({ type: value['type'], sdp: value['sdp'] });
  }

  if (value['type'] !== 'ice-candidate' || !hasExactKeys(value, ['type', 'candidate']))
    return err(new Error('invalid signal message'));
  const candidate = record(value['candidate']);
  if (
    candidate === null ||
    !hasExactKeys(candidate, [
      'candidate',
      ...(candidate['sdpMid'] === undefined ? [] : ['sdpMid']),
      ...(candidate['sdpMLineIndex'] === undefined ? [] : ['sdpMLineIndex']),
      ...(candidate['usernameFragment'] === undefined ? [] : ['usernameFragment']),
    ]) ||
    !boundedString(candidate['candidate'], MAX_CANDIDATE_CHARS) ||
    !optionalIceString(candidate['sdpMid']) ||
    !optionalIceString(candidate['usernameFragment']) ||
    (candidate['sdpMLineIndex'] !== undefined &&
      candidate['sdpMLineIndex'] !== null &&
      (!Number.isInteger(candidate['sdpMLineIndex']) || (candidate['sdpMLineIndex'] as number) < 0))
  )
    return err(new Error('invalid ICE candidate'));

  return ok({
    type: 'ice-candidate',
    candidate: {
      candidate: candidate['candidate'],
      sdpMid: (candidate['sdpMid'] as string | null | undefined) ?? null,
      sdpMLineIndex: (candidate['sdpMLineIndex'] as number | null | undefined) ?? null,
      usernameFragment: (candidate['usernameFragment'] as string | null | undefined) ?? null,
    },
  });
}

function fromLowerHex(value: unknown, bytes: number): Uint8Array | null {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) return null;
  const decoded = new Uint8Array(bytes);
  for (let index = 0; index < bytes; index += 1)
    decoded[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return decoded;
}

function validPeerId(value: unknown): value is PeerId {
  return typeof value === 'string' && peerIdToPublicKey(value as PeerId) !== null;
}

/** 正規化訊息、綁定傳輸域並產生可驗證的 signed wire。 */
export async function signSignalEnvelope(
  input: SignSignalEnvelopeInput,
  sign: SignalSigner,
  signer: PeerId,
): Promise<SignedSignalWire> {
  if (!isSignalingScope(input.scope)) throw new TypeError('invalid signaling scope');
  if (!validPeerId(input.target) || !validPeerId(signer))
    throw new TypeError('invalid signaling PeerId');
  if (!Number.isSafeInteger(input.now)) throw new TypeError('invalid signaling timestamp');
  if (!(input.nonce instanceof Uint8Array) || input.nonce.byteLength !== NONCE_BYTES)
    throw new TypeError('invalid signaling nonce');
  const normalized = normalizeSignalMessage(input.message);
  if (!normalized.ok) throw normalized.error;

  const payload: SignalEnvelope = {
    type: 'signal-v1',
    scope: input.scope,
    target: input.target,
    message: normalized.value,
  };
  const signature = await sign(buildSignedMessage(payload, input.now, input.nonce, signer));
  if (!(signature instanceof Uint8Array) || signature.byteLength !== SIGNATURE_BYTES)
    throw new TypeError('invalid signaling signature');

  return {
    ...payload,
    timestamp: input.now,
    nonceHex: toHex(input.nonce),
    signer,
    signatureHex: toHex(signature),
  };
}

/** 將不可信 JSON wire 解碼為通過結構與基本身分檢查的簽章 payload。 */
export function decodeSignedSignalWire(raw: unknown): SignedPayload<SignalEnvelope> | null {
  const wire = record(raw);
  const timestamp = wire?.['timestamp'];
  if (
    wire === null ||
    !hasExactKeys(wire, [
      'type',
      'scope',
      'target',
      'message',
      'timestamp',
      'nonceHex',
      'signer',
      'signatureHex',
    ]) ||
    wire['type'] !== 'signal-v1' ||
    !isSignalingScope(wire['scope']) ||
    !validPeerId(wire['target']) ||
    !validPeerId(wire['signer']) ||
    typeof timestamp !== 'number' ||
    !Number.isSafeInteger(timestamp)
  )
    return null;

  const message = normalizeSignalMessage(wire['message']);
  if (!message.ok) return null;
  const nonce = fromLowerHex(wire['nonceHex'], NONCE_BYTES);
  const signature = fromLowerHex(wire['signatureHex'], SIGNATURE_BYTES);
  if (nonce === null || signature === null) return null;

  return {
    payload: {
      type: 'signal-v1',
      scope: wire['scope'],
      target: wire['target'],
      message: message.value,
    },
    timestamp,
    nonce,
    signer: wire['signer'],
    signature: signature as Signature,
  };
}

/** 驗證封套時間窗與 Ed25519 簽章；scope/target 路由仍由 session 檢查。 */
export function verifySignalEnvelope(signed: SignedPayload<SignalEnvelope>, now: number): boolean {
  return (
    Number.isSafeInteger(now) &&
    Math.abs(now - signed.timestamp) <= TIMESTAMP_TOLERANCE_MS &&
    verifySignedPayload(signed)
  );
}
