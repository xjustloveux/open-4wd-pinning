/**
 * 帳本檢查點永留儲存（canon：checkpoint＋簽章**永遠保留**、獨立 LevelStorage、
 * 不走 LRU——否則新玩家無法驗 derived state）。瀏覽器 level→browser-level＝
 * IndexedDB；測試注入 MemoryStorage。鏈狀歷史以 previous_checkpoint_cid 回走。
 */
import * as dagCbor from '@ipld/dag-cbor';
import { base32 } from 'multiformats/bases/base32';
import { base58btc } from 'multiformats/bases/base58';
import { CID as MultiformatsCID } from 'multiformats/cid';
import type { CID, PeerId } from '@open4wd/interfaces';
import { peerIdToPublicKey } from '../key-manager/ed25519';
import type { LedgerCheckpoint } from './events';
import { checkpointQuorum, canFinalizeSignerSet } from './checkpoint';
import type { ChainId } from './chain-identity';
import { cidOfBytes } from './state-codec';

/**
 * 內容塊儲存協定子集。control envelope 不得只靠 `get` 後 `put`。
 */
export interface CheckpointStorage {
  put(key: string, value: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  close?(): Promise<void>;
}

/**
 * Checkpoint control 的持久化線性化點。實作必須在單一原子 transaction 內比對
 * `expectedValue` 與目前 bytes，僅相等時寫入 `nextValue`。
 */
export interface CheckpointControlStorage extends CheckpointStorage {
  compareAndSwap(
    key: string,
    expectedValue: Uint8Array | undefined,
    nextValue: Uint8Array,
  ): Promise<boolean>;
}

const CONTROL_KEY = '__control_v1__';
/** 單一 canonical checkpoint content block 的 byte 上限。 */
export const LEDGER_CHECKPOINT_MAX_BYTES = 32 * 1024;
/** Checkpoint signer set 與 signatures 的人數上限。 */
export const LEDGER_CHECKPOINT_MAX_SIGNATURES = 64;
/** 防止循環或惡意長鏈的 checkpoint history traversal 上限。 */
export const LEDGER_CHECKPOINT_HISTORY_MAX = 10_000;
/** Conflict evidence content block 的 byte 上限。 */
export const LEDGER_CHECKPOINT_CONFLICT_MAX_BYTES = 16 * 1024;
const CHECKPOINT_KEYS = [
  'checkpoint_version',
  'timestamp',
  'log_head_cids',
  'derived_state_cid',
  'previous_checkpoint_cid',
  'signer_set_cid',
  'signer_set_size',
  'quorum',
  'proposer',
  'signatures',
] as const;

function isContentCid(value: unknown): value is CID {
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

function isEntryHash(value: unknown): value is CID {
  if (typeof value !== 'string' || !value.startsWith('z')) return false;
  try {
    const cid = MultiformatsCID.parse(value, base58btc);
    return (
      cid.version === 1 &&
      cid.code === dagCbor.code &&
      cid.multihash.code === 0x12 &&
      cid.multihash.size === 32 &&
      cid.toString(base58btc) === value
    );
  } catch {
    return false;
  }
}

function assertCheckpointShape(value: unknown): asserts value is LedgerCheckpoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('invalid checkpoint shape');
  const checkpoint = value as Record<string, unknown>;
  if (Object.keys(checkpoint).sort().join('\0') !== [...CHECKPOINT_KEYS].sort().join('\0'))
    throw new Error('invalid checkpoint shape');
  const size = checkpoint['signer_set_size'];
  const signatures = checkpoint['signatures'];
  if (
    checkpoint['checkpoint_version'] !== 1 ||
    !Number.isSafeInteger(checkpoint['timestamp']) ||
    (checkpoint['timestamp'] as number) < 0 ||
    !Array.isArray(checkpoint['log_head_cids']) ||
    checkpoint['log_head_cids'].length === 0 ||
    checkpoint['log_head_cids'].length > 64 ||
    checkpoint['log_head_cids'].some((cid) => !isEntryHash(cid)) ||
    new Set(checkpoint['log_head_cids']).size !== checkpoint['log_head_cids'].length ||
    checkpoint['log_head_cids'].some(
      (cid, index, values) => index > 0 && compareEntryCids(values[index - 1], cid) >= 0,
    ) ||
    !isContentCid(checkpoint['derived_state_cid']) ||
    !(
      checkpoint['previous_checkpoint_cid'] === null ||
      isContentCid(checkpoint['previous_checkpoint_cid'])
    ) ||
    !isContentCid(checkpoint['signer_set_cid']) ||
    !Number.isSafeInteger(size) ||
    !canFinalizeSignerSet(size as number) ||
    (size as number) > LEDGER_CHECKPOINT_MAX_SIGNATURES ||
    checkpoint['quorum'] !== checkpointQuorum(size as number) ||
    typeof checkpoint['proposer'] !== 'string' ||
    peerIdToPublicKey(checkpoint['proposer'] as PeerId) === null ||
    !Array.isArray(signatures) ||
    signatures.length !== checkpoint['quorum'] ||
    signatures.length > LEDGER_CHECKPOINT_MAX_SIGNATURES ||
    signatures.some(
      (signature) => !(signature instanceof Uint8Array) || signature.byteLength !== 64,
    )
  )
    throw new Error('invalid checkpoint shape');
}

function compareEntryCids(left: unknown, right: unknown): number {
  const leftBytes = MultiformatsCID.parse(left as string, base58btc).bytes;
  const rightBytes = MultiformatsCID.parse(right as string, base58btc).bytes;
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function encodeCheckpoint(checkpoint: LedgerCheckpoint): Uint8Array {
  assertCheckpointShape(checkpoint);
  const encoded = dagCbor.encode(checkpoint);
  const bytes = new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  if (bytes.byteLength > LEDGER_CHECKPOINT_MAX_BYTES)
    throw new RangeError('checkpoint block too large');
  return bytes;
}

/** untrusted content block 固定上限、exact CID、canonical CBOR 與完整 shape 閘；不落盤。 */
export function decodeCheckpointBlock(cid: CID, bytes: Uint8Array): LedgerCheckpoint {
  if (bytes.byteLength > LEDGER_CHECKPOINT_MAX_BYTES)
    throw new RangeError('checkpoint block too large');
  if (cidOfBytes(bytes) !== cid) throw new Error('checkpoint CID mismatch');
  const decoded = dagCbor.decode(bytes);
  assertCheckpointShape(decoded);
  const canonical = encodeCheckpoint(decoded);
  if (
    canonical.byteLength !== bytes.byteLength ||
    !canonical.every((byte, index) => byte === bytes[index])
  )
    throw new Error('checkpoint block is not canonical');
  return decoded;
}

/** 永留 checkpoint blocks 與原子 control envelope 的持久化契約。 */
export interface CheckpointStore {
  save(cid: CID, checkpoint: LedgerCheckpoint): Promise<void>;
  load(cid: CID): Promise<LedgerCheckpoint | null>;
  setLatest(cid: CID, expectedRevision: number): Promise<number>;
  /** conflict quarantine 時切回 last common checkpoint；null＝genesis。 */
  setEffectiveLatest(cid: CID | null, expectedRevision: number): Promise<number>;
  getLatest(): Promise<{ cid: CID; checkpoint: LedgerCheckpoint } | null>;
  /** 單一 durable control envelope 的 CAS epoch。 */
  getRevision(): Promise<number>;
  /** 邊界前 pointer 的 redo journal。 */
  beginBoundaryAdvance(cid: CID, expectedRevision: number): Promise<number>;
  getPendingBoundaryAdvance(): Promise<{ cid: CID; checkpoint: LedgerCheckpoint } | null>;
  completeBoundaryAdvance(cid: CID, expectedRevision: number): Promise<number>;
  recordConflict(evidence: CheckpointConflictEvidence, expectedRevision: number): Promise<number>;
  getConflict(): Promise<CheckpointConflictEvidence | null>;
  /** 由最新往回走鏈（最新在前）；limit 上限 */
  history(limit: number): Promise<LedgerCheckpoint[]>;
  close(): Promise<void>;
}

/** 同一 previous checkpoint 的互斥 candidates 與已驗 signer sets 證據。 */
export interface CheckpointConflictEvidence {
  previousCheckpointCid: CID | null;
  candidateCids: readonly CID[];
  /** 每個 candidate 已驗證的完整治理 signer set；可為互斥集合。 */
  verifiedSignerSets: readonly {
    checkpointCid: CID;
    signerSetCid: CID;
    signers: readonly PeerId[];
  }[];
  equivocatedSigners: readonly PeerId[];
}

interface CheckpointControl {
  version: 1;
  revision: number;
  latest: CID | null;
  effective: CID | null;
  conflictEvidenceCid: CID | null;
  journal: CID | null;
}

const CONTROL_KEYS = [
  'version',
  'revision',
  'latest',
  'effective',
  'conflictEvidenceCid',
  'journal',
] as const;

const EMPTY_CONTROL: CheckpointControl = {
  version: 1,
  revision: 0,
  latest: null,
  effective: null,
  conflictEvidenceCid: null,
  journal: null,
};

/** 建立具 CAS control、redo journal 與 conflict quarantine 的 checkpoint store。 */
export async function createCheckpointStore(
  options: {
    storage?: CheckpointStorage & Partial<CheckpointControlStorage>;
    chainId?: ChainId;
  } = {},
): Promise<CheckpointStore> {
  const storage = options.storage;
  if (storage === undefined || typeof storage.compareAndSwap !== 'function')
    throw new Error('atomic checkpoint control CAS storage is required');
  const controlStorage = storage as CheckpointControlStorage;
  const controlKey =
    options.chainId === undefined ? CONTROL_KEY : `${CONTROL_KEY}:${options.chainId}`;

  const encodeControl = (control: CheckpointControl): Uint8Array => {
    if (
      Object.keys(control).sort().join('\0') !== [...CONTROL_KEYS].sort().join('\0') ||
      control.version !== 1 ||
      !Number.isSafeInteger(control.revision) ||
      control.revision < 0 ||
      !(control.latest === null || isContentCid(control.latest)) ||
      !(control.effective === null || isContentCid(control.effective)) ||
      !(control.conflictEvidenceCid === null || isContentCid(control.conflictEvidenceCid)) ||
      !(control.journal === null || isContentCid(control.journal))
    )
      throw new Error('invalid checkpoint control');
    const encoded = dagCbor.encode(control);
    return new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  };

  const readControlSnapshot = async (): Promise<{
    control: CheckpointControl;
    bytes: Uint8Array | undefined;
  }> => {
    const bytes = await storage.get(controlKey);
    if (bytes === undefined) return { control: { ...EMPTY_CONTROL }, bytes: undefined };
    const value = dagCbor.decode(bytes);
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error('invalid checkpoint control');
    const control = value as CheckpointControl;
    const canonical = encodeControl(control);
    if (
      canonical.byteLength !== bytes.byteLength ||
      !canonical.every((byte, index) => byte === bytes[index])
    )
      throw new Error('checkpoint control is not canonical');
    return { control, bytes: new Uint8Array(bytes) };
  };

  const readControl = async (): Promise<CheckpointControl> => (await readControlSnapshot()).control;

  const getRevision = async (): Promise<number> => (await readControl()).revision;

  const replaceControl = async (
    expectedRevision: number,
    update: (current: CheckpointControl, nextRevision: number) => CheckpointControl,
    alreadyApplied: (current: CheckpointControl) => boolean,
  ): Promise<number> => {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new RangeError('invalid expected checkpoint revision');
    const snapshot = await readControlSnapshot();
    const current = snapshot.control;
    if (current.revision !== expectedRevision) {
      if (alreadyApplied(current)) return current.revision;
      throw new Error('checkpoint store revision mismatch');
    }
    const nextRevision = current.revision + 1;
    if (!Number.isSafeInteger(nextRevision))
      throw new RangeError('checkpoint store revision exhausted');
    const next = update(current, nextRevision);
    const swapped = await controlStorage.compareAndSwap(
      controlKey,
      snapshot.bytes,
      encodeControl(next),
    );
    if (swapped) return nextRevision;
    const committed = await readControl();
    if (alreadyApplied(committed)) return committed.revision;
    throw new Error('checkpoint store revision mismatch');
  };

  const save = async (cid: CID, checkpoint: LedgerCheckpoint): Promise<void> => {
    const bytes = encodeCheckpoint(checkpoint);
    if (cidOfBytes(bytes) !== cid) throw new Error('checkpoint CID mismatch');
    await storage.put(cid, bytes);
  };

  const load = async (cid: CID): Promise<LedgerCheckpoint | null> => {
    const bytes = await storage.get(cid);
    if (bytes === undefined) return null;
    return decodeCheckpointBlock(cid, bytes);
  };

  const setLatest = async (cid: CID, expectedRevision: number): Promise<number> => {
    if (!isContentCid(cid)) throw new Error('invalid latest checkpoint CID');
    if ((await load(cid)) === null) throw new Error('latest checkpoint is not saved');
    return replaceControl(
      expectedRevision,
      (current, revision) => {
        if (current.conflictEvidenceCid !== null)
          throw new Error('checkpoint conflict quarantine is active');
        return { ...current, revision, latest: cid, effective: cid };
      },
      (current) => current.latest === cid && current.effective === cid,
    );
  };

  const setEffectiveLatest = async (cid: CID | null, expectedRevision: number): Promise<number> => {
    if (cid !== null && (await load(cid)) === null)
      throw new Error('effective checkpoint is not saved');
    return replaceControl(
      expectedRevision,
      (current, revision) => {
        if (current.conflictEvidenceCid !== null && current.effective !== cid)
          throw new Error('checkpoint conflict quarantine is active');
        return { ...current, revision, effective: cid };
      },
      (current) => current.effective === cid,
    );
  };

  const getLatest = async (): Promise<{ cid: CID; checkpoint: LedgerCheckpoint } | null> => {
    const cid = (await readControl()).effective;
    if (cid === null) return null;
    const checkpoint = await load(cid);
    if (checkpoint === null) throw new Error('dangling latest checkpoint pointer');
    return { cid, checkpoint };
  };

  const beginBoundaryAdvance = async (cid: CID, expectedRevision: number): Promise<number> => {
    if ((await load(cid)) === null) throw new Error('boundary journal checkpoint is not saved');
    return replaceControl(
      expectedRevision,
      (current, revision) => {
        if (current.conflictEvidenceCid !== null)
          throw new Error('checkpoint conflict quarantine is active');
        return { ...current, revision, journal: cid };
      },
      (current) => current.journal === cid,
    );
  };

  const getPendingBoundaryAdvance = async (): Promise<{
    cid: CID;
    checkpoint: LedgerCheckpoint;
  } | null> => {
    const cid = (await readControl()).journal;
    if (cid === null) return null;
    const checkpoint = await load(cid);
    if (checkpoint === null) throw new Error('dangling boundary journal checkpoint');
    return { cid, checkpoint };
  };

  const completeBoundaryAdvance = async (cid: CID, expectedRevision: number): Promise<number> => {
    const current = await readControl();
    if (current.journal !== cid) {
      if (current.journal === null && current.latest === cid) return current.revision;
      throw new Error('boundary journal completion mismatch');
    }
    return replaceControl(
      expectedRevision,
      (control, revision) => ({ ...control, revision, journal: null }),
      (control) => control.journal === null && control.latest === cid,
    );
  };

  const history = async (limit: number): Promise<LedgerCheckpoint[]> => {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > LEDGER_CHECKPOINT_HISTORY_MAX)
      throw new RangeError('invalid checkpoint history limit');
    const chain: LedgerCheckpoint[] = [];
    const visited = new Set<CID>();
    let cursor = (await getLatest())?.checkpoint ?? null;
    while (cursor !== null && chain.length < limit) {
      chain.push(cursor);
      if (cursor.previous_checkpoint_cid === null) cursor = null;
      else {
        if (visited.has(cursor.previous_checkpoint_cid))
          throw new Error('checkpoint history cycle detected');
        visited.add(cursor.previous_checkpoint_cid);
        cursor = await load(cursor.previous_checkpoint_cid);
        if (cursor === null) throw new Error('checkpoint history link is missing');
      }
    }
    return chain;
  };

  const normalizeConflict = (value: CheckpointConflictEvidence): CheckpointConflictEvidence => {
    if (
      !(value.previousCheckpointCid === null || isContentCid(value.previousCheckpointCid)) ||
      !Array.isArray(value.candidateCids) ||
      value.candidateCids.length < 2 ||
      value.candidateCids.length > LEDGER_CHECKPOINT_MAX_SIGNATURES ||
      !Array.isArray(value.verifiedSignerSets) ||
      !Array.isArray(value.equivocatedSigners) ||
      value.equivocatedSigners.length > LEDGER_CHECKPOINT_MAX_SIGNATURES
    )
      throw new Error('invalid checkpoint conflict evidence');
    const candidateCids = [...new Set(value.candidateCids)].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const equivocatedSigners = [...new Set(value.equivocatedSigners)].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const verifiedSignerSets = value.verifiedSignerSets
      .map((item) => {
        if (
          typeof item !== 'object' ||
          item === null ||
          Array.isArray(item) ||
          Object.keys(item).sort().join('\0') !==
            ['checkpointCid', 'signerSetCid', 'signers'].sort().join('\0') ||
          !isContentCid(item.checkpointCid) ||
          !isContentCid(item.signerSetCid) ||
          !Array.isArray(item.signers)
        )
          throw new Error('invalid checkpoint conflict evidence');
        const typed = item as {
          checkpointCid: CID;
          signerSetCid: CID;
          signers: unknown[];
        };
        if (typed.signers.some((signer) => typeof signer !== 'string'))
          throw new Error('invalid checkpoint conflict evidence');
        const signers = [...new Set(typed.signers as PeerId[])].sort((left, right) =>
          left < right ? -1 : left > right ? 1 : 0,
        );
        if (
          !canFinalizeSignerSet(signers.length) ||
          signers.length > LEDGER_CHECKPOINT_MAX_SIGNATURES ||
          signers.some((signer) => peerIdToPublicKey(signer) === null)
        )
          throw new Error('invalid checkpoint conflict evidence');
        return {
          checkpointCid: typed.checkpointCid,
          signerSetCid: typed.signerSetCid,
          signers,
        };
      })
      .sort((left, right) =>
        left.checkpointCid < right.checkpointCid
          ? -1
          : left.checkpointCid > right.checkpointCid
            ? 1
            : 0,
      );
    if (
      candidateCids.length < 2 ||
      candidateCids.some((cid) => !isContentCid(cid)) ||
      verifiedSignerSets.length !== candidateCids.length ||
      verifiedSignerSets.some((item, index) => item.checkpointCid !== candidateCids[index]) ||
      equivocatedSigners.some((signer) => peerIdToPublicKey(signer) === null)
    )
      throw new Error('invalid checkpoint conflict evidence');
    return {
      previousCheckpointCid: value.previousCheckpointCid,
      candidateCids,
      verifiedSignerSets,
      equivocatedSigners,
    };
  };

  const encodeConflict = (value: CheckpointConflictEvidence): Uint8Array => {
    const encoded = dagCbor.encode(normalizeConflict(value));
    const bytes = new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    if (bytes.byteLength > LEDGER_CHECKPOINT_CONFLICT_MAX_BYTES)
      throw new RangeError('checkpoint conflict evidence too large');
    return bytes;
  };

  const loadConflict = async (cid: CID): Promise<CheckpointConflictEvidence> => {
    const bytes = await storage.get(cid);
    if (bytes === undefined) throw new Error('dangling checkpoint conflict evidence pointer');
    if (bytes.byteLength > LEDGER_CHECKPOINT_CONFLICT_MAX_BYTES)
      throw new RangeError('checkpoint conflict evidence too large');
    if (cidOfBytes(bytes) !== cid) throw new Error('checkpoint conflict evidence CID mismatch');
    const normalized = normalizeConflict(dagCbor.decode(bytes) as CheckpointConflictEvidence);
    const canonical = encodeConflict(normalized);
    if (
      canonical.byteLength !== bytes.byteLength ||
      !canonical.every((byte, index) => byte === bytes[index])
    )
      throw new Error('checkpoint conflict evidence is not canonical');
    return normalized;
  };

  const getConflict = async (): Promise<CheckpointConflictEvidence | null> => {
    const cid = (await readControl()).conflictEvidenceCid;
    return cid === null ? null : loadConflict(cid);
  };

  const recordConflict = async (
    evidence: CheckpointConflictEvidence,
    expectedRevision: number,
  ): Promise<number> => {
    const normalized = normalizeConflict(evidence);
    const initialControl = await readControl();
    if (initialControl.revision !== expectedRevision) {
      const current = await getConflict();
      if (
        current !== null &&
        current.previousCheckpointCid === normalized.previousCheckpointCid &&
        normalized.candidateCids.every((cid) => current.candidateCids.includes(cid)) &&
        initialControl.effective === normalized.previousCheckpointCid
      )
        return initialControl.revision;
      throw new Error('checkpoint store revision mismatch');
    }
    const existing =
      initialControl.conflictEvidenceCid === null
        ? null
        : await loadConflict(initialControl.conflictEvidenceCid);
    if (existing !== null && existing.previousCheckpointCid !== normalized.previousCheckpointCid)
      throw new Error('checkpoint conflict already frozen at another common boundary');
    const merged =
      existing === null
        ? normalized
        : normalizeConflict({
            previousCheckpointCid: existing.previousCheckpointCid,
            candidateCids: [...existing.candidateCids, ...normalized.candidateCids],
            verifiedSignerSets: [
              ...existing.verifiedSignerSets,
              ...normalized.verifiedSignerSets,
            ].filter(
              (item, index, values) =>
                values.findIndex((candidate) => candidate.checkpointCid === item.checkpointCid) ===
                index,
            ),
            equivocatedSigners: [...existing.equivocatedSigners, ...normalized.equivocatedSigners],
          });
    const bytes = encodeConflict(merged);
    const conflictEvidenceCid = cidOfBytes(bytes);
    await storage.put(conflictEvidenceCid, bytes);
    return replaceControl(
      expectedRevision,
      (current, revision) => ({
        ...current,
        revision,
        effective: merged.previousCheckpointCid,
        conflictEvidenceCid,
        journal: null,
      }),
      (current) =>
        current.conflictEvidenceCid === conflictEvidenceCid &&
        current.effective === merged.previousCheckpointCid,
    );
  };

  return {
    save,
    load,
    setLatest,
    setEffectiveLatest,
    getLatest,
    getRevision,
    beginBoundaryAdvance,
    getPendingBoundaryAdvance,
    completeBoundaryAdvance,
    recordConflict,
    getConflict,
    history,
    close: async () => storage.close?.(),
  };
}
