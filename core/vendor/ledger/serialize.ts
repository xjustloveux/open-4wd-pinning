/**
 * canonical 序列化與簽章 digest — dag-cbor（RFC 8949 canonical：map 鍵長度＋字典序）
 * 使跨 peer 位元組完全一致；簽章前剔除 signature／signatures 欄位本身。
 * digest＝sha256(serializeForSigning(event))；bytes 進 noble 前零拷貝重包本 realm 視圖
 * （cborg Buffer 快路徑×jsdom realm——見 key-manager/signed-payload 同款處理）。
 */
import * as dagCbor from '@ipld/dag-cbor';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * 可簽章欄位鐵則守門：dag-cbor 會把 JS Map **靜默**編成 CBOR map（decode 回 plain
 * object＝往返不對稱、跨 realm/插入序風險），故任意深度出現 Map/Set 一律拋錯；
 * undefined 由 dag-cbor 自身拒編。
 */
function assertPlainSignable(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') return;
  if (value instanceof Map || value instanceof Set)
    throw new TypeError(`可簽章欄位不得含 Map/Set（${path}）——一律 plain Record/array`);
  if (value instanceof Uint8Array) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertPlainSignable(item, `${path}[${index}]`);
    });
    return;
  }
  for (const [key, child] of Object.entries(value)) assertPlainSignable(child, `${path}.${key}`);
}

/** 將可簽事件正規化並以 canonical DAG-CBOR 序列化。 */
export function serializeForSigning(event: object): Uint8Array {
  const unsigned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event))
    if (key !== 'signature' && key !== 'signatures') unsigned[key] = value;
  assertPlainSignable(unsigned, 'event');
  const encoded = dagCbor.encode(unsigned);
  return new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
}

/** 簽章／驗章共同 digest（32B） */
export function signingDigest(event: object): Uint8Array {
  return sha256(serializeForSigning(event));
}

/**
 * loadout 參與證明的簽章訊息＝綁 matchId（出簽與驗簽同式；ed25519 直簽此位元組）。
 * ⭐綁 matchId 使簽章跨場不可重放：賽後存 MatchResultEvent.loadoutSignatures，收件⓪家族
 * 驗「被列 ranking／disconnects 者確有本場簽章 loadout」——攻擊者偽造不了受害者私鑰簽章、
 * 亦無法把他場簽章挪用（matchId 不同），杜絕憑空自造一場塞任意玩家 disconnects 投毒信譽。
 */
export function loadoutSigningMessage(matchId: string, loadout: object): Uint8Array {
  return serializeForSigning({ type: 'loadout-proof', matchId, loadout });
}
