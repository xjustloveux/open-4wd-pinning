/**
 * pwa-offline — PWA／離線能力：統一 IndexedDB 工廠、Service Worker 註冊與升版
 * 循環（idle guard／24h 寬限）、線上偵測、persistent storage 與 quota 警示、
 * UGC 快取 LRU（Helia pins＋gc；race-lock 硬規）。SW 本體＝public/service-worker.js
 * （generate:pwa 注入版本）；賽後 GC 觸發與 race-lock pin 分類接線隨房間開賽流程。
 */
export { UNIFIED_DB_NAME, UNIFIED_DB_STORES, UNIFIED_DB_VERSION, openUnifiedDb } from './idb';
export { waitForTransactionRequest } from './idb-transaction';
export {
  browserOriginStorageLock,
  UGC_CACHE_ORIGIN_LOCK_NAME,
  type OriginStorageLock,
} from './origin-storage-lock';
export { OnlineStatusService, browserOnlineDeps, type OnlineStatusDeps } from './online-status';
export {
  UPDATE_AUTO_APPLY_DELAY_MS,
  browserForceReload,
  makeBrowserUpdateChecker,
  registerServiceWorker,
  startUpdateLoop,
  type UpdateLoopDeps,
} from './sw-register';
export {
  checkStorageQuota,
  requestPersistentStorage,
  type StorageQuotaLevel,
  type StorageQuotaReport,
} from './storage';
export {
  ugcCacheUsagePolicy,
  type UgcCacheUsagePolicy,
  type UgcContributionLevel,
} from './ugc-contribution-policy';
export {
  UgcCacheLruService,
  idbUgcCacheMeta,
  type UgcCacheLruDeps,
  type UgcCacheMeta,
  type UgcPinCategory,
} from './ugc-cache-lru';
export {
  evaluateUgcStoragePressure,
  type UgcStoragePressureDeps,
  type UgcStoragePressureReason,
  type UgcStoragePressureStatus,
} from './ugc-storage-pressure';
