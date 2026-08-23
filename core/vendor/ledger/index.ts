/**
 * ledger — 事件鏈完整實作：邏輯核心（事件結構／canonical 序列化／derive 純函式／
 * DerivedState／收件驗證含 defer 有界重審／fork／檢查點純邏輯）＋儲存接線（helia
 * 動態工廠／OrbitDB 事件鏈與內容定址塊／檢查點永留庫／狀態決定性序列化／
 * Open4wdLedger＝canon LedgerApi）。live 驗證總組合與各域 reducer 由站點組裝
 * （bootstrap/ledger-assembly）注入。
 */
export type {
  ClientVersionInfo,
  DesyncEvent,
  DisconnectInfo,
  LedgerCheckpoint,
  LedgerCheckpointProposal,
  MatchEconomySettlement,
  MatchParticipantLoadout,
  MatchPrizeShare,
  MatchResultEvent,
  MatchResultSignature,
  MatchRules,
  GridCommitmentPayload,
  GridLockedContext,
  GridRevealPayload,
  StartGridParticipantProof,
  StartGridProof,
  RaceAnchorConflictEvidence,
  RaceAbortEvidenceEvent,
  RaceAbortFrameSummary,
  RaceAbortMessageDigest,
  RaceAbortObservation,
  RaceLeaveEvent,
  RaceConsensusAnchorEvent,
  RoundResult,
  RoyaltyShare,
  SettlementCancelMessage,
  SettlementProposalMessage,
  SettlementRejectMessage,
  SettlementSignatureMessage,
  SettlementTakeoverMessage,
  SignerSignature,
  UgcMaintenanceEvent,
} from './events';
export { disconnectEffectKey } from './disconnect-effects';
export {
  anchorFrameWithinTail,
  consensusAnchorQuorum,
  latestFinalAnchorFrame,
  sortedUniquePeers,
} from './consensus-anchor';
export { chainIdFromLedgerAddress, chainStorageName, type ChainId } from './chain-identity';
export { ledgerSigningDigest } from './ledger-signing';
export { ledgerSignedIntentDigest } from './ledger-signing';
export {
  hasProcessedPaymentIntent,
  isPaymentIntentEvent,
  paymentIntentDigest,
  type PaymentIntentEvent,
} from './payment-intent';
export { loadoutSigningMessage, serializeForSigning, signingDigest } from './serialize';
export {
  collectAllUgcUsedInMatch,
  consensusNow,
  currentHotPartitions,
  deriveTotalRanking,
  partitionKeyOf,
  type ColdPartitionKey,
} from './derive-utils';
export {
  applyEvent,
  composeApplierRegistries,
  emptyDerivedState,
  type ApplierRegistry,
  type AssetTypeKey,
  type AssetVersionDerivedState,
  type ColdMatchPartition,
  type DerivedState,
  type EconomyDerivedState,
  type EventApplier,
  type MatchDerivedState,
  type MatchRecord,
  type MonthlyEconomyFlow,
  type TrueSkillRatingX1000,
  type ModerationDerivedState,
  type ReportInfo,
  type ArbitrationResultRecord,
  type CreatorRatingMilestone,
  type ExplicitVote,
  type RatingDerivedState,
  type ReputationDerivedState,
  type UgcRatingStat,
  type UgcDerivedState,
  type UgcRecord,
  type UgcUsageStat,
} from './derived-state';
export {
  applyLedgerEntry,
  singleEraRulebook,
  type DeriveEra,
  type DeriveRulebook,
  type LedgerEntryFoldResult,
} from './derive-rulebook';
export {
  deriveMatchId,
  matchResultQuorum,
  matchResultRequiredQuorum,
  validateEventTimestamp,
  validateMatchResult,
  validateRaceConsensusAnchor,
  validateStandardEvent,
  verifyMatchResultSignatureSet,
  verifyRaceConsensusAnchorSignatureSet,
  verifyEventSignature,
  type LedgerRejectReason,
  type MatchResultValidationContext,
  type ReceiveVerdict,
} from './receive-validation';
export {
  LEDGER_CHECKPOINT_MIN_SIGNER_SET,
  bucketMatchesForCold,
  canFinalizeSignerSet,
  canonicalCheckpointSignatures,
  checkpointSignatureSigners,
  isUnsignedCheckpointShape,
  checkpointQuorum,
  shouldProposeCheckpoint,
  validateCheckpointSignatures,
} from './checkpoint';
export { decodeLedgerEvent } from './event-codec';
export {
  LEDGER_CONTENT_BLOCK_MAX_BYTES,
  cidMatchesBytes,
  cidOfDagCborBytes,
  cidOfRawBytes,
} from './content-cid';
export {
  cidOfBytes,
  decodeColdPartition,
  decodeDerivedState,
  decodeSignerSet,
  LEDGER_COLD_PARTITION_MAX_BYTES,
  LEDGER_DERIVED_STATE_MAX_BYTES,
  LEDGER_SIGNER_SET_MAX_BYTES,
  encodeColdPartition,
  encodeDerivedState,
  encodeSignerSet,
} from './state-codec';
export {
  createCheckpointStore,
  decodeCheckpointBlock,
  type CheckpointConflictEvidence,
  type CheckpointControlStorage,
  type CheckpointStorage,
  type CheckpointStore,
} from './checkpoint-store';
export { createIndexedDbCheckpointStorage } from './checkpoint-indexeddb-storage';
export {
  LRU_ENTRY_LIMIT,
  LedgerFrontierContinuityError,
  collectLedgerEntriesBetween,
  createBlockAccess,
  openOrbitEventLog,
  selectDeterministicLogHead,
  type BlockAccess,
  type EventLogStore,
  type LedgerIpfs,
  type LogEntry,
  type DeterministicLogHead,
  type OpenOrbitEventLogOptions,
  type OrbitEventLog,
} from './orbit-log';
export { createLedgerIpfs, type CreateLedgerIpfsOptions } from './ipfs-node';
export {
  borrowLedgerContentStorage,
  type BorrowedLedgerContentStorage,
} from './borrowed-content-storage';
export {
  Open4wdLedger,
  assertLedgerBusinessReady,
  defaultLiveValidator,
  foldLedgerEntrySafely,
  ledgerCoreAppliers,
  matchRecordFromEvent,
  type LedgerPorts,
  type LedgerBusinessReadiness,
  type LedgerSigner,
  type CheckpointAdoptionMode,
  type Open4wdLedgerOptions,
} from './ledger-api';
export { LEDGER_EVENT_TYPES } from './ledger-admission';
export {
  INITIAL_CHECKPOINT_PROOF_FETCH_TIMEOUT_MS,
  INITIAL_CHECKPOINT_PROOF_MAX_CHECKPOINTS,
  initialCheckpointProofCommitment,
  parseInitialCheckpointProof,
  verifyInitialCheckpointProof,
  type InitialCheckpointProof,
} from './initial-checkpoint-proof';
export {
  MATCH_HISTORY_DEFAULT_PAGE_SIZE,
  MATCH_HISTORY_MAX_PAGE_SIZE,
  MATCH_HISTORY_MAX_PARTITIONS_PER_PAGE,
  collectMatchHistoryPage,
  type MatchHistoryCursor,
  type MatchHistoryPage,
  type MatchHistoryPageRequest,
} from './match-history';
