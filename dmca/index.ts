/**
 * dmca/ 模組對外唯一出口。DMCA_ENABLE 開啟時，app 組裝層經這裡取得
 * store／mailer／service 建構器與 mountDmcaRoutes；其餘檔案不應被外部直接 import。
 */
export { createNoticeStore, type NoticeStore } from './store';
export { createNodemailerMailer, type Mailer, type MailerOptions } from './mailer';
export {
  createDmcaService,
  DmcaCounterNotEligibleError,
  DmcaInvalidActionError,
  DmcaInvalidOperatorError,
  DmcaInvalidReasonError,
  DmcaInvalidTransitionError,
  DmcaNotFoundError,
  type Clock,
  type DmcaExecutor,
  type DmcaService,
  type DmcaServiceDeps,
  type SubmitCounterResult,
  type SubmitNoticeResult,
  type TopClaimant,
  type TransparencyReport,
} from './service';
export { mountDmcaRoutes, type MountableServer } from './routes';
export {
  createDmcaInboxCrypto,
  decodeSignedInboxWire,
  type DmcaInboxCrypto,
  type DmcaInboxPayload,
  type DmcaInboxRequestPayload,
  type SignedInboxWire,
} from './signed-inbox';
export { dmcaOpenApiDocument } from './openapi';
export { addBusinessDays } from './business-days';
export {
  decryptDmcaExport,
  encryptDmcaExport,
  writeDmcaExportExclusive,
  type DmcaEncryptedExportHeaderV1,
  type DmcaEncryptedExportPayloadV1,
} from './export-archive';
export { createDmcaLifecycleExecutor, type DmcaLifecycleExecutorDeps } from './lifecycle-executor';
export { checkFixedWindowRate, type RateResult, type RateWindow } from './rate-limit';
export type {
  AdminNoticeDetail,
  AdminNoticeSummary,
  CopyrightedWork,
  CounterDeliveryStatus,
  CounterIdentityStatus,
  CounterNoticeSubmissionV1,
  DecisionLogEntry,
  DmcaAdminAction,
  DmcaRecordType,
  DmcaNoticeStatus,
  DmcaPinMetadata,
  DmcaResourceAvailability,
  DMCACounterNoticeV1,
  DMCANotice,
  InfringingContentItem,
  LitigationHoldEvidence,
  NoticeRecord,
  PublicView,
  ProviderDmcaInboxEntry,
  TakenDownContentItem,
  SignedWire,
} from './types';
