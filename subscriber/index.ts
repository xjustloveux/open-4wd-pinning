/**
 * subscriber/ 的唯一出口——下游模組（app 組裝）一律經這個 barrel 取用，不直接 import
 * 個別實作檔。
 */
export {
  reconcileCheckpoint,
  DenyList,
  type AdoptedCheckpoint,
  type ReconcileCtx,
  type ReconcileReport,
  type ReconcileWarning,
  type DenyListDeps,
} from './reconcile';
export {
  DagTransferLimitError,
  DEFAULT_DAG_TRANSFER_LIMITS,
  hasCompleteDag,
  measureCompleteDag,
  transferDag,
  type CompleteDagMeasurement,
  type DagBlockMeasurement,
  type DagTransferLimits,
  type TransferDagResult,
} from './dag-transfer';
