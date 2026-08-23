import { buildSignedMessage, verifySignedPayload } from '../core';
import type { PeerId, Signature, SignedPayload } from '../core';
import type { ProviderDmcaInboxEntry } from './types';

const FRESHNESS_MS = 5 * 60_000;
const NONCE_BYTES = 16;
const SIGNATURE_BYTES = 64;

/** 定義單一上傳者存取供應者本機 DMCA 收件匣的簽署請求。 */
export interface DmcaInboxRequestPayload {
  type: 'open4wd-provider-dmca-inbox-request';
  providerId: PeerId;
  subjectPeerId: PeerId;
}

/** 承載單一已驗證上傳者可見的最小供應者本機案件更新。 */
export interface DmcaInboxPayload {
  type: 'open4wd-provider-dmca-inbox';
  providerId: PeerId;
  subjectPeerId: PeerId;
  generatedAt: number;
  entries: ProviderDmcaInboxEntry[];
}

/** 以十六進位二進位欄位編碼簽署收件匣請求或回應。 */
export interface SignedInboxWire<T> {
  payload: T;
  timestamp: number;
  nonceHex: string;
  signer: PeerId;
  signatureHex: string;
}

/** 驗證收件匣請求並簽署供應者擁有的收件匣回應。 */
export interface DmcaInboxCrypto {
  readonly providerId: PeerId;
  verifySignedRequest<T>(raw: unknown): SignedPayload<T> | null;
  verifyRequest(raw: unknown): { subjectPeerId: PeerId } | null;
  signResponse(payload: DmcaInboxPayload): Promise<SignedInboxWire<DmcaInboxPayload>>;
}

interface DmcaInboxCryptoDeps {
  providerId: PeerId;
  now(): number;
  randomNonce(): Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function decodeHex(value: unknown, bytes: number): Uint8Array | null {
  if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[0-9a-f]+$/.test(value))
    return null;
  return new Uint8Array(Buffer.from(value, 'hex'));
}

/** 解碼精確的簽署收件匣 wire 形狀，且不接受多餘欄位。 */
export function decodeSignedInboxWire<T>(raw: unknown): SignedPayload<T> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const wire = raw as Record<string, unknown>;
  if (!exactKeys(wire, ['payload', 'timestamp', 'nonceHex', 'signer', 'signatureHex'])) return null;
  if (!Number.isSafeInteger(wire['timestamp']) || typeof wire['signer'] !== 'string') return null;
  const nonce = decodeHex(wire['nonceHex'], NONCE_BYTES);
  const signature = decodeHex(wire['signatureHex'], SIGNATURE_BYTES);
  if (nonce === null || signature === null) return null;
  return {
    payload: wire['payload'] as T,
    timestamp: wire['timestamp'] as number,
    nonce,
    signer: wire['signer'] as PeerId,
    signature: signature as Signature,
  };
}

function isInboxRequestPayload(raw: unknown): raw is DmcaInboxRequestPayload {
  if (typeof raw !== 'object' || raw === null) return false;
  const payload = raw as Record<string, unknown>;
  return (
    exactKeys(payload, ['type', 'providerId', 'subjectPeerId']) &&
    payload['type'] === 'open4wd-provider-dmca-inbox-request' &&
    typeof payload['providerId'] === 'string' &&
    typeof payload['subjectPeerId'] === 'string'
  );
}

/** 建立具重放防護的收件匣簽署與驗證操作。 */
export function createDmcaInboxCrypto(deps: DmcaInboxCryptoDeps): DmcaInboxCrypto {
  const seenNonces = new Map<string, number>();

  const verifySignedRequest = <T>(raw: unknown): SignedPayload<T> | null => {
    const signed = decodeSignedInboxWire<T>(raw);
    if (signed === null) return null;
    const now = deps.now();
    if (Math.abs(now - signed.timestamp) > FRESHNESS_MS || !verifySignedPayload(signed))
      return null;
    for (const [key, seenAt] of seenNonces) {
      if (now - seenAt > FRESHNESS_MS) seenNonces.delete(key);
    }
    const replayKey = `${signed.signer}:${Buffer.from(signed.nonce).toString('hex')}`;
    if (seenNonces.has(replayKey)) return null;
    seenNonces.set(replayKey, now);
    return signed;
  };

  return {
    providerId: deps.providerId,
    verifySignedRequest,

    verifyRequest(raw) {
      const signed = verifySignedRequest<DmcaInboxRequestPayload>(raw);
      if (signed === null || !isInboxRequestPayload(signed.payload)) return null;
      if (signed.payload.providerId !== deps.providerId) return null;
      if (signed.payload.subjectPeerId !== signed.signer) return null;
      return { subjectPeerId: signed.payload.subjectPeerId };
    },

    async signResponse(payload) {
      if (payload.providerId !== deps.providerId) throw new Error('DMCA inbox providerId mismatch');
      const timestamp = deps.now();
      const nonce = deps.randomNonce();
      if (nonce.byteLength !== NONCE_BYTES) throw new Error('DMCA inbox nonce must be 16 bytes');
      const signature = await deps.sign(
        buildSignedMessage(payload, timestamp, nonce, deps.providerId),
      );
      if (signature.byteLength !== SIGNATURE_BYTES)
        throw new Error('DMCA inbox signature must be 64 bytes');
      return {
        payload,
        timestamp,
        nonceHex: Buffer.from(nonce).toString('hex'),
        signer: deps.providerId,
        signatureHex: Buffer.from(signature).toString('hex'),
      };
    },
  };
}
