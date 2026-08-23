/**
 * 僅帳本使用的簽章 domain。與 serialize.ts 分離，可防止非帳本 protocol
 * （signaling／register、房間 proof、視覺 hash）取得 chain identity 相依。
 */
import * as dagCbor from '@ipld/dag-cbor';
import { sha256 } from '@noble/hashes/sha2.js';
import { chainIdFromLedgerAddress } from './chain-identity';
import { serializeForSigning } from './serialize';

const LEDGER_SIGNATURE_DOMAIN = 'open4wd-ledger-signature-v1';
const LEDGER_SIGNED_INTENT_DOMAIN = 'open4wd-ledger-signed-intent-v1';

/** 將 exact ledger address 與 canonical event bytes 綁定成簽章 digest。 */
export function ledgerSigningDigest(ledgerAddress: string, event: object): Uint8Array {
  const encoded = dagCbor.encode({
    domain: LEDGER_SIGNATURE_DOMAIN,
    chainId: chainIdFromLedgerAddress(ledgerAddress),
    payload: serializeForSigning(event),
  });
  return sha256(new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength));
}

/**
 * 由 canonical unsigned payload 與其單簽組成穩定意圖摘要。簽章本身已覆蓋 ledger
 * chain identity，因此摘要不必接觸 Orbit entry 的 parents、clock 或 admission proof，
 * 同一已簽 payload 被包進不同 entry 時仍得到同一鍵。
 */
export function ledgerSignedIntentDigest(event: object & { signature: Uint8Array }): Uint8Array {
  const encoded = dagCbor.encode({
    domain: LEDGER_SIGNED_INTENT_DOMAIN,
    payload: serializeForSigning(event),
    signature: event.signature,
  });
  return sha256(new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength));
}
