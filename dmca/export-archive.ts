import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { NoticeRecord } from './types';

const MAGIC = Buffer.from('O4WDDMCA', 'ascii');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const MAX_HEADER_BYTES = 4096;

/** 定義加密 DMCA 匯出檔前置保存的已驗證中繼資料。 */
export interface DmcaEncryptedExportHeaderV1 {
  readonly format: 'open4wd-dmca-export';
  readonly version: 1;
  readonly kdf: 'scrypt';
  readonly cipher: 'aes-256-gcm';
  readonly saltHex: string;
  readonly ivHex: string;
  readonly authTagHex: string;
}

/** 包含加密封存位元組與解密所需的標頭。 */
export interface DmcaEncryptedExportPayloadV1 {
  readonly providerId: string;
  readonly exportedAt: number;
  readonly records: readonly NoticeRecord[];
}

type HeaderWithoutTag = Omit<DmcaEncryptedExportHeaderV1, 'authTagHex'>;

const headerWithoutTag = (saltHex: string, ivHex: string): HeaderWithoutTag => ({
  format: 'open4wd-dmca-export',
  version: 1,
  kdf: 'scrypt',
  cipher: 'aes-256-gcm',
  saltHex,
  ivHex,
});

const aadFor = (header: HeaderWithoutTag): Buffer => Buffer.from(JSON.stringify(header), 'utf8');

/** 使用營運者密碼與驗證中繼資料加密 DMCA 封存。 */
export function encryptDmcaExport(
  passphraseInput: string,
  payload: DmcaEncryptedExportPayloadV1,
): Uint8Array {
  if (passphraseInput.trim() === '') throw new TypeError('export passphrase must not be blank');
  if (payload.providerId.trim() === '' || !Number.isSafeInteger(payload.exportedAt)) {
    throw new TypeError('export payload metadata is invalid');
  }
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const publicHeader = headerWithoutTag(salt.toString('hex'), iv.toString('hex'));
  const key = scryptSync(passphraseInput, salt, KEY_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadFor(publicHeader));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  key.fill(0);
  const header: DmcaEncryptedExportHeaderV1 = {
    ...publicHeader,
    authTagHex: cipher.getAuthTag().toString('hex'),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(headerBytes.byteLength);
  return new Uint8Array(Buffer.concat([MAGIC, length, headerBytes, ciphertext]));
}

/** 驗證並解密先前匯出的 DMCA 封存。 */
export function decryptDmcaExport(
  passphraseInput: string,
  archive: Uint8Array,
): DmcaEncryptedExportPayloadV1 {
  const bytes = Buffer.from(archive);
  if (bytes.byteLength < MAGIC.byteLength + 4 || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('invalid DMCA export archive');
  }
  const headerLength = bytes.readUInt32BE(MAGIC.length);
  const headerStart = MAGIC.length + 4;
  const ciphertextStart = headerStart + headerLength;
  if (
    headerLength === 0 ||
    headerLength > MAX_HEADER_BYTES ||
    ciphertextStart >= bytes.byteLength
  ) {
    throw new Error('invalid DMCA export archive');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.subarray(headerStart, ciphertextStart).toString('utf8'));
  } catch {
    throw new Error('invalid DMCA export archive');
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('invalid DMCA export archive');
  const header = raw as Record<string, unknown>;
  const keys = Object.keys(header).sort();
  if (
    keys.join(',') !== 'authTagHex,cipher,format,ivHex,kdf,saltHex,version' ||
    header['format'] !== 'open4wd-dmca-export' ||
    header['version'] !== 1 ||
    header['kdf'] !== 'scrypt' ||
    header['cipher'] !== 'aes-256-gcm' ||
    typeof header['saltHex'] !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(header['saltHex']) ||
    typeof header['ivHex'] !== 'string' ||
    !/^[0-9a-f]{24}$/u.test(header['ivHex']) ||
    typeof header['authTagHex'] !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(header['authTagHex'])
  ) {
    throw new Error('invalid DMCA export archive');
  }
  const salt = Buffer.from(header['saltHex'], 'hex');
  const iv = Buffer.from(header['ivHex'], 'hex');
  const key = scryptSync(passphraseInput, salt, KEY_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aadFor(headerWithoutTag(header['saltHex'], header['ivHex'])));
  decipher.setAuthTag(Buffer.from(header['authTagHex'], 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(bytes.subarray(ciphertextStart)),
    decipher.final(),
  ]);
  key.fill(0);
  const payload = JSON.parse(plaintext.toString('utf8')) as DmcaEncryptedExportPayloadV1;
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof payload.providerId !== 'string' ||
    payload.providerId.trim() === '' ||
    !Number.isSafeInteger(payload.exportedAt) ||
    !Array.isArray(payload.records)
  ) {
    throw new Error('invalid DMCA export payload');
  }
  return payload;
}

/** 僅在目的地尚不存在時寫入加密匯出檔。 */
export function writeDmcaExportExclusive(path: string, bytes: Uint8Array): void {
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
}
