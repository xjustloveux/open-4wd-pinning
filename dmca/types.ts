/**
 * DMCA 模組共用型別。表單 schema 對齊「權利人 Notice」與「上傳者 Counter-Notice」兩份介面；
 * NoticeRecord 是儲存層（level）實際落地的完整案卷結構，payload 含申訴人／上傳者聯絡個資，
 * publicView 是刻意去識別化、可安全對外揭露的子集（不含姓名／email／電話／地址）。
 * notice 與 counter-notice 共用同一個 store／同一組 _id 空間，用 type 欄位分辨。
 */

export interface CopyrightedWork {
  title: string;
  type: 'character' | 'design' | 'name' | 'logo' | 'music' | 'other';
  registrationNumber?: string;
  descriptionOfWork: string;
  dateOfFirstPublication?: string;
}

/** 識別通知中單一被指稱侵權的內容項目。 */
export interface InfringingContentItem {
  // 'part' 涵蓋全部零件 type（不用逐一列舉零件細分類）
  type: 'part' | 'track' | 'audio' | 'creator-profile';
  cid: string;
  url: string;
  creatorPeerId?: string;
  description: string;
}

/** 定義供應者接受的私人申訴人通知。 */
export interface DMCANotice {
  claimantName: string;
  claimantEmail: string;
  claimantPhone: string;
  claimantAddress: string;
  claimantOrganization?: string;
  isAuthorizedAgent: boolean;
  agentName?: string;
  agentRelationship?: string;
  copyrightedWork: CopyrightedWork;
  infringingContent: InfringingContentItem[];
  goodFaithStatement: boolean;
  perjuryStatement: boolean;
  signature: string;
  signatureDate: string;
  submittedAt: number;
  // ip/ua 僅伺服器側保存、不對外公開；歸檔抹除時一併清除
  ipAddress?: string;
  userAgent?: string;
}

/** 識別下架後由反通知處理的單一項目。 */
export interface TakenDownContentItem {
  cid: string;
  url: string;
  description: string;
}

/** 定義標準第一版反通知內容。 */
export interface DMCACounterNoticeV1 {
  readonly schemaVersion: 1;
  readonly uploaderName: string;
  readonly uploaderEmail: string;
  readonly uploaderPhone: string;
  readonly uploaderAddress: string;
  readonly originalNoticeId: string;
  readonly takenDownContent: readonly TakenDownContentItem[];
  readonly goodFaithMistakeOrMisidentification: true;
  readonly perjuryStatement: true;
  readonly federalDistrict: string;
  readonly acceptsServiceFromClaimant: true;
  readonly signature: string;
  readonly signatureDate: string;
  readonly submittedAt: number;
}

/** 以必要身分欄位區分申訴人通知與反通知。 */
export function isNoticePayload(payload: DMCANotice | DMCACounterNoticeV1): payload is DMCANotice {
  return 'claimantEmail' in payload;
}

/** 以十六進位 nonce 與簽章欄位編碼簽署法律內容。 */
export interface SignedWire<T> {
  readonly payload: T;
  readonly timestamp: number;
  readonly nonceHex: string;
  readonly signer: string;
  readonly signatureHex: string;
}

/** 選擇簽署上傳者驗證或明示人工身分審查。 */
export type CounterNoticeSubmissionV1 =
  | {
      readonly mode: 'signed-uploader';
      readonly signed: SignedWire<DMCACounterNoticeV1>;
    }
  | { readonly mode: 'manual-review'; readonly payload: DMCACounterNoticeV1 };

/** 記錄反通知提交者身分的評估方式。 */
export type CounterIdentityStatus =
  'verified-uploader-signature' | 'pending-identity-review' | 'verified-manual' | 'rejected-manual';

/** 追蹤已受理反通知向原申訴人的投遞狀態。 */
export type CounterDeliveryStatus = 'not-ready' | 'pending' | 'delivered' | 'retrying';

/** 記錄依法暫停自動恢復的程序。 */
export interface LitigationHoldEvidence {
  readonly proceeding: 'us-federal-court' | 'copyright-claims-board';
  readonly reference: string;
  readonly receivedAt: number;
}

/** 在共用儲存中區分申訴人通知與上傳者反通知。 */
export type DmcaRecordType = 'notice' | 'counter-notice';

// pending-email-confirm：已提交、待寄信確認信箱真實性（防濫用關卡，尚未打擾任何人）
// received：信箱已確認、案件正式受理——notice 等待維運者審查；counter-notice 等待期已起算
// taken_down：admin 裁定成立、已下架（unpin 已執行）
// rejected_by_admin：admin 裁定不成立
// restored_after_counter：反通知等待期屆滿自動恢復，或 admin 提前恢復（re-pin 已執行）
/** 列舉通知與反通知共用的持久生命週期狀態。 */
export type DmcaNoticeStatus =
  | 'pending-email-confirm'
  | 'pending-identity-review'
  | 'received'
  | 'taken_down'
  | 'rejected_by_admin'
  | 'restored_after_counter';

/** 列舉受保護管理 API 接受的營運者裁定。 */
export type DmcaAdminAction = 'take_down' | 'reject' | 'restore' | 'hold' | 'release_hold';

/** 法律狀態之外，provider 是否仍持有可驗證的 exact-CID bytes。 */
export type DmcaResourceAvailability = 'available' | 'partial' | 'missing';

/** 在案件稽核軌跡中記錄一筆已驗證營運者裁定。 */
export interface DecisionLogEntry {
  action: DmcaAdminAction;
  reason: string;
  at: number;
  /** 由受保護的管理端部署設定注入，不接受 request body 自報。 */
  operatorId: string;
}

/** 提供受保護營運者清單使用的去識別案件列。 */
export interface AdminNoticeSummary {
  id: string;
  type: DmcaRecordType;
  status: DmcaNoticeStatus;
  createdAt: number;
  processedAt?: number;
  affectedCidCount: number;
  claimantLabelRedacted: string;
  hasPendingCounter: boolean;
  litigationHold: boolean;
}

/** 向已驗證營運者提供完整私人案件檢視。 */
export interface AdminNoticeDetail {
  id: string;
  type: DmcaRecordType;
  status: DmcaNoticeStatus;
  payload: DMCANotice | DMCACounterNoticeV1;
  affectedCIDs: string[];
  createdAt: number;
  processedAt?: number;
  litigationNoticedAt?: number;
  litigationHoldEvidence?: LitigationHoldEvidence;
  waitingPeriodEndDate?: number;
  restorationEligibleAt?: number;
  acceptedAt?: number;
  counterIdentityStatus?: CounterIdentityStatus;
  counterSignerPeerId?: string;
  counterIdentityDecisionAt?: number;
  counterIdentityDecisionReason?: string;
  counterIdentityDecisionOperatorId?: string;
  counterDeliveryStatus?: CounterDeliveryStatus;
  counterDeliveryAttemptCount?: number;
  counterDeliveryNextAttemptAt?: number;
  counterDeliveredAt?: number;
  counterDeliveryLastErrorCode?: string;
  resourceAvailability?: DmcaResourceAvailability;
  missingCIDs: string[];
  decisionLog: DecisionLogEntry[];
}

/** 包含刻意去識別且可安全公開報告的案件欄位。 */
export interface PublicView {
  noticeIdShort: string;
  // 組織公開／個人遮蔽：claimantOrganization 有填就顯示組織名，否則顯示「個人」通用標籤
  claimantOrgRedacted: string;
  cidsAffected: string[];
  status: DmcaNoticeStatus;
  timestamps: { createdAt: number; processedAt?: number };
}

/** 保存單一案件的完整私人狀態、稽核歷程與保留中繼資料。 */
export interface NoticeRecord {
  _id: string;
  type: DmcaRecordType;
  status: DmcaNoticeStatus;
  payload: DMCANotice | DMCACounterNoticeV1;
  affectedCIDs: string[];
  createdAt: number;
  processedAt?: number;
  litigationNoticedAt?: number;
  litigationHoldEvidence?: LitigationHoldEvidence;
  waitingPeriodEndDate?: number;
  restorationEligibleAt?: number;
  acceptedAt?: number;
  counterIdentityStatus?: CounterIdentityStatus;
  counterSignerPeerId?: string;
  counterIdentityDecisionAt?: number;
  counterIdentityDecisionReason?: string;
  counterIdentityDecisionOperatorId?: string;
  counterDeliveryStatus?: CounterDeliveryStatus;
  counterDeliveryAttemptCount?: number;
  counterDeliveryNextAttemptAt?: number;
  counterDeliveredAt?: number;
  counterDeliveryLastErrorCode?: string;
  /** 下架前由 provider 自己的 pin metadata 解析，不能採信通知表單的 creatorPeerId。 */
  uploaderByCid?: Record<string, string>;
  /** 恢復原 pin 與雙配額所需的 provider-local 最小 metadata；不含表單聯絡個資。 */
  pinMetadataByCid?: Record<string, DmcaPinMetadata>;
  /** 與法律狀態分離；恢復為合法不代表 provider 一定仍有 bytes。 */
  resourceAvailability?: DmcaResourceAvailability;
  missingCIDs?: string[];
  publicView: PublicView;
  /** 一次性確認 token（隨機 32 bytes hex）；confirm 成功後立刻清空，防止重放。 */
  confirmToken?: string;
  /** 確認信「實際寄送成功」的時間戳；同信箱冷卻判斷用——若上一筆 pending 案的確認信從未
   * 成功寄出（SMTP 失敗等），不能被冷卻擋死，下次同信箱提交仍應重新嘗試寄送（見
   * service.ts 的 submitNotice／submitCounter）。 */
  confirmMailSentAt?: number;
  /** admin 裁決稽核軌跡；每次 adminDecide／自動 restore 都附加一筆，供合規稽核與透明度統計使用。 */
  decisionLog: DecisionLogEntry[];
}

/** 保留恢復先前移除 pin 所需的最小供應者本機資料。 */
export interface DmcaPinMetadata {
  category: string;
  signer?: string;
  logicalSizeBytes: number;
  physicalSizeBytes: number;
  source: 'api' | 'auto';
}

/** 經 requester 驗簽後才回傳的 provider-local 最小案件通知；不得加入表單 payload 欄位。 */
export interface ProviderDmcaInboxEntry {
  noticeId: string;
  affectedCIDs: string[];
  legalStatus: DmcaNoticeStatus;
  resourceAvailability: DmcaResourceAvailability;
  waitingPeriodEndDate?: number;
  litigationHold: boolean;
  updatedAt: number;
}
