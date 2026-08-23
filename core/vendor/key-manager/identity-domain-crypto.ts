import { sha256 } from '@noble/hashes/sha2.js';
import type { PeerId } from '@open4wd/interfaces';

/** 以身分與 domain 綁定 AAD 的 AES-GCM 密文封裝。 */
export interface SealedIdentityDomain {
  version: 1;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

const encoder = new TextEncoder();
const DOMAIN_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_IDENTITY_DOMAIN_PLAINTEXT_BYTES = 1024 * 1024;
const HKDF_SALT = sha256(encoder.encode('open4wd-identity-container-v1'));

function assertDomain(domain: string): void {
  if (!DOMAIN_PATTERN.test(domain)) throw new Error('Invalid identity data domain');
}

function context(peerId: PeerId, domain: string): { info: Uint8Array; aad: Uint8Array } {
  assertDomain(domain);
  return {
    info: encoder.encode(`open4wd/identity-domain/v1/${peerId}/${domain}`),
    aad: encoder.encode(`open4wd/identity-container/v1/${peerId}/${domain}`),
  };
}

async function deriveDomainKey(
  seed: Uint8Array,
  peerId: PeerId,
  domain: string,
  usage: KeyUsage,
): Promise<{ key: CryptoKey; aad: Uint8Array }> {
  const { info, aad } = context(peerId, domain);
  const material = await crypto.subtle.importKey('raw', seed as BufferSource, 'HKDF', false, [
    'deriveKey',
  ]);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT as BufferSource, info: info as BufferSource },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
  return { key, aad };
}

/** 由 master seed 派生 domain key 並封存受大小限制的 plaintext。 */
export async function sealIdentityDomain(
  seed: Uint8Array,
  peerId: PeerId,
  domain: string,
  plaintext: Uint8Array,
): Promise<SealedIdentityDomain> {
  if (plaintext.byteLength > MAX_IDENTITY_DOMAIN_PLAINTEXT_BYTES)
    throw new Error('Identity data domain is too large');
  const { key, aad } = await deriveDomainKey(seed, peerId, domain, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource },
      key,
      plaintext as BufferSource,
    ),
  );
  return { version: 1, iv, ciphertext };
}

/** 驗證封裝形狀後解開指定身分與 domain 的密文。 */
export async function openIdentityDomain(
  seed: Uint8Array,
  peerId: PeerId,
  domain: string,
  sealed: SealedIdentityDomain,
): Promise<Uint8Array> {
  if (
    sealed.version !== 1 ||
    sealed.iv.byteLength !== 12 ||
    sealed.ciphertext.byteLength < 16 ||
    sealed.ciphertext.byteLength > MAX_IDENTITY_DOMAIN_PLAINTEXT_BYTES + 16
  )
    throw new Error('Invalid sealed identity data domain');
  const { key, aad } = await deriveDomainKey(seed, peerId, domain, 'decrypt');
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: sealed.iv as BufferSource,
        additionalData: aad as BufferSource,
      },
      key,
      sealed.ciphertext as BufferSource,
    ),
  );
}
