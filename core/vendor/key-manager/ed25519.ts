/**
 * Ed25519 簽章與 PeerId 編解碼 — PeerId＝'z'＋base58btc(0xed01 ‖ pubkey)
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import type { KeyPair, PeerId, Signature } from '@open4wd/interfaces';

/** multicodec ed25519-pub 前綴（0xed, 0x01） */
const ED25519_PUB_MULTICODEC = [0xed, 0x01] as const;

/** 從 32-byte seed 決定性派生 Ed25519 公私鑰對。 */
export function deriveKeyPair(seed: Uint8Array): KeyPair {
  return { privateKey: seed, publicKey: ed25519.getPublicKey(seed) };
}

/** 使用 Ed25519 私鑰簽署原始訊息 bytes。 */
export function signMessage(privateKey: Uint8Array, message: Uint8Array): Signature {
  return ed25519.sign(message, privateKey) as Signature;
}

/** 簽章驗證；格式不符（長度非 64、非曲線點等底層拋出）一律視為驗證失敗、不外拋 */
export function verifyMessage(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Signature,
): boolean {
  try {
    // 輸入可能來自跨 realm 位元組（如 dag-cbor 解出的 Buffer 視圖）——重包本 realm 視圖
    // 再進 noble（其位元組驗證比對 realm 內 Uint8Array）
    return ed25519.verify(asRealmBytes(signature), asRealmBytes(message), asRealmBytes(publicKey));
  } catch {
    return false;
  }
}

function asRealmBytes(view: Uint8Array): Uint8Array {
  return view instanceof Uint8Array
    ? view
    : new Uint8Array(
        (view as Uint8Array).buffer,
        (view as Uint8Array).byteOffset,
        (view as Uint8Array).byteLength,
      );
}

/** 將 Ed25519 公鑰編碼為帶 multicodec 前綴的 base58 PeerId。 */
export function publicKeyToPeerId(publicKey: Uint8Array): PeerId {
  const combined = new Uint8Array([...ED25519_PUB_MULTICODEC, ...publicKey]);
  return ('z' + base58.encode(combined)) as PeerId;
}

/** PeerId → 32 bytes 公鑰；格式不符回傳 null（驗章前的防禦解析） */
export function peerIdToPublicKey(peerId: PeerId): Uint8Array | null {
  if (!peerId.startsWith('z')) return null;
  let decoded: Uint8Array;
  try {
    decoded = base58.decode(peerId.slice(1));
  } catch {
    return null;
  }
  if (
    decoded.length !== 34 ||
    decoded[0] !== ED25519_PUB_MULTICODEC[0] ||
    decoded[1] !== ED25519_PUB_MULTICODEC[1]
  ) {
    return null;
  }
  return decoded.slice(2);
}
