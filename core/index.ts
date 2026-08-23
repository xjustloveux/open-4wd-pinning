/**
 * vendored 內容的唯一出口——repo 內其餘模組只准經這個 barrel 取用 core/vendor/** 的東西，
 * 不得直接 import vendor 路徑。重新匯出的名稱與來源以 vendored 實檔的實際匯出為準；
 * 這個檔案可依需要調整（來源路徑、改名、增補），但 core/vendor/** 底下的檔案內容不得更動。
 */
export { Protocol, Network, EconomyConfig } from '@open4wd/system-constants';
export { PIN_REQUEST_CATEGORIES, PINNING_QUOTA_REASONS } from '@open4wd/interfaces';
export type {
  CID,
  PeerId,
  PinRequestCategory,
  PinningQuotaReason,
  Timestamp,
  Signature,
  SignedPayload,
} from '@open4wd/interfaces';

export {
  Open4wdLedger,
  type Open4wdLedgerOptions,
  type LedgerPorts,
} from './vendor/ledger/ledger-api';
export { createLedgerIpfs, type CreateLedgerIpfsOptions } from './vendor/ledger/ipfs-node';
export {
  createBlockAccess,
  exactOrbitDbAddress,
  openOrbitEventLog,
  type BlockAccess,
  type EventLogStore,
  type LedgerIpfs,
} from './vendor/ledger/orbit-log';
export { LEDGER_CONTENT_BLOCK_MAX_BYTES, cidMatchesBytes } from './vendor/ledger/content-cid';
export {
  initialCheckpointProofCommitment,
  parseInitialCheckpointProof,
  verifyInitialCheckpointProof,
  type InitialCheckpointProof,
} from './vendor/ledger/initial-checkpoint-proof';
export {
  createCheckpointStore,
  decodeCheckpointBlock,
  type CheckpointStore,
  type CheckpointStorage,
  type CheckpointControlStorage,
} from './vendor/ledger/checkpoint-store';
export { type AdmissionMiner } from './vendor/ledger/ledger-admission-miner';
export { searchAdmissionNonceBatch } from './vendor/ledger/ledger-admission.worker';
export {
  admissionBaseDigest,
  admissionWorkDigest,
  hasLeadingZeroBits,
} from './vendor/ledger/ledger-entry-admission';
export { type LedgerCheckpoint } from './vendor/ledger/events';
export { chainIdFromLedgerAddress } from './vendor/ledger/chain-identity';
export { ledgerSigningDigest } from './vendor/ledger/ledger-signing';
export { cidOfBytes, encodeDerivedState, encodeSignerSet } from './vendor/ledger/state-codec';
export {
  emptyDerivedState,
  type ApplierRegistry,
  type DerivedState,
} from './vendor/ledger/derived-state';
export { genesisEconomyConfigWithGovernance } from './vendor/economy/config';

export {
  buildNodeOptions,
  type NodeConfigInput,
  type Open4wdServices,
} from './vendor/peer-discovery/node-config';
export { libp2pPrivateKeyFromSeed } from './vendor/peer-discovery/identity';
export { resolveBootstrapNodes } from './vendor/peer-discovery/bootstrap';

export { buildSignedMessage, verifySignedPayload } from './vendor/key-manager/signed-payload';
export {
  peerIdToPublicKey,
  publicKeyToPeerId,
  verifyMessage as ed25519Verify,
} from './vendor/key-manager/ed25519';
