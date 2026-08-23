import { sha256 } from '@noble/hashes/sha2.js';
import { Protocol } from '@open4wd/system-constants';
import { Entry } from '@orbitdb/core';
import { LEDGER_ENTRY_BLOCK_MAX_BYTES } from './bounded-storage';

const utf8 = new TextEncoder();
const BASE_DOMAIN = utf8.encode('open4wd-ledger-admission-base-entry-v1');
const WORK_DOMAIN = utf8.encode('open4wd-ledger-admission-work-v1');

/** Ledger entry admission PoW 的版本與大小加權參數。 */
export interface LedgerAdmissionScheme {
  readonly version: 1;
  readonly baseBits: number;
  readonly sizeUnitBytes: number;
  readonly maxExtraBits: number;
  readonly nonceBytes: number;
}

/** 由 protocol 常數固定、所有 peers 共用的 admission v1 scheme。 */
export const LEDGER_ADMISSION_V1: LedgerAdmissionScheme = Object.freeze({
  version: Protocol.ledger.LEDGER_ADMISSION_VERSION,
  baseBits: Protocol.ledger.LEDGER_ADMISSION_BASE_BITS,
  sizeUnitBytes: Protocol.ledger.LEDGER_ADMISSION_SIZE_UNIT_BYTES,
  maxExtraBits: Protocol.ledger.LEDGER_ADMISSION_MAX_EXTRA_BITS,
  nonceBytes: Protocol.ledger.LEDGER_ADMISSION_NONCE_BYTES,
});

/** Admission digest 內 canonical Orbit ADD operation。 */
export interface LedgerOrbitOperation {
  readonly op: string;
  readonly key: string | null;
  readonly value: unknown;
}

/** Orbit entry 使用的 Lamport identity 與 time。 */
export interface LedgerOrbitClock {
  readonly id: string;
  readonly time: number;
}

/** 尚未加入 admission proof 的 exact Orbit entry shape。 */
export interface LedgerOrbitBaseEntry {
  readonly id: string;
  readonly payload: LedgerOrbitOperation;
  readonly next: readonly string[];
  readonly refs: readonly string[];
  readonly clock: LedgerOrbitClock;
  readonly v: 2;
  readonly key: string;
  readonly identity: string;
  readonly sig: string;
}

/** 對 base entry digest 達成 required bits 的版本化 nonce。 */
export interface LedgerAdmissionProof {
  readonly version: 1;
  readonly workNonce: Uint8Array;
}

/** 加入 admission proof、可 canonical encode 的完整 Orbit entry。 */
export interface LedgerOrbitEntry extends LedgerOrbitBaseEntry {
  readonly admission: LedgerAdmissionProof;
  readonly hash?: string;
}

/** 已驗 canonical bytes、CID 與 work proof 的 immutable entry。 */
export interface SealedLedgerEntry {
  readonly cid: string;
  readonly bytes: Uint8Array;
  readonly entry: LedgerOrbitEntry & { readonly hash: string };
  readonly parentHashes: readonly string[];
  readonly requiredBits: number;
}

function assertScheme(scheme: LedgerAdmissionScheme): void {
  if (
    scheme.version !== 1 ||
    !Number.isSafeInteger(scheme.baseBits) ||
    scheme.baseBits < 0 ||
    !Number.isSafeInteger(scheme.sizeUnitBytes) ||
    scheme.sizeUnitBytes < 1 ||
    !Number.isSafeInteger(scheme.maxExtraBits) ||
    scheme.maxExtraBits < 0 ||
    scheme.baseBits + scheme.maxExtraBits > 256 ||
    !Number.isSafeInteger(scheme.nonceBytes) ||
    scheme.nonceBytes !== Protocol.ledger.LEDGER_ADMISSION_NONCE_BYTES
  )
    throw new RangeError('invalid ledger Admission scheme');
}

/** 依 canonical base-entry byte 長度計算 admission work bits。 */
export function requiredAdmissionBits(
  length: number,
  scheme: LedgerAdmissionScheme = LEDGER_ADMISSION_V1,
): number {
  assertScheme(scheme);
  if (!Number.isSafeInteger(length) || length < 1 || length > LEDGER_ENTRY_BLOCK_MAX_BYTES)
    throw new RangeError('base entry byte length is outside Admission v1 bounds');
  const units = Math.max(1, Math.ceil(length / scheme.sizeUnitBytes));
  let remaining = units - 1;
  let extraBits = 0;
  while (remaining > 0) {
    extraBits++;
    remaining = Math.floor(remaining / 2);
  }
  return scheme.baseBits + Math.min(scheme.maxExtraBits, extraBits);
}

/** 以版本化 domain 分隔計算 base-entry SHA-256 digest。 */
export function admissionBaseDigest(bytes: Uint8Array): Uint8Array {
  return sha256.create().update(BASE_DOMAIN).update(bytes).digest();
}

/** 將 base digest 與 fixed-size nonce 綁定成 work digest。 */
export function admissionWorkDigest(baseDigest: Uint8Array, nonce: Uint8Array): Uint8Array {
  if (
    baseDigest.byteLength !== 32 ||
    nonce.byteLength !== Protocol.ledger.LEDGER_ADMISSION_NONCE_BYTES
  )
    throw new RangeError('invalid Admission v1 digest or nonce length');
  return sha256.create().update(WORK_DOMAIN).update(baseDigest).update(nonce).digest();
}

/** 以 bit 精度檢查 digest 是否符合 leading-zero work 門檻。 */
export function hasLeadingZeroBits(digest: Uint8Array, bits: number): boolean {
  if (!Number.isSafeInteger(bits) || bits < 0 || bits > digest.byteLength * 8)
    throw new RangeError('invalid leading-zero bit count');
  const wholeBytes = Math.floor(bits / 8);
  for (let index = 0; index < wholeBytes; index++) if (digest[index] !== 0) return false;
  const remainingBits = bits % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (digest[wholeBytes]! & mask) === 0;
}

/** 永久無法藉重試修復的 entry admission 拒絕分類。 */
export type LedgerAdmissionPermanentCode =
  | 'entry-too-large'
  | 'non-canonical-entry'
  | 'cid-mismatch'
  | 'invalid-entry-shape'
  | 'invalid-proof-shape'
  | 'insufficient-work';

/** 帶穩定 permanent code 的 canonical admission failure。 */
export class LedgerAdmissionPermanentError extends Error {
  constructor(readonly code: LedgerAdmissionPermanentCode) {
    super(`ledger Admission rejected: ${code}`);
    this.name = 'LedgerAdmissionPermanentError';
  }
}

const BASE_ENTRY_KEYS = Object.freeze([
  'clock',
  'id',
  'identity',
  'key',
  'next',
  'payload',
  'refs',
  'sig',
  'v',
]);
const FINAL_ENTRY_KEYS = Object.freeze([...BASE_ENTRY_KEYS, 'admission'].sort());
const FINAL_ENTRY_WITH_HASH_KEYS = Object.freeze([...FINAL_ENTRY_KEYS, 'hash'].sort());

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function hasStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

function assertExactBaseEntry(value: unknown): LedgerOrbitBaseEntry {
  if (!isRecord(value) || !hasExactKeys(value, BASE_ENTRY_KEYS))
    throw new LedgerAdmissionPermanentError('invalid-entry-shape');
  const payload = value['payload'];
  const clock = value['clock'];
  if (
    typeof value['id'] !== 'string' ||
    value['id'].length === 0 ||
    !isRecord(payload) ||
    !hasExactKeys(payload, ['key', 'op', 'value']) ||
    payload['op'] !== 'ADD' ||
    payload['key'] !== null ||
    !hasStringArray(value['next']) ||
    !hasStringArray(value['refs']) ||
    !isRecord(clock) ||
    !hasExactKeys(clock, ['id', 'time']) ||
    typeof clock['id'] !== 'string' ||
    clock['id'].length === 0 ||
    !Number.isSafeInteger(clock['time']) ||
    (clock['time'] as number) < 0 ||
    value['v'] !== 2 ||
    typeof value['key'] !== 'string' ||
    value['key'].length === 0 ||
    typeof value['identity'] !== 'string' ||
    value['identity'].length === 0 ||
    typeof value['sig'] !== 'string' ||
    value['sig'].length === 0
  )
    throw new LedgerAdmissionPermanentError('invalid-entry-shape');
  return value as unknown as LedgerOrbitBaseEntry;
}

function baseEntryFromFinal(value: Record<string, unknown>): LedgerOrbitBaseEntry {
  return assertExactBaseEntry({
    id: value['id'],
    payload: value['payload'],
    next: value['next'],
    refs: value['refs'],
    clock: value['clock'],
    v: value['v'],
    key: value['key'],
    identity: value['identity'],
    sig: value['sig'],
  });
}

function assertExactFinalEntry(
  value: unknown,
  scheme: LedgerAdmissionScheme,
): LedgerOrbitEntry & { readonly hash?: string } {
  if (!isRecord(value)) throw new LedgerAdmissionPermanentError('invalid-entry-shape');
  const admission = value['admission'];
  if (
    !isRecord(admission) ||
    !hasExactKeys(admission, ['version', 'workNonce']) ||
    admission['version'] !== scheme.version ||
    !(admission['workNonce'] instanceof Uint8Array) ||
    admission['workNonce'].byteLength !== scheme.nonceBytes
  )
    throw new LedgerAdmissionPermanentError('invalid-proof-shape');
  const expectedKeys = 'hash' in value ? FINAL_ENTRY_WITH_HASH_KEYS : FINAL_ENTRY_KEYS;
  if (!hasExactKeys(value, expectedKeys))
    throw new LedgerAdmissionPermanentError('invalid-entry-shape');
  if ('hash' in value && (typeof value['hash'] !== 'string' || value['hash'].length === 0))
    throw new LedgerAdmissionPermanentError('invalid-entry-shape');
  baseEntryFromFinal(value);
  return value as unknown as LedgerOrbitEntry & { readonly hash?: string };
}

interface ValidatedProof {
  readonly entry: LedgerOrbitEntry & { readonly hash?: string };
  readonly baseEntry: LedgerOrbitBaseEntry;
  readonly baseBytes: Uint8Array;
  readonly requiredBits: number;
}

async function validateDecodedProof(
  value: unknown,
  scheme: LedgerAdmissionScheme,
): Promise<ValidatedProof> {
  assertScheme(scheme);
  const entry = assertExactFinalEntry(value, scheme);
  const baseEntry = baseEntryFromFinal(entry as unknown as Record<string, unknown>);
  const base = await Entry.encode(baseEntry);
  const requiredBits = requiredAdmissionBits(base.bytes.byteLength, scheme);
  const digest = admissionWorkDigest(admissionBaseDigest(base.bytes), entry.admission.workNonce);
  if (!hasLeadingZeroBits(digest, requiredBits))
    throw new LedgerAdmissionPermanentError('insufficient-work');
  return { entry, baseEntry, baseBytes: base.bytes, requiredBits };
}

/** 驗證已 decode entry 並將失敗收斂為 permanent code。 */
export async function ledgerEntryAdmissionFailure(
  entry: unknown,
  scheme: LedgerAdmissionScheme = LEDGER_ADMISSION_V1,
): Promise<LedgerAdmissionPermanentCode | null> {
  try {
    await validateDecodedProof(entry, scheme);
    return null;
  } catch (cause) {
    if (cause instanceof LedgerAdmissionPermanentError) return cause.code;
    return 'invalid-entry-shape';
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

/** 驗證 untrusted bytes 的大小、canonical encoding、CID 與 PoW proof。 */
export async function validateCanonicalLedgerEntryBytes(
  bytes: Uint8Array,
  expectedCid: string,
  scheme: LedgerAdmissionScheme = LEDGER_ADMISSION_V1,
): Promise<SealedLedgerEntry> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > LEDGER_ENTRY_BLOCK_MAX_BYTES)
    throw new LedgerAdmissionPermanentError('entry-too-large');
  let decoded: unknown;
  try {
    decoded = await Entry.decode(bytes);
  } catch {
    throw new LedgerAdmissionPermanentError('non-canonical-entry');
  }
  const validated = await validateDecodedProof(decoded, scheme);
  let canonical: Awaited<ReturnType<typeof Entry.encode>>;
  try {
    canonical = await Entry.encode(validated.entry);
  } catch {
    throw new LedgerAdmissionPermanentError('non-canonical-entry');
  }
  if (!sameBytes(canonical.bytes, bytes))
    throw new LedgerAdmissionPermanentError('non-canonical-entry');
  if (canonical.hash !== expectedCid) throw new LedgerAdmissionPermanentError('cid-mismatch');
  const entry = { ...validated.entry, hash: canonical.hash } as LedgerOrbitEntry & {
    readonly hash: string;
  };
  return Object.freeze({
    cid: canonical.hash,
    bytes,
    entry,
    parentHashes: Object.freeze([...validated.baseEntry.next, ...validated.baseEntry.refs]),
    requiredBits: validated.requiredBits,
  });
}

/** 將已簽 base entry 與合格 nonce 編碼成 canonical sealed entry。 */
export async function sealLedgerEntry(
  baseEntry: LedgerOrbitBaseEntry,
  nonce: Uint8Array,
  scheme: LedgerAdmissionScheme = LEDGER_ADMISSION_V1,
): Promise<SealedLedgerEntry> {
  assertScheme(scheme);
  if (nonce.byteLength !== scheme.nonceBytes)
    throw new LedgerAdmissionPermanentError('invalid-proof-shape');
  const exactBaseEntry = assertExactBaseEntry(baseEntry);
  const base = await Entry.encode(exactBaseEntry);
  const requiredBits = requiredAdmissionBits(base.bytes.byteLength, scheme);
  const digest = admissionWorkDigest(admissionBaseDigest(base.bytes), nonce);
  if (!hasLeadingZeroBits(digest, requiredBits))
    throw new LedgerAdmissionPermanentError('insufficient-work');
  const entry: LedgerOrbitEntry = {
    ...exactBaseEntry,
    admission: { version: 1, workNonce: nonce.slice() },
  };
  const encoded = await Entry.encode(entry);
  const sealedEntry = { ...entry, hash: encoded.hash };
  return Object.freeze({
    cid: encoded.hash,
    bytes: encoded.bytes,
    entry: sealedEntry,
    parentHashes: Object.freeze([...exactBaseEntry.next, ...exactBaseEntry.refs]),
    requiredBits,
  });
}
