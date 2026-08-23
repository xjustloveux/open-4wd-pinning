import { sha256 } from '@noble/hashes/sha2.js';
import { CID as MultiformatsCID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';
import type { CID } from '@open4wd/interfaces';

const DAG_CBOR_CODE = 0x71;
const RAW_CODE = 0x55;
const SHA2_256_CODE = 0x12;

/** 共用 Ledger 內容 block 邊界接受的 byte 長度上限。 */
export const LEDGER_CONTENT_BLOCK_MAX_BYTES = 64 * 1024 * 1024;

function cidOfCodecBytes(codec: number, bytes: Uint8Array): CID {
  const realm = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const digest = Digest.create(SHA2_256_CODE, sha256(realm));
  return MultiformatsCID.createV1(codec, digest).toString() as CID;
}

/** 以 CIDv1(dag-cbor, sha2-256) 定址的 canonical DAG-CBOR bytes。 */
export function cidOfDagCborBytes(bytes: Uint8Array): CID {
  return cidOfCodecBytes(DAG_CBOR_CODE, bytes);
}

/** 以 CIDv1(raw, sha2-256) 定址的不透明 bytes。 */
export function cidOfRawBytes(bytes: Uint8Array): CID {
  return cidOfCodecBytes(RAW_CODE, bytes);
}

/** 依 CID 驗證 bytes，同時保留 CID 宣告的 multicodec。 */
export function cidMatchesBytes(cid: CID, bytes: Uint8Array): boolean {
  try {
    const parsed = MultiformatsCID.parse(cid);
    return parsed.equals(MultiformatsCID.parse(cidOfCodecBytes(parsed.code, bytes)));
  } catch {
    return false;
  }
}
