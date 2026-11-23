/**
 * SignedPayload 簽章封裝 — timestamp 與 nonce 必在簽章涵蓋範圍（防竄改時戳重放）
 * canonical 序列化＝dag-cbor（map 鍵排序、跨 peer 位元組一致）；payload 須為 dag-cbor 可編碼值
 */
import * as dagCbor from '@ipld/dag-cbor';
import { sha256 } from '@noble/hashes/sha2.js';
import type { PeerId, SignedPayload } from '@open4wd/interfaces';
import { peerIdToPublicKey, verifyMessage } from './ed25519';

/** 簽章訊息＝sha256(dagCbor({ nonce, payload, signer, timestamp }))——鍵序由 canonical 編碼決定 */
export function buildSignedMessage(
  payload: unknown,
  timestamp: number,
  nonce: Uint8Array,
  signer: PeerId,
): Uint8Array {
  const encoded = dagCbor.encode({ nonce, payload, signer, timestamp });
  // cborg 在 Buffer 可用時對部分尺寸走 Buffer 快路徑；跨 realm（jsdom 測試）下該
  // Buffer 非本 realm Uint8Array 的 instance、會被 noble 輸入驗證拒絕——零拷貝重包
  return sha256(new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength));
}

/** 驗章不需任何本地身分——公鑰內含於 signer PeerId */
export function verifySignedPayload<T>(signed: SignedPayload<T>): boolean {
  const publicKey = peerIdToPublicKey(signed.signer);
  if (!publicKey) return false;
  const message = buildSignedMessage(signed.payload, signed.timestamp, signed.nonce, signed.signer);
  return verifyMessage(publicKey, message, signed.signature);
}
