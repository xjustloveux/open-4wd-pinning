/**
 * DMCA 業務邏輯層：notice／counter-notice 生命週期、admin 裁決、每日掃描、透明度彙總。
 * 儲存與寄信皆經注入（NoticeStore／Mailer），take_down／restore 的實際 unpin／re-pin 也經
 * 注入的 executor 完成——本檔完全不碰 IPFS Cluster，只決定「什麼時候該呼叫」。時鐘同樣注入，
 * 讓 72 小時未確認 Notice 清除、13–14 工作日反通知等待視窗都可以在測試裡用假時鐘瞬間推進驗證，不必真的
 * 等待。
 * 兩項強化：①寄信例外一律經 safeSend 收斂吞掉、只記警告，絕不反向阻斷已經持久化的案卷
 * 回傳；同信箱冷卻只在「上一筆確認信已確定寄送成功」時才生效，避免 SMTP 暫時故障把申訴人
 * 永久卡死收不到任何確認信。②counter-notice 需 original 已 take_down 才能提交；
 * 可驗證 uploader 簽章即受理，無簽章則等待人工身分審查；二者均只在接受時起算。
 */
import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import { addBusinessDays } from './business-days';
import {
  createMailerCounterNoticeDelivery,
  MailerQueueFullError,
  type CounterNoticeDeliveryPort,
  type Mailer,
} from './mailer';
import type { NoticeStore } from './store';
import { isNoticePayload } from './types';
import type {
  AdminNoticeDetail,
  AdminNoticeSummary,
  CounterIdentityStatus,
  CounterNoticeSubmissionV1,
  DecisionLogEntry,
  DmcaAdminAction,
  DMCACounterNoticeV1,
  DMCANotice,
  DmcaNoticeStatus,
  DmcaPinMetadata,
  DmcaResourceAvailability,
  LitigationHoldEvidence,
  NoticeRecord,
  PublicView,
  ProviderDmcaInboxEntry,
} from './types';

const CONFIRM_TOKEN_BYTES = 32;
const UNCONFIRMED_TTL_MS = 72 * 60 * 60 * 1000;
const WAITING_PERIOD_BUSINESS_DAYS = 14;
// Pinning 營運政策的重複侵權者執法門檻，不屬於治理設定。
const REPEAT_INFRINGER_THRESHOLD = 3;
const ESTIMATED_PROCESSING_HOURS = 48;

/** 表示營運者操作引用了不存在的 DMCA 案件。 */
export class DmcaNotFoundError extends Error {
  constructor(id: string) {
    super(`DMCA 案件不存在：${id}`);
    this.name = 'DmcaNotFoundError';
  }
}

/** 表示請求了不支援的營運者操作。 */
export class DmcaInvalidActionError extends Error {
  constructor(action: string) {
    super(`不支援的 admin 裁決動作：${action}`);
    this.name = 'DmcaInvalidActionError';
  }
}

/** 表示原本有效的操作不允許從目前案件狀態執行。 */
export class DmcaInvalidTransitionError extends Error {
  constructor(status: DmcaNoticeStatus, action: DmcaAdminAction) {
    super(`DMCA 狀態 ${status} 不允許 admin 動作 ${action}`);
    this.name = 'DmcaInvalidTransitionError';
  }
}

/** 表示營運者裁定理由違反有界文字契約。 */
export class DmcaInvalidReasonError extends Error {
  constructor() {
    super('DMCA admin 裁決理由必須為 1 至 2000 字元');
    this.name = 'DmcaInvalidReasonError';
  }
}

/** 表示營運者稽核標籤違反有界文字契約。 */
export class DmcaInvalidOperatorError extends Error {
  constructor() {
    super('DMCA admin 操作者標籤必須為 1 至 200 字元');
    this.name = 'DmcaInvalidOperatorError';
  }
}

/** 表示訴訟保留缺少受認可程序的證據。 */
export class DmcaInvalidHoldEvidenceError extends Error {
  constructor() {
    super('hold requires qualifying federal-court or Copyright Claims Board evidence');
    this.name = 'DmcaInvalidHoldEvidenceError';
  }
}

/** 反通知對應的原始 notice 尚未 take_down 時丟出：等待期只能在實際下架且身分通過後起算。 */
export class DmcaCounterNotEligibleError extends Error {
  constructor(originalNoticeId: string) {
    super(`原始 notice 尚未下架（take_down），無法提交或確認反通知：${originalNoticeId}`);
    this.name = 'DmcaCounterNotEligibleError';
  }
}

/** 表示反通知不符合受理的標準內容格式。 */
export class DmcaInvalidCounterNoticeError extends Error {
  constructor() {
    super('反通知必須符合 canonical v1 schema');
    this.name = 'DmcaInvalidCounterNoticeError';
  }
}

const COUNTER_NOTICE_KEYS = new Set([
  'schemaVersion',
  'uploaderName',
  'uploaderEmail',
  'uploaderPhone',
  'uploaderAddress',
  'originalNoticeId',
  'takenDownContent',
  'goodFaithMistakeOrMisidentification',
  'perjuryStatement',
  'federalDistrict',
  'acceptsServiceFromClaimant',
  'signature',
  'signatureDate',
  'submittedAt',
]);
const TAKEN_DOWN_CONTENT_KEYS = new Set(['cid', 'url', 'description']);

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= maximum
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function assertCounterNotice(value: DMCACounterNoticeV1): void {
  const raw = value as unknown as Record<string, unknown>;
  const textFields: readonly [string, number][] = [
    ['uploaderName', 200],
    ['uploaderEmail', 320],
    ['uploaderPhone', 100],
    ['uploaderAddress', 2000],
    ['originalNoticeId', 128],
    ['federalDistrict', 500],
    ['signature', 200],
    ['signatureDate', 32],
  ];
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !hasOnlyKeys(raw, COUNTER_NOTICE_KEYS) ||
    Object.keys(raw).length !== COUNTER_NOTICE_KEYS.size ||
    raw['schemaVersion'] !== 1 ||
    raw['goodFaithMistakeOrMisidentification'] !== true ||
    raw['perjuryStatement'] !== true ||
    raw['acceptsServiceFromClaimant'] !== true ||
    !Number.isSafeInteger(raw['submittedAt']) ||
    (raw['submittedAt'] as number) < 0 ||
    textFields.some(([key, maximum]) => !isBoundedText(raw[key], maximum)) ||
    !Array.isArray(raw['takenDownContent']) ||
    raw['takenDownContent'].length === 0 ||
    raw['takenDownContent'].length > 100
  ) {
    throw new DmcaInvalidCounterNoticeError();
  }
  for (const item of raw['takenDownContent']) {
    if (typeof item !== 'object' || item === null) throw new DmcaInvalidCounterNoticeError();
    const candidate = item as Record<string, unknown>;
    if (
      !hasOnlyKeys(candidate, TAKEN_DOWN_CONTENT_KEYS) ||
      Object.keys(candidate).length !== TAKEN_DOWN_CONTENT_KEYS.size ||
      !isBoundedText(candidate['cid'], 256) ||
      !isBoundedText(candidate['url'], 2048) ||
      !isBoundedText(candidate['description'], 4000)
    ) {
      throw new DmcaInvalidCounterNoticeError();
    }
    try {
      const url = new URL(candidate['url']);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('invalid protocol');
    } catch {
      throw new DmcaInvalidCounterNoticeError();
    }
  }
}

function decodeCounterSubmission(
  submission: CounterNoticeSubmissionV1,
  verifiedSigner: string | undefined,
): { counter: DMCACounterNoticeV1; signer?: string } {
  const raw = submission as unknown as Record<string, unknown>;
  if (raw['mode'] === 'manual-review') {
    if (!hasOnlyKeys(raw, new Set(['mode', 'payload'])) || Object.keys(raw).length !== 2) {
      throw new DmcaInvalidCounterNoticeError();
    }
    const counter = raw['payload'] as DMCACounterNoticeV1;
    assertCounterNotice(counter);
    return { counter };
  }
  if (raw['mode'] !== 'signed-uploader') throw new DmcaInvalidCounterNoticeError();
  if (!hasOnlyKeys(raw, new Set(['mode', 'signed'])) || Object.keys(raw).length !== 2) {
    throw new DmcaInvalidCounterNoticeError();
  }
  const signed = raw['signed'];
  if (typeof signed !== 'object' || signed === null) throw new DmcaInvalidCounterNoticeError();
  const wire = signed as Record<string, unknown>;
  if (
    !hasOnlyKeys(wire, new Set(['payload', 'timestamp', 'nonceHex', 'signer', 'signatureHex'])) ||
    Object.keys(wire).length !== 5 ||
    typeof wire['signer'] !== 'string' ||
    verifiedSigner !== wire['signer']
  ) {
    throw new DmcaInvalidCounterNoticeError();
  }
  const counter = wire['payload'] as DMCACounterNoticeV1;
  assertCounterNotice(counter);
  return { counter, signer: wire['signer'] };
}

/** 提供可注入的牆鐘，供決定性生命週期處理使用。 */
export interface Clock {
  now(): number;
}

/** take_down／restore 的實際下架/恢復動作；由呼叫端注入（正式環境以 ClusterClient 的 unpin／pin 實作）。 */
export interface DmcaExecutor {
  /** 必須在 unpin 前由 provider 的可信 pin metadata 解析。 */
  uploaderPeerIdFor(cid: string): Promise<string | undefined>;
  pinMetadataFor(cid: string): Promise<DmcaPinMetadata | undefined>;
  unpin(cids: readonly string[]): Promise<void>;
  /** 只檢查本 provider 是否仍持有 exact-CID bytes，不從網路抓取。 */
  hasExactBytes(cid: string): Promise<boolean>;
  restore(
    cids: readonly string[],
    pinMetadataByCid: Readonly<Record<string, DmcaPinMetadata>>,
  ): Promise<void>;
}

/** 向 DMCA 服務提供持久化、郵件、執行、時間與政策輸入。 */
export interface DmcaServiceDeps {
  store: NoticeStore;
  mailer: Mailer;
  executor: DmcaExecutor;
  clock: Clock;
  /** Provider 私有 DMCA 維運信箱；Notice 成案與人工審查提醒寄到這裡。 */
  agentEmail: string;
  counterDelivery?: CounterNoticeDeliveryPort;
  counterDeliveryRetryBaseMs?: number;
  counterDeliveryRetryMaxMs?: number;
  businessDayHolidays?: readonly string[];
  recordCounterDelivery?: (outcome: 'delivered' | 'retrying') => void;
}

/** 回報已受理通知的識別、狀態與預期處理時間窗。 */
export interface SubmitNoticeResult {
  noticeId: string;
  status: DmcaNoticeStatus;
  estimatedProcessingTimeHours: number;
}

/** 回報反通知准入與因此產生的等待期時間戳。 */
export interface SubmitCounterResult {
  counterNoticeId: string;
  status: DmcaNoticeStatus;
  identityStatus: CounterIdentityStatus;
  acceptedAt?: number;
  waitingPeriodEndDate?: number;
}

/** 表示透明度報告中的單一去識別申訴人彙總。 */
export interface TopClaimant {
  claimantOrgRedacted: string;
  count: number;
}

/** 彙總年度 DMCA 結果，且不暴露私人案件內容。 */
export interface TransparencyReport {
  year: number;
  notices: number;
  removed: number;
  counter: number;
  restored: number;
  repeatInfringersTerminated: number;
  topClaimants: TopClaimant[];
}

/** 提供完整通知、反通知、營運者與透明度生命週期。 */
export interface DmcaService {
  submitNotice(notice: DMCANotice): Promise<SubmitNoticeResult>;
  /** token 對應不到任何案卷（已用過／不存在）時回傳 undefined，呼叫端可視為「靜默忽略」。
   * counter-notice 類型的 token 若對應的原始 notice 尚未 take_down，會拋出
   * DmcaCounterNotEligibleError（明確業務規則違反，不應被當成「token 不存在」靜默忽略）。 */
  confirmEmail(token: string): Promise<NoticeRecord | undefined>;
  getNotice(id: string): Promise<NoticeRecord | undefined>;
  uploaderInbox(peerId: string): Promise<ProviderDmcaInboxEntry[]>;
  /** original 尚未 take_down 時拋出 DmcaCounterNotEligibleError；理由見同名 class 註解。 */
  submitCounter(
    submission: CounterNoticeSubmissionV1,
    verifiedSigner?: string,
  ): Promise<SubmitCounterResult>;
  adminIdentityDecide(
    id: string,
    action: 'accept' | 'reject',
    reason: string,
    operatorId?: string,
  ): Promise<NoticeRecord>;
  transparency(): Promise<TransparencyReport>;
  adminList(query?: {
    status?: DmcaNoticeStatus;
    cursor?: string;
    limit?: number;
  }): Promise<{ cases: AdminNoticeSummary[]; nextCursor?: string }>;
  adminGet(id: string): Promise<AdminNoticeDetail | undefined>;
  adminDecide(
    id: string,
    action: DmcaAdminAction,
    reason: string,
    operatorId?: string,
    holdEvidence?: LitigationHoldEvidence,
  ): Promise<NoticeRecord>;
  /** 重試已受理但 provider-local unpin 暫時失敗的 notice。 */
  sweepTakedowns(now: number): Promise<void>;
  sweepCounterRestores(now: number): Promise<void>;
  sweepCounterDeliveries(now: number): Promise<void>;
  purgeUnconfirmed(now: number): Promise<void>;
  countNotRestoredTakedowns(signer: string): Promise<number>;
  redactClosed(before: number): Promise<void>;
}

function newConfirmToken(): string {
  return randomBytes(CONFIRM_TOKEN_BYTES).toString('hex');
}

function toAdminDetail(record: NoticeRecord): AdminNoticeDetail {
  return {
    id: record._id,
    type: record.type,
    status: record.status,
    payload: record.payload,
    affectedCIDs: [...record.affectedCIDs],
    createdAt: record.createdAt,
    processedAt: record.processedAt,
    litigationNoticedAt: record.litigationNoticedAt,
    litigationHoldEvidence: record.litigationHoldEvidence,
    waitingPeriodEndDate: record.waitingPeriodEndDate,
    restorationEligibleAt: record.restorationEligibleAt,
    acceptedAt: record.acceptedAt,
    counterIdentityStatus: record.counterIdentityStatus,
    counterSignerPeerId: record.counterSignerPeerId,
    counterIdentityDecisionAt: record.counterIdentityDecisionAt,
    counterIdentityDecisionReason: record.counterIdentityDecisionReason,
    counterIdentityDecisionOperatorId: record.counterIdentityDecisionOperatorId,
    counterDeliveryStatus: record.counterDeliveryStatus,
    counterDeliveryAttemptCount: record.counterDeliveryAttemptCount,
    counterDeliveryNextAttemptAt: record.counterDeliveryNextAttemptAt,
    counterDeliveredAt: record.counterDeliveredAt,
    counterDeliveryLastErrorCode: record.counterDeliveryLastErrorCode,
    resourceAvailability: record.resourceAvailability,
    missingCIDs: [...(record.missingCIDs ?? [])],
    decisionLog: [...record.decisionLog],
  };
}

function parseAdminCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const parsed = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function validateReason(reason: string): string {
  const normalized = reason.trim();
  if (normalized.length === 0 || normalized.length > 2000) throw new DmcaInvalidReasonError();
  return normalized;
}

function validateOperatorId(operatorId: string): string {
  const normalized = operatorId.trim();
  if (normalized.length === 0 || normalized.length > 200) throw new DmcaInvalidOperatorError();
  return normalized;
}

function validateHoldEvidence(
  evidence: LitigationHoldEvidence | undefined,
  now: number,
): LitigationHoldEvidence {
  const raw = evidence as unknown as Record<string, unknown> | undefined;
  if (
    evidence === undefined ||
    raw === undefined ||
    Object.keys(raw).length !== 3 ||
    !Object.keys(raw).every((key) => ['proceeding', 'reference', 'receivedAt'].includes(key)) ||
    !['us-federal-court', 'copyright-claims-board'].includes(evidence.proceeding) ||
    !isBoundedText(evidence.reference, 1000) ||
    !Number.isSafeInteger(evidence.receivedAt) ||
    evidence.receivedAt < 0 ||
    evidence.receivedAt > now
  ) {
    throw new DmcaInvalidHoldEvidenceError();
  }
  return { ...evidence, reference: evidence.reference.trim() };
}

function isTransitionAllowed(record: NoticeRecord, action: DmcaAdminAction): boolean {
  if (record.type !== 'notice') return false;
  if (action === 'take_down' || action === 'reject') return record.status === 'received';
  if (action === 'restore') return record.status === 'taken_down';
  if (action === 'release_hold') {
    return record.status === 'taken_down' && record.litigationHoldEvidence !== undefined;
  }
  return (
    action === 'hold' &&
    record.status === 'taken_down' &&
    record.waitingPeriodEndDate !== undefined &&
    record.litigationNoticedAt === undefined
  );
}

function buildPublicView(record: {
  _id: string;
  status: DmcaNoticeStatus;
  payload: DMCANotice | DMCACounterNoticeV1;
  affectedCIDs: string[];
  createdAt: number;
  processedAt?: number;
}): PublicView {
  const org = isNoticePayload(record.payload) ? record.payload.claimantOrganization : undefined;
  return {
    noticeIdShort: record._id.slice(0, 8),
    claimantOrgRedacted: org ?? '個人',
    cidsAffected: record.affectedCIDs,
    status: record.status,
    timestamps: { createdAt: record.createdAt, processedAt: record.processedAt },
  };
}

function confirmMailText(token: string): string {
  return (
    `您好，請確認您剛提交的 DMCA 表單。\n\nConfirm token: ${token}\n\n` +
    `請將此 token 提供給確認端點以完成驗證；此 token 僅一次有效，未確認的申請將於 72 ` +
    `小時後自動清除。`
  );
}

/** 以注入的私人儲存與副作用連接埠建立 DMCA 領域服務。 */
export function createDmcaService(deps: DmcaServiceDeps): DmcaService {
  const { store, mailer, executor, clock, agentEmail } = deps;
  const counterDelivery = deps.counterDelivery ?? createMailerCounterNoticeDelivery(mailer);
  const counterDeliveryRetryBaseMs = deps.counterDeliveryRetryBaseMs ?? 60_000;
  const counterDeliveryRetryMaxMs = deps.counterDeliveryRetryMaxMs ?? 24 * 60 * 60_000;
  const businessDayHolidays = new Set(deps.businessDayHolidays ?? []);

  // 寄信例外絕不能反向阻斷已經持久化的案卷回傳——record 早在呼叫寄信之前就已經
  // store.create／store.put 完成，SMTP 掛掉只代表「這封通知信沒送到」，不代表案卷本身失敗。
  // 這裡統一收斂例外、記警告後回傳是否寄送成功；呼叫端（submitNotice／submitCounter）依
  // 成功與否決定要不要記錄 confirmMailSentAt（同信箱冷卻用）。
  const safeSend = async (to: string, subject: string, text: string): Promise<boolean> => {
    try {
      await mailer.send(to, subject, text);
      return true;
    } catch (err) {
      console.warn(
        `[dmca/service] 寄信失敗（收件者：${to}，主旨：${subject}），不影響已持久化的案卷`,
        err,
      );
      return false;
    }
  };

  const notifyAgent = async (subject: string, text: string): Promise<void> => {
    await safeSend(agentEmail, subject, text);
  };

  const sendConfirmMail = async (to: string, subject: string, token: string): Promise<boolean> => {
    return safeSend(to, subject, confirmMailText(token));
  };

  const availabilityOf = (availableCount: number, totalCount: number): DmcaResourceAvailability => {
    if (availableCount === 0) return 'missing';
    return availableCount === totalCount ? 'available' : 'partial';
  };

  const captureTrustedUploaders = async (record: NoticeRecord): Promise<void> => {
    const entries = await Promise.all(
      record.affectedCIDs.map(async (cid) => ({
        cid,
        uploader: await executor.uploaderPeerIdFor(cid),
        metadata: await executor.pinMetadataFor(cid),
      })),
    );
    record.uploaderByCid = {
      ...(record.uploaderByCid ?? {}),
      ...Object.fromEntries(
        entries
          .filter(
            (entry): entry is typeof entry & { uploader: string } => entry.uploader !== undefined,
          )
          .map((entry) => [entry.cid, entry.uploader]),
      ),
    };
    record.pinMetadataByCid = {
      ...(record.pinMetadataByCid ?? {}),
      ...Object.fromEntries(
        entries
          .filter(
            (entry): entry is typeof entry & { metadata: DmcaPinMetadata } =>
              entry.metadata !== undefined,
          )
          .map((entry) => [entry.cid, entry.metadata]),
      ),
    };
  };

  const applyTakedown = async (record: NoticeRecord, now: number): Promise<void> => {
    await captureTrustedUploaders(record);
    // 先持久化再做可能部分成功的多 CID unpin；否則重試時已成功移除的 CID 查不到 Cluster
    // metadata，會遺失日後 restore 與 quota 重建所需資料。狀態仍維持 received。
    await store.put(record);
    await executor.unpin(record.affectedCIDs);
    record.status = 'taken_down';
    record.processedAt = now;
    record.resourceAvailability = 'missing';
    record.missingCIDs = [...record.affectedCIDs];
  };

  const applyRestore = async (record: NoticeRecord, now: number): Promise<void> => {
    const availability = await Promise.all(
      record.affectedCIDs.map(async (cid) => ({
        cid,
        available: await executor.hasExactBytes(cid),
      })),
    );
    const availableCIDs = availability.filter((item) => item.available).map((item) => item.cid);
    const missingCIDs = availability.filter((item) => !item.available).map((item) => item.cid);
    if (availableCIDs.length > 0) {
      await executor.restore(availableCIDs, record.pinMetadataByCid ?? {});
    }
    record.status = 'restored_after_counter';
    record.processedAt = now;
    record.resourceAvailability = availabilityOf(availableCIDs.length, availability.length);
    record.missingCIDs = missingCIDs;
  };

  const deliverAcceptedCounter = async (
    record: NoticeRecord,
    original: NoticeRecord,
    now: number,
  ): Promise<void> => {
    if (
      record.type !== 'counter-notice' ||
      record.acceptedAt === undefined ||
      (record.counterDeliveryStatus !== 'pending' && record.counterDeliveryStatus !== 'retrying') ||
      (record.counterDeliveryNextAttemptAt !== undefined &&
        now < record.counterDeliveryNextAttemptAt) ||
      !isNoticePayload(original.payload)
    ) {
      return;
    }
    record.counterDeliveryAttemptCount = (record.counterDeliveryAttemptCount ?? 0) + 1;
    record.counterDeliveryNextAttemptAt = undefined;
    await store.put(record);
    try {
      await counterDelivery.deliverToClaimant({
        claimantEmail: original.payload.claimantEmail,
        counterNotice: record.payload as DMCACounterNoticeV1,
      });
      record.counterDeliveryStatus = 'delivered';
      record.counterDeliveredAt = now;
      record.counterDeliveryLastErrorCode = undefined;
      deps.recordCounterDelivery?.('delivered');
    } catch (error) {
      const attempts = record.counterDeliveryAttemptCount;
      const delay = Math.min(
        counterDeliveryRetryBaseMs * 2 ** Math.max(0, attempts - 1),
        counterDeliveryRetryMaxMs,
      );
      record.counterDeliveryStatus = 'retrying';
      record.counterDeliveryNextAttemptAt = now + delay;
      record.counterDeliveryLastErrorCode =
        error instanceof MailerQueueFullError ? 'mailer-queue-full' : 'delivery-failed';
      deps.recordCounterDelivery?.('retrying');
      console.warn(
        `[dmca/service] counter delivery retry scheduled code=${record.counterDeliveryLastErrorCode}`,
      );
    }
    await store.put(record);
  };

  return {
    async submitNotice(notice: DMCANotice): Promise<SubmitNoticeResult> {
      const now = clock.now();
      const id = ulid(now);
      const token = newConfirmToken();
      const affectedCIDs = notice.infringingContent.map((item) => item.cid);
      // 冷卻檢查必須在 store.create 之前——晚了會連自己剛建立的那筆都算進「已有未確認案」。
      const alreadyPending = await store.findPendingByEmail(notice.claimantEmail);

      const record: NoticeRecord = {
        _id: id,
        type: 'notice',
        status: 'pending-email-confirm',
        payload: notice,
        affectedCIDs,
        createdAt: now,
        confirmToken: token,
        decisionLog: [],
        publicView: buildPublicView({
          _id: id,
          status: 'pending-email-confirm',
          payload: notice,
          affectedCIDs,
          createdAt: now,
        }),
      };
      await store.create(record);

      // 冷卻只在「上一筆 pending 案的確認信已確定寄送成功」時才生效；若上一筆從未寄成功
      // （SMTP 一時故障等，confirmMailSentAt 未設），這裡仍要重新嘗試寄送，不能讓申訴人被
      // 永久卡死收不到任何確認信。
      if (alreadyPending?.confirmMailSentAt === undefined) {
        const sent = await sendConfirmMail(notice.claimantEmail, 'DMCA 表單信箱確認', token);
        if (sent) {
          record.confirmMailSentAt = now;
          await store.put(record);
        }
      }

      return {
        noticeId: id,
        status: record.status,
        estimatedProcessingTimeHours: ESTIMATED_PROCESSING_HOURS,
      };
    },

    async confirmEmail(token: string): Promise<NoticeRecord | undefined> {
      const record = await store.findByConfirmToken(token);
      if (record === undefined) return undefined;

      const markReceived = async (): Promise<void> => {
        record.confirmToken = undefined;
        record.status = 'received';
        record.publicView = buildPublicView(record);
        await store.put(record);
      };

      if (record.type === 'notice') {
        await markReceived();
        const now = clock.now();
        await applyTakedown(record, now);
        record.decisionLog = [
          ...record.decisionLog,
          {
            action: 'take_down',
            reason: '通知完成信箱確認，系統自動停止本 provider 供應',
            at: now,
            operatorId: 'system:auto-takedown',
          },
        ];
        record.publicView = buildPublicView(record);
        await store.put(record);
        await notifyAgent(
          `新 DMCA notice 已自動下架：${record._id}`,
          `案號 ${record._id} 的申訴人信箱已完成確認，本 provider 已停止供應相關 CID。`,
        );
        return record;
      }

      throw new DmcaInvalidCounterNoticeError();
    },

    async getNotice(id: string): Promise<NoticeRecord | undefined> {
      return store.get(id);
    },

    async uploaderInbox(peerId: string): Promise<ProviderDmcaInboxEntry[]> {
      const records = await store.list();
      return records.flatMap((record): ProviderDmcaInboxEntry[] => {
        if (record.type !== 'notice') return [];
        const affectedCIDs = record.affectedCIDs.filter(
          (cid) => record.uploaderByCid?.[cid] === peerId,
        );
        if (affectedCIDs.length === 0) return [];
        const missing = new Set(record.missingCIDs ?? []);
        const availableCount = affectedCIDs.filter((cid) => !missing.has(cid)).length;
        return [
          {
            noticeId: record._id,
            affectedCIDs,
            legalStatus: record.status,
            resourceAvailability: availabilityOf(availableCount, affectedCIDs.length),
            ...(record.waitingPeriodEndDate === undefined
              ? {}
              : { waitingPeriodEndDate: record.waitingPeriodEndDate }),
            litigationHold: record.litigationNoticedAt !== undefined,
            updatedAt: record.decisionLog.at(-1)?.at ?? record.processedAt ?? record.createdAt,
          },
        ];
      });
    },

    async submitCounter(
      submission: CounterNoticeSubmissionV1,
      verifiedSigner?: string,
    ): Promise<SubmitCounterResult> {
      const { counter, signer } = decodeCounterSubmission(submission, verifiedSigner);
      const original = await store.get(counter.originalNoticeId);
      if (original === undefined) throw new DmcaNotFoundError(counter.originalNoticeId);
      // 前置狀態檢查：original 必須已經 take_down 才能提交反通知，堵「未下架先埋反通知→
      // 舊 now 算的 waitingPeriodEndDate→之後才 take_down→下次 sweep 立即誤 restore」的
      // 搶跑路徑（14 工作日等待期理應從下架當下起算，不是從案卷收件當下起算）。
      if (original.status !== 'taken_down') {
        throw new DmcaCounterNotEligibleError(counter.originalNoticeId);
      }

      const now = clock.now();
      const id = ulid(now);
      const trustedUploaders = original.affectedCIDs.map((cid) => original.uploaderByCid?.[cid]);
      const verifiedUploader =
        signer !== undefined &&
        trustedUploaders.length > 0 &&
        trustedUploaders.every((candidate) => candidate !== undefined && candidate === signer);
      const identityStatus: CounterIdentityStatus = verifiedUploader
        ? 'verified-uploader-signature'
        : 'pending-identity-review';
      const record: NoticeRecord = {
        _id: id,
        type: 'counter-notice',
        status: verifiedUploader ? 'received' : 'pending-identity-review',
        payload: counter,
        affectedCIDs: original.affectedCIDs,
        createdAt: now,
        counterIdentityStatus: identityStatus,
        ...(signer === undefined ? {} : { counterSignerPeerId: signer }),
        counterDeliveryStatus: verifiedUploader ? 'pending' : 'not-ready',
        counterDeliveryAttemptCount: 0,
        decisionLog: [],
        publicView: buildPublicView({
          _id: id,
          status: verifiedUploader ? 'received' : 'pending-identity-review',
          payload: counter,
          affectedCIDs: original.affectedCIDs,
          createdAt: now,
        }),
      };
      if (verifiedUploader) {
        record.acceptedAt = now;
        original.restorationEligibleAt ??= addBusinessDays(now, 13, businessDayHolidays);
        original.waitingPeriodEndDate ??= addBusinessDays(
          now,
          WAITING_PERIOD_BUSINESS_DAYS,
          businessDayHolidays,
        );
        original.publicView = buildPublicView(original);
        await store.put(original);
      }
      await store.create(record);
      if (verifiedUploader) await deliverAcceptedCounter(record, original, now);

      return {
        counterNoticeId: id,
        status: record.status,
        identityStatus,
        ...(record.acceptedAt === undefined ? {} : { acceptedAt: record.acceptedAt }),
        ...(original.waitingPeriodEndDate === undefined
          ? {}
          : { waitingPeriodEndDate: original.waitingPeriodEndDate }),
      };
    },

    async adminIdentityDecide(id, action, reason, operatorId = 'self-hosted-admin') {
      const normalizedReason = validateReason(reason);
      const normalizedOperatorId = validateOperatorId(operatorId);
      const record = await store.get(id);
      if (record === undefined) throw new DmcaNotFoundError(id);
      if (
        record.type !== 'counter-notice' ||
        record.counterIdentityStatus !== 'pending-identity-review'
      ) {
        throw new DmcaInvalidTransitionError(record.status, 'restore');
      }
      const now = clock.now();
      record.counterIdentityDecisionAt = now;
      record.counterIdentityDecisionReason = normalizedReason;
      record.counterIdentityDecisionOperatorId = normalizedOperatorId;
      if (action === 'reject') {
        record.counterIdentityStatus = 'rejected-manual';
        record.status = 'rejected_by_admin';
        record.counterDeliveryStatus = 'not-ready';
        record.publicView = buildPublicView(record);
        await store.put(record);
        return record;
      }
      const counter = record.payload as DMCACounterNoticeV1;
      const original = await store.get(counter.originalNoticeId);
      if (original === undefined || original.status !== 'taken_down') {
        throw new DmcaCounterNotEligibleError(counter.originalNoticeId);
      }
      record.counterIdentityStatus = 'verified-manual';
      record.status = 'received';
      record.acceptedAt ??= now;
      record.counterDeliveryStatus = 'pending';
      original.restorationEligibleAt ??= addBusinessDays(
        record.acceptedAt,
        13,
        businessDayHolidays,
      );
      original.waitingPeriodEndDate ??= addBusinessDays(
        record.acceptedAt,
        WAITING_PERIOD_BUSINESS_DAYS,
        businessDayHolidays,
      );
      record.publicView = buildPublicView(record);
      original.publicView = buildPublicView(original);
      await store.put(original);
      await store.put(record);
      await deliverAcceptedCounter(record, original, now);
      return record;
    },

    async transparency(): Promise<TransparencyReport> {
      const now = clock.now();
      const year = new Date(now).getUTCFullYear();
      const all = await store.list();
      const records = all.filter((r) => new Date(r.createdAt).getUTCFullYear() === year);

      const notices = records.filter((r) => r.type === 'notice');
      const counters = records.filter((r) => r.type === 'counter-notice');
      const removed = notices.filter((r) =>
        r.decisionLog.some((d) => d.action === 'take_down'),
      ).length;
      const restored = notices.filter((r) =>
        r.decisionLog.some((d) => d.action === 'restore'),
      ).length;

      const signers = new Set<string>();
      for (const r of notices) {
        for (const signer of Object.values(r.uploaderByCid ?? {})) signers.add(signer);
      }
      const repeatCounts = await Promise.all(
        [...signers].map((signer) => store.countNotRestoredTakedowns(signer)),
      );
      const repeatInfringersTerminated = repeatCounts.filter(
        (c) => c >= REPEAT_INFRINGER_THRESHOLD,
      ).length;

      const claimantCounts = new Map<string, number>();
      for (const r of notices) {
        const key = r.publicView.claimantOrgRedacted;
        claimantCounts.set(key, (claimantCounts.get(key) ?? 0) + 1);
      }
      const topClaimants: TopClaimant[] = [...claimantCounts.entries()]
        .map(([claimantOrgRedacted, count]) => ({ claimantOrgRedacted, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      return {
        year,
        notices: notices.length,
        removed,
        counter: counters.length,
        restored,
        repeatInfringersTerminated,
        topClaimants,
      };
    },

    async adminList(query = {}): Promise<{ cases: AdminNoticeSummary[]; nextCursor?: string }> {
      const records = await store.list(
        query.status !== undefined ? { status: query.status } : undefined,
      );
      const allRecords = await store.list();
      const pendingOriginalIds = new Set(
        allRecords
          .filter(
            (candidate) => candidate.type === 'counter-notice' && candidate.status === 'received',
          )
          .map((candidate) => (candidate.payload as DMCACounterNoticeV1).originalNoticeId),
      );
      const offset = parseAdminCursor(query.cursor);
      const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
      const slice = records.slice(offset, offset + limit);
      const cases = slice.map((record): AdminNoticeSummary => ({
        id: record._id,
        type: record.type,
        status: record.status,
        createdAt: record.createdAt,
        processedAt: record.processedAt,
        affectedCidCount: record.affectedCIDs.length,
        claimantLabelRedacted: record.publicView.claimantOrgRedacted,
        hasPendingCounter: pendingOriginalIds.has(record._id),
        litigationHold: record.litigationNoticedAt !== undefined,
      }));
      const nextOffset = offset + slice.length;
      return {
        cases,
        nextCursor:
          nextOffset < records.length
            ? Buffer.from(String(nextOffset), 'utf8').toString('base64url')
            : undefined,
      };
    },

    async adminGet(id: string): Promise<AdminNoticeDetail | undefined> {
      const record = await store.get(id);
      return record === undefined ? undefined : toAdminDetail(record);
    },

    async adminDecide(
      id: string,
      action: DmcaAdminAction,
      reason: string,
      operatorId = 'self-hosted-admin',
      holdEvidence?: LitigationHoldEvidence,
    ): Promise<NoticeRecord> {
      const record = await store.get(id);
      if (record === undefined) throw new DmcaNotFoundError(id);
      const normalizedReason = reason.trim();
      if (normalizedReason.length === 0 || normalizedReason.length > 2000) {
        throw new DmcaInvalidReasonError();
      }
      const normalizedOperatorId = operatorId.trim();
      if (normalizedOperatorId.length === 0 || normalizedOperatorId.length > 200) {
        throw new DmcaInvalidOperatorError();
      }
      if (!isTransitionAllowed(record, action)) {
        throw new DmcaInvalidTransitionError(record.status, action);
      }
      const now = clock.now();
      const entry: DecisionLogEntry = {
        action,
        reason: normalizedReason,
        at: now,
        operatorId: normalizedOperatorId,
      };

      if (action === 'take_down') {
        await applyTakedown(record, now);
      } else if (action === 'restore') {
        await applyRestore(record, now);
      } else if (action === 'reject') {
        record.status = 'rejected_by_admin';
        record.processedAt = now;
      } else if (action === 'hold') {
        record.litigationHoldEvidence = validateHoldEvidence(holdEvidence, now);
        record.litigationNoticedAt = now;
      } else if (action === 'release_hold') {
        record.litigationHoldEvidence = undefined;
        record.litigationNoticedAt = undefined;
      } else throw new DmcaInvalidActionError(action);

      record.decisionLog = [...record.decisionLog, entry];
      record.publicView = buildPublicView(record);
      await store.put(record);
      return record;
    },

    async sweepTakedowns(now: number): Promise<void> {
      const received = await store.list({ status: 'received' });
      for (const record of received) {
        if (record.type !== 'notice') continue;
        try {
          await applyTakedown(record, now);
          record.decisionLog = [
            ...record.decisionLog,
            {
              action: 'take_down',
              reason: 'provider 下架重試成功',
              at: now,
              operatorId: 'system:auto-takedown-retry',
            },
          ];
          record.publicView = buildPublicView(record);
          await store.put(record);
          await notifyAgent(
            `DMCA notice 下架重試成功：${record._id}`,
            `案號 ${record._id} 的 provider-local 下架已由背景掃描完成。`,
          );
        } catch (error) {
          console.warn(`[dmca/service] notice 下架重試失敗：${record._id}`, error);
        }
      }
    },

    async sweepCounterRestores(now: number): Promise<void> {
      const takenDown = await store.list({ status: 'taken_down' });
      for (const record of takenDown) {
        if (record.type !== 'notice') continue;
        if (record.waitingPeriodEndDate === undefined) continue;
        if (record.litigationNoticedAt !== undefined) continue; // 已被 hold 攔停
        const eligibleAt = record.restorationEligibleAt ?? record.waitingPeriodEndDate;
        if (now < eligibleAt) continue;

        try {
          await applyRestore(record, now);
          record.decisionLog = [
            ...record.decisionLog,
            {
              action: 'restore',
              reason:
                now < record.waitingPeriodEndDate
                  ? '反通知第 13 工作日恢復緩衝已到，系統自動恢復'
                  : '反通知第 14 工作日期限已到，系統強制嘗試恢復',
              at: now,
              operatorId: 'system:auto-restore',
            },
          ];
          record.publicView = buildPublicView(record);
          await store.put(record);
        } catch {
          console.warn('[dmca/service] provider-local restore retry remains pending');
        }
      }
    },

    async sweepCounterDeliveries(now: number): Promise<void> {
      const records = await store.list();
      for (const record of records) {
        if (
          record.type !== 'counter-notice' ||
          record.acceptedAt === undefined ||
          (record.counterDeliveryStatus !== 'pending' &&
            record.counterDeliveryStatus !== 'retrying')
        ) {
          continue;
        }
        const counter = record.payload as DMCACounterNoticeV1;
        const original = await store.get(counter.originalNoticeId);
        if (original === undefined) continue;
        await deliverAcceptedCounter(record, original, now);
      }
    },

    async purgeUnconfirmed(now: number): Promise<void> {
      const cutoff = now - UNCONFIRMED_TTL_MS;
      const pending = await store.list({ status: 'pending-email-confirm' });
      for (const record of pending) {
        if (record.createdAt < cutoff) await store.delete(record._id);
      }
    },

    async countNotRestoredTakedowns(signer: string): Promise<number> {
      return store.countNotRestoredTakedowns(signer);
    },

    async redactClosed(before: number): Promise<void> {
      return store.redactClosed(before);
    },
  };
}
