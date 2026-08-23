import * as dagCbor from '@ipld/dag-cbor';
import { sha256 } from '@noble/hashes/sha2.js';
import { base32 } from 'multiformats/bases/base32';
import { CID as MultiformatsCID } from 'multiformats/cid';
import type { CID, PeerId, Timestamp } from '@open4wd/interfaces';
import { lowercaseHex } from '../encoding/bytes';
import { peerIdToPublicKey } from '../key-manager/ed25519';
import { chainIdFromLedgerAddress, type ChainId } from './chain-identity';
import {
  LEDGER_CHECKPOINT_MAX_SIGNER_SET,
  canFinalizeSignerSet,
  validateCheckpointSignatures,
} from './checkpoint';
import { decodeCheckpointBlock } from './checkpoint-store';
import { LEDGER_CONTENT_BLOCK_MAX_BYTES, cidOfDagCborBytes, cidMatchesBytes } from './content-cid';
import type { DerivedState } from './derived-state';
import type { BlockAccess } from './orbit-log';
import {
  LEDGER_COLD_PARTITION_MAX_BYTES,
  LEDGER_DERIVED_STATE_MAX_BYTES,
  LEDGER_SIGNER_SET_MAX_BYTES,
  decodeColdPartition,
  decodeDerivedState,
  decodeSignerSet,
  encodeColdPartition,
  encodeDerivedState,
  encodeSignerSet,
} from './state-codec';

/** Rebirth proof 單次取塊上限；來源可為本機封裝或 pinning network。 */
export const INITIAL_CHECKPOINT_PROOF_FETCH_TIMEOUT_MS = 30_000;
/** 防止惡意 deployment config 以無界 checkpoint chain 佔用啟動時間。 */
export const INITIAL_CHECKPOINT_PROOF_MAX_CHECKPOINTS = 256;
const COMMITMENT_DOMAIN = 'open4wd.initial-checkpoint-proof.v1';
const PROOF_KEYS = [
  'version',
  'sourceLedgerAddress',
  'sourceChainId',
  'sourceGenesisSigners',
  'targetGovernanceSigners',
  'checkpointChainCids',
  'checkpointCid',
  'initialStateCid',
  'derivedStateCid',
  'signerSetCid',
  'sourceCheckpointTimestamp',
  'sourceMinimumCheckpointTimestamp',
  'sourceConfigEpoch',
  'commitment',
] as const;

/** 新鏈 genesis 取得來源信任所需的完整、ceremony-locked 證明描述。 */
export interface InitialCheckpointProof {
  readonly version: 1;
  readonly sourceLedgerAddress: string;
  readonly sourceChainId: ChainId;
  readonly sourceGenesisSigners: readonly PeerId[];
  /** 核准 state 內的新鏈起始治理 authority；deployment governanceSigners 必須同值。 */
  readonly targetGovernanceSigners: readonly PeerId[];
  /** 從來源 genesis 後首個 checkpoint 到核准切點，末項必須等於 checkpointCid。 */
  readonly checkpointChainCids: readonly CID[];
  readonly checkpointCid: CID;
  /** 兩欄必須與核准 checkpoint.derived_state_cid 三方全等。 */
  readonly initialStateCid: CID;
  readonly derivedStateCid: CID;
  /** 核准 checkpoint 實際簽署 authority 的 canonical signer-set CID。 */
  readonly signerSetCid: CID;
  readonly sourceCheckpointTimestamp: Timestamp;
  /** Ceremony 明示的防回退下界；核准 checkpoint 不得更舊。 */
  readonly sourceMinimumCheckpointTimestamp: Timestamp;
  readonly sourceConfigEpoch: number;
  /** 對其餘欄位做 domain-separated canonical DAG-CBOR SHA-256。 */
  readonly commitment: string;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function exactContentCid(value: unknown): value is CID {
  if (typeof value !== 'string' || !value.startsWith('b')) return false;
  try {
    const cid = MultiformatsCID.parse(value);
    return (
      cid.version === 1 &&
      cid.code === dagCbor.code &&
      cid.multihash.code === 0x12 &&
      cid.multihash.size === 32 &&
      cid.toString(base32) === value
    );
  } catch {
    return false;
  }
}

function canonicalSignerList(value: unknown): value is readonly PeerId[] {
  if (
    !Array.isArray(value) ||
    !canFinalizeSignerSet(value.length) ||
    value.length > LEDGER_CHECKPOINT_MAX_SIGNER_SET
  )
    return false;
  return value.every(
    (signer, index) =>
      typeof signer === 'string' &&
      peerIdToPublicKey(signer as PeerId) !== null &&
      (index === 0 || value[index - 1] < signer),
  );
}

function assertProofShape(value: InitialCheckpointProof): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== [...PROOF_KEYS].sort().join('\0') ||
    value.version !== 1 ||
    typeof value.sourceLedgerAddress !== 'string' ||
    typeof value.sourceChainId !== 'string' ||
    !canonicalSignerList(value.sourceGenesisSigners) ||
    !canonicalSignerList(value.targetGovernanceSigners) ||
    !Array.isArray(value.checkpointChainCids) ||
    value.checkpointChainCids.length === 0 ||
    value.checkpointChainCids.length > INITIAL_CHECKPOINT_PROOF_MAX_CHECKPOINTS ||
    value.checkpointChainCids.some((cid) => !exactContentCid(cid)) ||
    new Set(value.checkpointChainCids).size !== value.checkpointChainCids.length ||
    !exactContentCid(value.checkpointCid) ||
    value.checkpointChainCids.at(-1) !== value.checkpointCid ||
    !exactContentCid(value.initialStateCid) ||
    !exactContentCid(value.derivedStateCid) ||
    !exactContentCid(value.signerSetCid) ||
    !Number.isSafeInteger(value.sourceCheckpointTimestamp) ||
    value.sourceCheckpointTimestamp < 0 ||
    !Number.isSafeInteger(value.sourceMinimumCheckpointTimestamp) ||
    value.sourceMinimumCheckpointTimestamp < 0 ||
    !Number.isSafeInteger(value.sourceConfigEpoch) ||
    value.sourceConfigEpoch < 1 ||
    !/^[0-9a-f]{64}$/.test(value.commitment)
  )
    throw new TypeError('invalid initial checkpoint proof shape');
  let sourceChainId: ChainId;
  try {
    sourceChainId = chainIdFromLedgerAddress(value.sourceLedgerAddress);
  } catch {
    throw new TypeError('invalid initial checkpoint proof source ledger');
  }
  if (sourceChainId !== value.sourceChainId)
    throw new TypeError('initial checkpoint proof source chain identity mismatch');
}

/** 計算 proof 的 domain-separated commitment；輸入不得包含 commitment 欄。 */
export function initialCheckpointProofCommitment(
  proof: Omit<InitialCheckpointProof, 'commitment'>,
): string {
  const encoded = dagCbor.encode({ domain: COMMITMENT_DOMAIN, proof });
  const bytes = new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  return lowercaseHex(sha256(bytes));
}

/** 將 deployment／CLI JSON 解析為嚴格 proof descriptor；此步只驗 descriptor、不取塊。 */
export function parseInitialCheckpointProof(value: unknown): InitialCheckpointProof {
  assertProofShape(value as InitialCheckpointProof);
  const proof = value as InitialCheckpointProof;
  const { commitment: _commitment, ...core } = proof;
  void _commitment;
  if (initialCheckpointProofCommitment(core) !== proof.commitment)
    throw new Error('initial checkpoint proof commitment mismatch');
  return proof;
}

async function requireBlock(
  blocks: Pick<BlockAccess, 'get'>,
  cid: CID,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const bytes = await blocks.get(cid, INITIAL_CHECKPOINT_PROOF_FETCH_TIMEOUT_MS, maxBytes);
  if (bytes === null) throw new Error(`initial checkpoint proof ${label} block missing`);
  if (!cidMatchesBytes(cid, bytes))
    throw new Error(`initial checkpoint proof ${label} CID mismatch`);
  return bytes;
}

function sameSigners(left: ReadonlySet<PeerId>, right: readonly PeerId[]): boolean {
  const canonical = [...left].sort();
  return (
    canonical.length === right.length && canonical.every((value, index) => value === right[index])
  );
}

/**
 * 逐代驗來源 checkpoint authority 與所有初始 state 引用；任一缺塊／非 canonical／回退即拒絕。
 * 成功回傳的 state 才可作新鏈 genesis，失敗不得 fallback 至 ordinary empty genesis。
 */
export async function verifyInitialCheckpointProof(
  proof: InitialCheckpointProof,
  blocks: Pick<BlockAccess, 'get'>,
): Promise<DerivedState> {
  proof = parseInitialCheckpointProof(proof);

  let authority: readonly PeerId[] = proof.sourceGenesisSigners;
  let previousCheckpointCid: CID | null = null;
  let previousTimestamp = -1;
  let targetState: DerivedState | null = null;
  let targetSignerSetCid: CID | null = null;

  for (const checkpointCid of proof.checkpointChainCids) {
    const checkpointBytes = await requireBlock(
      blocks,
      checkpointCid,
      LEDGER_CONTENT_BLOCK_MAX_BYTES,
      'checkpoint',
    );
    const checkpoint = decodeCheckpointBlock(checkpointCid, checkpointBytes);
    if (checkpoint.previous_checkpoint_cid !== previousCheckpointCid)
      throw new Error('initial checkpoint proof checkpoint chain is not contiguous');
    if (checkpoint.timestamp <= previousTimestamp)
      throw new Error('initial checkpoint proof checkpoint timestamp is not increasing');

    const signerBytes = await requireBlock(
      blocks,
      checkpoint.signer_set_cid,
      LEDGER_SIGNER_SET_MAX_BYTES,
      'signer set',
    );
    const signerSet = decodeSignerSet(signerBytes);
    if (!sameBytes(signerBytes, encodeSignerSet(signerSet)) || !sameSigners(signerSet, authority))
      throw new Error('initial checkpoint proof signer set is not anchored to source authority');
    if (!validateCheckpointSignatures(checkpoint, new Set(authority), proof.sourceLedgerAddress))
      throw new Error('initial checkpoint proof signature or signer quorum is invalid');

    const stateBytes = await requireBlock(
      blocks,
      checkpoint.derived_state_cid,
      LEDGER_DERIVED_STATE_MAX_BYTES,
      'derived state',
    );
    const state = decodeDerivedState(stateBytes);
    const canonicalState = encodeDerivedState(state);
    if (!sameBytes(stateBytes, canonicalState))
      throw new Error('initial checkpoint proof derived state is not canonical');
    if (state.fromCheckpoint !== checkpoint.previous_checkpoint_cid)
      throw new Error('initial checkpoint proof derived state checkpoint lineage mismatch');

    for (const headCid of checkpoint.log_head_cids)
      await requireBlock(blocks, headCid, LEDGER_CONTENT_BLOCK_MAX_BYTES, 'log head');
    for (const [partitionKey, partitionCid] of state.coldMatchPartitions) {
      const partitionBytes = await requireBlock(
        blocks,
        partitionCid,
        LEDGER_COLD_PARTITION_MAX_BYTES,
        'cold partition',
      );
      const partition = decodeColdPartition(partitionBytes);
      if (
        partition.partitionKey !== partitionKey ||
        !sameBytes(partitionBytes, encodeColdPartition(partition))
      )
        throw new Error('initial checkpoint proof cold partition is not canonical');
    }

    authority = state.economyConfig.governanceSigners;
    if (!canonicalSignerList(authority))
      throw new Error('initial checkpoint proof next governance authority is invalid');
    previousCheckpointCid = checkpointCid;
    previousTimestamp = checkpoint.timestamp;
    targetState = state;
    targetSignerSetCid = checkpoint.signer_set_cid;
  }

  if (
    targetState === null ||
    previousCheckpointCid !== proof.checkpointCid ||
    proof.initialStateCid !== proof.derivedStateCid ||
    proof.derivedStateCid !== cidOfCanonicalState(targetState) ||
    targetSignerSetCid !== proof.signerSetCid ||
    previousTimestamp !== proof.sourceCheckpointTimestamp ||
    previousTimestamp < proof.sourceMinimumCheckpointTimestamp ||
    targetState.economyConfig.epoch !== proof.sourceConfigEpoch ||
    !sameSigners(
      new Set(targetState.economyConfig.governanceSigners),
      proof.targetGovernanceSigners,
    )
  )
    throw new Error('initial checkpoint proof target mismatch or rollback below ceremony minimum');
  return targetState;
}

function cidOfCanonicalState(state: DerivedState): CID {
  return cidOfDagCborBytes(encodeDerivedState(state));
}
