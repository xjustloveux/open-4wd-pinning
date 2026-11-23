/**
 * Seed 加密儲存 — PIN 經 Argon2id 派生金鑰、AES-GCM 加密；私鑰 seed 只以密文落地
 */
import { argon2id } from '@noble/hashes/argon2.js';
import { err, ok, type Result } from '@open4wd/interfaces';

/** PIN 派生 AES key 的版本化 Argon2id 成本參數。 */
export interface Argon2Params {
  algorithm: 'argon2id';
  iterations: number;
  memoryKiB: number;
  parallelism: number;
}

/** 可持久化的 AES-GCM seed 密文與完整 KDF 參數。 */
export interface EncryptedSeed {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  salt: Uint8Array;
  kdfParams: Argon2Params;
  version: 1;
}

/** 64 MiB／3 iter／4 lane——瀏覽器可承受的抗暴力參數 */
export const DEFAULT_ARGON2: Argon2Params = Object.freeze({
  algorithm: 'argon2id',
  iterations: 3,
  memoryKiB: 65536,
  parallelism: 4,
});

async function deriveAesKey(
  pin: string,
  salt: Uint8Array,
  params: Argon2Params,
  usage: KeyUsage,
): Promise<CryptoKey> {
  const derived = argon2id(new TextEncoder().encode(pin), salt, {
    t: params.iterations,
    m: params.memoryKiB,
    p: params.parallelism,
    dkLen: 32,
  });
  const key = await crypto.subtle.importKey(
    'raw',
    derived as BufferSource,
    { name: 'AES-GCM' },
    false,
    [usage],
  );
  derived.fill(0); // KDF 派生鍵已入 CryptoKey——原 bytes 歸零
  return key;
}

/** 使用新 salt、IV 與 PIN 派生 key 加密 master seed。 */
export async function encryptSeed(
  seed: Uint8Array,
  pin: string,
  kdfParams: Argon2Params = DEFAULT_ARGON2,
): Promise<EncryptedSeed> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(pin, salt, kdfParams, 'encrypt');
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      seed as BufferSource,
    ),
  );
  return { ciphertext, iv, salt, kdfParams, version: 1 };
}

/** 使用封存 KDF 參數解密 seed，認證失敗收斂為 invalid-pin。 */
export async function decryptSeed(
  encrypted: EncryptedSeed,
  pin: string,
): Promise<Result<Uint8Array, 'invalid-pin'>> {
  try {
    const key = await deriveAesKey(pin, encrypted.salt, encrypted.kdfParams, 'decrypt');
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: encrypted.iv as BufferSource },
        key,
        encrypted.ciphertext as BufferSource,
      ),
    );
    return ok(plain);
  } catch {
    return err('invalid-pin');
  }
}
