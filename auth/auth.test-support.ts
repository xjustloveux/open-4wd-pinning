/**
 * 測試專用簽章輔助——僅供 auth 目錄下的 *.spec.ts 使用，不是對外 API（不從 index.ts 匯出）。
 *
 * 金鑰生成與原始簽章運算改用 @noble/curves 直接進行——這段是通用 Ed25519 曲線數學，任何正確
 * 實作彼此天生位元組相容，不需要刻意共用「同一顆函式」。真正需要位元組相容保證的是「簽的究竟是
 * 哪些 bytes」，也就是把 nonce／payload／signer／timestamp 組成待簽訊息的 dag-cbor 編碼順序——
 * 這一段本檔嚴格重用 vendored 的同一顆訊息組裝函式、不自行重建，讓測試通過本身就是「本模組的
 * 驗證邏輯與簽署端的簽章邏輯位元組相容」的直接證明。
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import type { PeerId } from '../core';
import { Protocol, buildSignedMessage, publicKeyToPeerId } from '../core';
import type { PinPayload, UnpinPayload } from './signed-request';

export interface TestSigner {
  readonly peerId: PeerId;
  readonly privateKey: Uint8Array;
}

export interface SignedBody {
  readonly payload: PinPayload | UnpinPayload;
  readonly timestamp: number;
  readonly nonce: Uint8Array;
  readonly signer: PeerId;
  readonly signature: Uint8Array;
}

/** 以固定 seed 決定性衍生一把測試用 Ed25519 金鑰；同一 seed 恆回同一身分，方便測試斷言重現。 */
export async function makeSigner(seed: number): Promise<TestSigner> {
  const privateKey = new Uint8Array(32).fill(seed);
  const publicKey = ed25519.getPublicKey(privateKey);
  return { peerId: publicKeyToPeerId(publicKey), privateKey };
}

/**
 * 簽出一筆 pin／unpin 請求 body（欄位已是結構化型別，不是 wire bytes）。
 *
 * @param signer 簽署者（makeSigner 產物）。
 * @param payload pin 或 unpin payload。
 * @param timestamp 簽章時戳（ms epoch）。
 * @param reuseNonce 指定既有 nonce bytes（用於重現「不同 signer 共用同一 nonce」的情境）；
 *   省略則隨機產生。
 */
export async function signPinBody(
  signer: TestSigner,
  payload: PinPayload | UnpinPayload,
  timestamp: number,
  reuseNonce?: Uint8Array,
): Promise<SignedBody> {
  const nonce =
    reuseNonce ?? crypto.getRandomValues(new Uint8Array(Protocol.security.P2P_MESSAGE_NONCE_BYTES));
  const message = buildSignedMessage(payload, timestamp, nonce, signer.peerId);
  const signature = ed25519.sign(message, signer.privateKey);
  return { payload, timestamp, nonce, signer: signer.peerId, signature };
}
