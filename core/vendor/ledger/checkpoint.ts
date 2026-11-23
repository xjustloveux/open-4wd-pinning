/**
 * 帳本檢查點（≠回合 consensus anchor）純邏輯：治理 signer set quorum、提案節流、hot/cold
 * 分桶、finalize 簽章驗證。提案觸發用**本地時鐘**（提案非 derive；checkpoint
 * timestamp 於提案時 stamp、收件走首播容差驗證）；OrbitDB／IPFS 接線在儲存層（checkpoint-store／ipfs-node）。
 */
import { Protocol } from '@open4wd/system-constants';
import * as dagCbor from '@ipld/dag-cbor';
import { base32 } from 'multiformats/bases/base32';
import { base58btc } from 'multiformats/bases/base58';
import { CID } from 'multiformats/cid';
import type { PeerId, Signature, Timestamp } from '@open4wd/interfaces';
import { peerIdToPublicKey, verifyMessage } from '../key-manager/ed25519';
import { currentHotPartitions, partitionKeyOf, type ColdPartitionKey } from './derive-utils';
import type { MatchRecord } from './derived-state';
import type { LedgerCheckpoint } from './events';
import { ledgerSigningDigest } from './ledger-signing';
import { signingDigest } from './serialize';

const INTERVAL_MS = Protocol.ledger.LEDGER_CHECKPOINT_INTERVAL_HOURS * 60 * 60 * 1000;

/** 社群治理 signer set 下限；另允許初期單一真治理者，N=2 明確非法。 */
export const LEDGER_CHECKPOINT_MIN_SIGNER_SET = 3;
export const LEDGER_CHECKPOINT_MAX_SIGNER_SET = 64;

const UNSIGNED_CHECKPOINT_KEYS = [
  'checkpoint_version',
  'timestamp',
  'log_head_cids',
  'derived_state_cid',
  'previous_checkpoint_cid',
  'signer_set_cid',
  'signer_set_size',
  'quorum',
  'proposer',
] as const;

function exactCid(value: unknown, base: 'entry' | 'content'): boolean {
  if (
    typeof value !== 'string' ||
    (base === 'entry' ? !value.startsWith('z') : !value.startsWith('b'))
  )
    return false;
  try {
    const cid = base === 'entry' ? CID.parse(value, base58btc) : CID.parse(value);
    return (
      cid.version === 1 &&
      cid.code === dagCbor.code &&
      cid.multihash.code === 0x12 &&
      cid.multihash.size === 32 &&
      cid.toString(base === 'entry' ? base58btc : base32) === value
    );
  } catch {
    return false;
  }
}

/** 對外 checkpoint proposal 在 digest/encode/derive 前的固定成本 shape 閘。 */
export function isUnsignedCheckpointShape(
  value: unknown,
): value is Omit<LedgerCheckpoint, 'signatures'> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const checkpoint = value as Record<string, unknown>;
  if (Object.keys(checkpoint).sort().join('\0') !== [...UNSIGNED_CHECKPOINT_KEYS].sort().join('\0'))
    return false;
  const size = checkpoint['signer_set_size'];
  return (
    checkpoint['checkpoint_version'] === 1 &&
    Number.isSafeInteger(checkpoint['timestamp']) &&
    (checkpoint['timestamp'] as number) >= 0 &&
    Array.isArray(checkpoint['log_head_cids']) &&
    checkpoint['log_head_cids'].length > 0 &&
    checkpoint['log_head_cids'].length <= LEDGER_CHECKPOINT_MAX_SIGNER_SET &&
    checkpoint['log_head_cids'].every((cid) => exactCid(cid, 'entry')) &&
    new Set(checkpoint['log_head_cids']).size === checkpoint['log_head_cids'].length &&
    checkpoint['log_head_cids'].every(
      (cid, index, values) => index === 0 || compareEntryCids(values[index - 1], cid) < 0,
    ) &&
    exactCid(checkpoint['derived_state_cid'], 'content') &&
    (checkpoint['previous_checkpoint_cid'] === null ||
      exactCid(checkpoint['previous_checkpoint_cid'], 'content')) &&
    exactCid(checkpoint['signer_set_cid'], 'content') &&
    Number.isSafeInteger(size) &&
    canFinalizeSignerSet(size as number) &&
    (size as number) <= LEDGER_CHECKPOINT_MAX_SIGNER_SET &&
    checkpoint['quorum'] === checkpointQuorum(size as number) &&
    typeof checkpoint['proposer'] === 'string' &&
    peerIdToPublicKey(checkpoint['proposer'] as PeerId) !== null
  );
}

function compareEntryCids(left: unknown, right: unknown): number {
  const leftBytes = CID.parse(left as string, base58btc).bytes;
  const rightBytes = CID.parse(right as string, base58btc).bytes;
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

/** 治理 quorum＝floor(2N/3)+1（賽內 ⌊N/2⌋+1 是另一機制、各管各） */
export function checkpointQuorum(signerSetSize: number): number {
  return Math.floor((2 * signerSetSize) / 3) + 1;
}

/** 判斷 signer set 大小是否足以形成 checkpoint quorum。 */
export function canFinalizeSignerSet(signerSetSize: number): boolean {
  return signerSetSize === 1 || signerSetSize >= LEDGER_CHECKPOINT_MIN_SIGNER_SET;
}

/**
 * 提案節流：本地時鐘 − 上一檢查點 timestamp ≥ 24h 才可提案；reviewAndSign 以同判準
 * 拒簽未滿間隔的提案。並行提案競合由 fork resolution 收斂。
 */
export function shouldProposeCheckpoint(
  lastCheckpointTimestamp: Timestamp,
  localNow: Timestamp,
): boolean {
  return localNow - lastCheckpointTimestamp >= INTERVAL_MS;
}

/**
 * hot/cold 分桶（純函數；在 proposer 階段以 consensusNow 呼叫——apply 階段一律入
 * hot、不查時間）。桶鍵＝finishedAt 的 UTC quarter；落在近 hotMatchQuarters 個
 * quarter 內留 hot，其餘依 quarter 進 cold 桶（後續合併既有 partition、序列化為
 * 獨立 CID 屬 checkpoint-store 儲存層）。
 */
export function bucketMatchesForCold(
  recentMatches: ReadonlyMap<string, MatchRecord>,
  now: Timestamp,
  hotMatchQuarters: number,
): {
  hot: ReadonlyMap<string, MatchRecord>;
  cold: ReadonlyMap<ColdPartitionKey, ReadonlyMap<string, MatchRecord>>;
} {
  const hotKeys = new Set<ColdPartitionKey>(currentHotPartitions(now, hotMatchQuarters));
  const hot = new Map<string, MatchRecord>();
  const cold = new Map<ColdPartitionKey, Map<string, MatchRecord>>();
  for (const [matchId, record] of recentMatches) {
    const key = partitionKeyOf(record.finishedAt);
    if (hotKeys.has(key)) {
      hot.set(matchId, record);
      continue;
    }
    const bucket = cold.get(key) ?? new Map<string, MatchRecord>();
    bucket.set(matchId, record);
    cold.set(key, bucket);
  }
  return { hot, cold };
}

/**
 * finalize 簽章驗證：quorum 欄自洽（＝floor(2N/3)+1 精確等值——canonical 形、
 * 防提案端自報偏門檻）、signer set 只允許 N=1 或 N>=3，且「∈ signer set、不同 signer、
 * 簽章有效」數 ≥ quorum。checkpoint 簽章對 signingDigest(checkpoint 剔 signatures)；
 * LedgerCheckpoint.signatures 為裸簽章（canon）——以 signer set 逐一試配、每
 * signer 至多計一票。
 */
export function validateCheckpointSignatures(
  checkpoint: LedgerCheckpoint,
  signerSet: ReadonlySet<PeerId>,
  ledgerAddress?: string,
): boolean {
  if (!canFinalizeSignerSet(signerSet.size)) return false;
  if (checkpoint.signer_set_size !== signerSet.size) return false;
  if (checkpoint.quorum !== checkpointQuorum(signerSet.size)) return false;

  const canonical = canonicalCheckpointSignatures(
    checkpoint,
    checkpoint.signatures,
    signerSet,
    ledgerAddress,
  );
  if (canonical === null || canonical.length !== checkpoint.signatures.length) return false;
  return canonical.every(
    (signature, index) =>
      signature.length === checkpoint.signatures[index]!.length &&
      signature.every((byte, offset) => byte === checkpoint.signatures[index]![offset]),
  );
}

/** 驗證精確 quorum 裸簽章，依實際匹配 signer PeerId 排序成唯一序列。 */
export function canonicalCheckpointSignatures(
  checkpoint: Omit<LedgerCheckpoint, 'signatures'> | LedgerCheckpoint,
  signatures: readonly Signature[],
  signerSet: ReadonlySet<PeerId>,
  ledgerAddress?: string,
): Signature[] | null {
  const matched = matchCheckpointSignatures(checkpoint, signatures, signerSet, ledgerAddress);
  if (matched === null) return null;
  return [...matched.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, signature]) => signature);
}

/** 回傳實際驗中 checkpoint 的 signer；供 sibling equivocation 證據交集使用。 */
export function checkpointSignatureSigners(
  checkpoint: Omit<LedgerCheckpoint, 'signatures'> | LedgerCheckpoint,
  signatures: readonly Signature[],
  signerSet: ReadonlySet<PeerId>,
  ledgerAddress?: string,
): readonly PeerId[] | null {
  const matched = matchCheckpointSignatures(checkpoint, signatures, signerSet, ledgerAddress);
  if (matched === null) return null;
  return [...matched.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function matchCheckpointSignatures(
  checkpoint: Omit<LedgerCheckpoint, 'signatures'> | LedgerCheckpoint,
  signatures: readonly Signature[],
  signerSet: ReadonlySet<PeerId>,
  ledgerAddress?: string,
): Map<PeerId, Signature> | null {
  if (!canFinalizeSignerSet(signerSet.size) || signerSet.size > LEDGER_CHECKPOINT_MAX_SIGNER_SET)
    return null;
  if (
    checkpoint.signer_set_size !== signerSet.size ||
    checkpoint.quorum !== checkpointQuorum(signerSet.size) ||
    signatures.length !== checkpoint.quorum ||
    signatures.some((signature) => signature.byteLength !== 64)
  )
    return null;
  const digest =
    ledgerAddress === undefined
      ? signingDigest(checkpoint)
      : ledgerSigningDigest(ledgerAddress, checkpoint);
  const publicKeys = new Map<PeerId, Uint8Array>();
  for (const signer of signerSet) {
    const publicKey = peerIdToPublicKey(signer);
    if (publicKey !== null) publicKeys.set(signer, publicKey);
  }

  const matched = new Map<PeerId, Signature>();
  for (const sig of signatures) {
    let matchedSigner: PeerId | null = null;
    for (const [signer, publicKey] of publicKeys) {
      if (matched.has(signer)) continue;
      if (verifyMessage(publicKey, digest, sig)) {
        matchedSigner = signer;
        break;
      }
    }
    if (matchedSigner === null) return null;
    matched.set(matchedSigner, sig);
  }
  if (matched.size !== checkpoint.quorum) return null;
  return matched;
}
