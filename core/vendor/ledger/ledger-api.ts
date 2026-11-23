/**
 * Open4wdLedger — canon LedgerApi 實作（storage 埠注入：事件鏈／檢查點永留庫／
 * 內容定址塊）。⭐驗證雙層設計：**fold 守門＝決定性檢查**（shape／單簽 timeless
 * 驗章／未來時戳排除；多簽事件之量化收件細則隨業務模組以 apply 守門落地——經濟
 * 重算等皆鏈上可決定）→ 所有 peer 無論何時同步 derive 收斂一致；**±30s 首播閘
 * ＝live 專屬**（倒填/未來時戳擋在鑄入端、歷史同步＝鏈上既成事實）——live 拒收
 * 只擋即時 fold／通知、決定性去留一律由 fold 層統一裁（與晚同步 peer 收斂）。
 * 狀態變更（ingest／refold）走單一佇列序列化。
 */
import * as dagCbor from '@ipld/dag-cbor';
import { Protocol } from '@open4wd/system-constants';
import type {
  CID,
  Ledger,
  LedgerAdmissionActivity,
  LedgerEvent,
  PeerId,
  Result,
  Signature,
  Timestamp,
  Unsubscribe,
} from '@open4wd/interfaces';
import { err, ok } from '@open4wd/interfaces';
// 深路徑匯入（不走 economy barrel 防環）：state-helpers 執行期僅依賴雜湊函式庫
import { gcExpiredWindowEntries } from '../economy/state-helpers';
import {
  bucketMatchesForCold,
  canFinalizeSignerSet,
  canonicalCheckpointSignatures,
  checkpointSignatureSigners,
  checkpointQuorum,
  isUnsignedCheckpointShape,
  shouldProposeCheckpoint,
  validateCheckpointSignatures,
} from './checkpoint';
import {
  decodeCheckpointBlock,
  LEDGER_CHECKPOINT_MAX_BYTES,
  type CheckpointStore,
} from './checkpoint-store';
import {
  CheckpointAdoptionQueue,
  type CheckpointAdoptionVerdict,
} from './checkpoint-adoption-queue';
import type { ColdPartitionKey } from './derive-utils';
import type {
  ApplierRegistry,
  ColdMatchPartition,
  DerivedState,
  MatchRecord,
} from './derived-state';
import { emptyDerivedState, MULTISIG_EVENT_TYPES } from './derived-state';
import { applyLedgerEntry, singleEraRulebook, type DeriveRulebook } from './derive-rulebook';
import { decodeLedgerEvent } from './event-codec';
import type {
  LedgerCheckpoint,
  LedgerCheckpointEvent,
  LedgerCheckpointProposal,
  MatchParticipantLoadout,
  MatchResultEvent,
  ClientVersionInfo,
} from './events';
import { peerIdToPublicKey, verifyMessage } from '../key-manager/ed25519';
import {
  canonicalLedgerEntryOrder,
  canonicalizeLedgerHeadCids,
  LedgerFrontierContinuityError,
  LRU_ENTRY_LIMIT,
  type BlockAccess,
  type EventLogStore,
  type LogEntry,
} from './orbit-log';
import {
  verifyEventSignature,
  verifyMatchResultSignatureSet,
  type ReceiveVerdict,
} from './receive-validation';
import { ledgerSigningDigest } from './ledger-signing';
import {
  hasProcessedPaymentIntent,
  isPaymentIntentEvent,
  type PaymentIntentEvent,
} from './payment-intent';
import {
  collectMatchHistoryPage,
  type MatchHistoryPage,
  type MatchHistoryPageRequest,
} from './match-history';
import {
  verifyInitialCheckpointProof,
  type InitialCheckpointProof,
} from './initial-checkpoint-proof';
import {
  cidOfBytes,
  decodeColdPartition,
  decodeDerivedState,
  decodeSignerSet,
  encodeColdPartition,
  encodeDerivedState,
  encodeSignerSet,
  LEDGER_COLD_PARTITION_MAX_BYTES,
  LEDGER_DERIVED_STATE_MAX_BYTES,
  LEDGER_SIGNER_SET_MAX_BYTES,
} from './state-codec';

const TOLERANCE_MS = Protocol.security.P2P_MESSAGE_TIMESTAMP_TOLERANCE_SEC * 1000;
/**
 * defer 重審延遲（可恢復拒收＝base 未同步／視圖暖中）：末次落在 ±30s 容忍窗外
 * ——屆時改走 fold timeless 守門統一裁定（live 閘只擋即時面）。
 */
const DEFER_RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000, 31_000];
/** deriveStateAt 總超時（含 OrbitDB＋IPFS 拉取） */
const DERIVE_STATE_TIMEOUT_MS = 10_000;
/** 提案 30 分鐘 expiry */
export const CHECKPOINT_PROPOSAL_EXPIRY_MS = 30 * 60 * 1000;
/** cold partition／derived state 塊拉取上限 */
const BLOCK_FETCH_TIMEOUT_MS = 10_000;
/** 啟動時前景等待 durable checkpoint announcement 掃描完成的上限。 */
export const STARTUP_CHECKPOINT_SCAN_TIMEOUT_MS = 30_000;
const IDLE_ADMISSION_ACTIVITY: LedgerAdmissionActivity = Object.freeze({
  phase: 'idle',
  queued: 0,
  startedAt: null,
  cid: null,
  canCancel: false,
  code: null,
});

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function sameSignatureList(left: readonly Signature[], right: readonly Signature[]): boolean {
  return (
    left.length === right.length &&
    left.every((signature, index) => sameBytes(signature, right[index]!))
  );
}

function sameHeadSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((head, index) => head === right[index]);
}

/**
 * live 首播預設驗證：標準事件走完整單簽收件；多簽事件此處放行——其量化收件
 * （match-result 三道等需結算情境）由組裝層以 validateIncoming 注入覆蓋。
 */
export function defaultLiveValidator(
  event: LedgerEvent,
  localNow: Timestamp,
  ledgerAddress?: string,
): ReceiveVerdict {
  if (MULTISIG_EVENT_TYPES.has(event.type)) return { kind: 'accept' };
  if (Math.abs(localNow - event.timestamp) > TOLERANCE_MS)
    return { kind: 'reject', reason: 'timestamp-out-of-range' };
  if (!verifyEventSignature(event, ledgerAddress))
    return { kind: 'reject', reason: 'invalid-signature' };
  return { kind: 'accept' };
}

/** 所有業務讀寫前必須滿足的 open、checkpoint 與 ingest 健康狀態。 */
export interface LedgerBusinessReadiness {
  readonly open: boolean;
  readonly checkpointReconciliationPending: boolean;
  readonly checkpointConflict: boolean;
  readonly ingestFailure: Error | null;
}

/** 每個公開業務 view 在 queue drain 前後共用的封閉式失敗 predicate。 */
export function assertLedgerBusinessReady(readiness: LedgerBusinessReadiness): void {
  if (!readiness.open) throw new Error('ledger 未 open');
  if (readiness.checkpointReconciliationPending)
    throw new Error('checkpoint startup reconciliation 尚未完成');
  if (readiness.checkpointConflict) throw new Error('checkpoint sibling conflict：帳本已隔離');
  if (readiness.ingestFailure !== null) throw readiness.ingestFailure;
}

/** fold 守門（決定性、不吃牆鐘）：單簽事件簽章不符＝跨 era 一致跳過 */
function foldGuard(event: LedgerEvent, ledgerAddress: string): boolean {
  // ⭐match-result＝簽章集 timeless 恆驗（log AC write:['*']——舊時戳條目繞過 live
  // 驗證直達 fold，多簽不驗＝任一 peer 可偽造結算入全網 state）；config-update 的
  // quorum 驗證需讀 state（prevEpoch signer set）＝守門在 economy applier 首行；其餘
  // 多簽型別無 state reducer（race-consensus-anchor/desync）或另有驗證路（checkpoint 三法）
  if (event.type === 'match-result')
    return verifyMatchResultSignatureSet(event as unknown as MatchResultEvent, ledgerAddress);
  if (MULTISIG_EVENT_TYPES.has(event.type)) return true;
  return verifyEventSignature(event, ledgerAddress);
}

/**
 * 單筆 canonical fold 的共同 fail-closed boundary。live 增量 fold 與 full refold
 * 必須共用：未來時戳、checkpoint control event、timeless 簽章守門與 reducer
 * 例外都收斂為 accepted=false，不允許單筆畸形事件中斷後續 replay。
 */
export function foldLedgerEntrySafely(
  state: DerivedState,
  event: LedgerEvent,
  entryCid: string,
  rulebook: DeriveRulebook,
  now: Timestamp,
  ledgerAddress: string,
): { accepted: boolean; state: DerivedState } {
  if (
    event.type === 'ledger-checkpoint' ||
    event.timestamp > now ||
    !foldGuard(event, ledgerAddress)
  )
    return { accepted: false, state };
  try {
    return applyLedgerEntry(state, event, entryCid, rulebook);
  } catch {
    return { accepted: false, state };
  }
}

/** MatchResultEvent →記憶體 MatchRecord 視圖（Record→Map；economy 等域 applier 重用） */
export function matchRecordFromEvent(
  event: MatchResultEvent,
  canonical: Pick<MatchRecord, 'settlement' | 'economyOutcome' | 'settledAt'> = {
    settlement: {
      mintEligible: false,
      monthFactorX100: 0,
      comboHash: '',
      matchPrizes: [],
      royalties: [],
    },
    economyOutcome: { status: 'not-eligible', mintedTotal: 0n },
    settledAt: event.timestamp,
  },
): MatchRecord {
  return {
    matchId: event.matchId,
    ranking: event.ranking,
    rounds: event.rounds,
    loadouts: new Map(Object.entries(event.loadouts) as [PeerId, MatchParticipantLoadout][]),
    matchRules: event.matchRules,
    disconnects: event.disconnects,
    startedAt: event.startedAt,
    finishedAt: event.finishedAt,
    ...canonical,
    clientVersions: new Map(Object.entries(event.clientVersions) as [PeerId, ClientVersionInfo][]),
  };
}

/**
 * ledger 自屬 reducer（結構性、非經濟）：match-result → hot MatchRecord（以
 * matchId 覆寫＝refold 冪等）；ledger-checkpoint＝no-op（持久化走檢查點庫、
 * pinning service 訂閱面）。經濟／信譽等域 reducer 由各業務模組併入 registry。
 */
export const ledgerCoreAppliers: ApplierRegistry = {
  'match-result': (state, event) => {
    const record = matchRecordFromEvent(event as MatchResultEvent);
    const recentMatches = new Map(state.match.recentMatches);
    recentMatches.set(record.matchId, record);
    return { ...state, match: { ...state.match, recentMatches } };
  },
  'ledger-checkpoint': (state) => state,
};

/** Ledger events 與 checkpoint proposals 使用的目前身分簽署埠。 */
export interface LedgerSigner {
  getPeerId(): PeerId;
  sign(message: Uint8Array): Promise<Signature>;
}

/** Open ledger runtime 所需的 event log、checkpoint 與 content block 三埠。 */
export interface LedgerPorts {
  log: EventLogStore;
  checkpoints: CheckpointStore;
  blocks: BlockAccess;
}

/** 遠端 checkpoint 採納後全量重摺或由 quorum state 跟隨的策略。 */
export type CheckpointAdoptionMode = 'full-refold' | 'quorum-follow';

/** Ledger 連線、簽署、derive、驗證與 checkpoint 啟動策略。 */
export interface Open4wdLedgerOptions {
  /** storage 三埠（瀏覽器＝orbit-log／checkpoint-store／createBlockAccess 產物） */
  connect: () => Promise<LedgerPorts>;
  signer: LedgerSigner;
  /** 域 reducer（預設僅 ledger 自屬；組裝層疊加業務域） */
  registry?: ApplierRegistry;
  /** 鏈錨定 derive 規則簿；省略時由 registry 建立單一 derive-v1 epoch。 */
  rulebook?: DeriveRulebook;
  /** live 首播驗證（預設 defaultLiveValidator；組裝層疊 match-result 三道） */
  validateIncoming?: (
    event: LedgerEvent,
    localNow: Timestamp,
    ledgerAddress: string,
  ) => ReceiveVerdict;
  /** 每次全量 fold 的共識 genesis；部署治理 trust root 必須由此進入所有重建路徑。 */
  genesisState?: () => DerivedState;
  /** 鏈重生專用來源 checkpoint proof；與 ordinary genesisState 嚴格互斥。 */
  initialCheckpointProof?: InitialCheckpointProof;
  now?: () => Timestamp;
  /** defer 重審延遲序列覆寫（測試縮短；省略＝2s／8s／31s） */
  deferRetryDelaysMs?: readonly number[];
  /** durable checkpoint startup scan 的前景等待上限；超時後不丟資料、改由背景續掃。 */
  checkpointStartupScanTimeoutMs?: number;
  /** 遠端 checkpoint 採納語意；瀏覽器預設全量重摺，輕節點可明示 quorum-follow。 */
  checkpointAdoptionMode?: CheckpointAdoptionMode;
}

/** 協調 event log、derive state、checkpoint、admission 與可靠通知的 ledger 門面。 */
export class Open4wdLedger implements Ledger {
  /** Runtime 連線、簽署與政策的 immutable options。 */
  readonly #options: Open4wdLedgerOptions;
  /** 所有 live/refold 共用的鏈錨定 derive rulebook。 */
  readonly #rulebook: DeriveRulebook;
  /** Live timestamp validation 與 checkpoint 建立使用的時鐘。 */
  readonly #now: () => Timestamp;
  /** 遠端 checkpoint 成功驗證後採取的 state 更新策略。 */
  readonly #checkpointAdoptionMode: CheckpointAdoptionMode;
  /** 已 commit accepted events 的業務 observers。 */
  readonly #handlers = new Set<(event: LedgerEvent) => void>();
  /** Admission activity 的 UI observers。 */
  readonly #admissionHandlers = new Set<(activity: LedgerAdmissionActivity) => void>();

  /** Open 後持有的 log/checkpoint/block ports。 */
  #ports: LedgerPorts | null = null;
  /** 最新 committed fold derived state。 */
  #state: DerivedState;
  /** open 時完整驗證後的 rebirth genesis；close／失敗即清除並於下次 open 重驗。 */
  #resolvedInitialCheckpointState: DerivedState | null = null;
  /** 事件 log 更新 subscription 清理。 */
  #unsubscribe: Unsubscribe | null = null;
  /** 准入活動 subscription 清理。 */
  #unsubscribeAdmission: Unsubscribe | null = null;
  /** 最新 admission writer activity 快照。 */
  #admissionActivity = IDLE_ADMISSION_ACTIVITY;
  /** 狀態變更佇列——ingest 與 refold 序列化，防非同步交錯覆寫（lost update） */
  #queue: Promise<void> = Promise.resolve();
  /** finalize／遠端 adoption 共用 compare-and-commit 序列。 */
  #checkpointQueue: Promise<void> = Promise.resolve();
  /** 與 fold queue 隔離的 bounded remote checkpoint adoption queue。 */
  #adoptionQueue: CheckpointAdoptionQueue<LedgerCheckpointEvent> | null = null;
  /** 本 runtime finalize 已公告但尚未完成 local commit；失敗交由明確 retry，重啟才重播採納。 */
  readonly #locallyDeferredAnnouncements = new Set<CID>();
  /** durable sibling conflict 載入後 fail-closed；只允許 log transport 繼續同步。 */
  #checkpointConflict = false;
  /** conflict 已 durable、但 effective pointer/state 尚未回到共同 previous；業務讀取也必須阻擋。 */
  #checkpointReconciliationPending = false;
  /** Conflict quarantine 已啟動但共同祖先 state 尚未重建。 */
  #checkpointConflictReconciliationPending = false;
  /** Durable log checkpoint announcements 的啟動掃描正在進行。 */
  #startupCheckpointScanActive = false;
  /** 掃描期間有新 announcement，完成後需再掃一輪。 */
  #checkpointRescanRequested = false;
  /** 丟棄舊 async startup scan 結果的 generation。 */
  #startupScanGeneration = 0;
  /** Startup scan 已驗過的 checkpoint CIDs。 */
  readonly #startupExaminedCheckpointCids = new Set<CID>();
  /** 取得 serialization lock 後重讀的 durable CAS epoch。 */
  #checkpointRevision = 0;
  /** durable log 已前進但增量 fold 失敗：full refold 完成前所有業務讀寫 fail-closed。 */
  #ingestFailure: Error | null = null;
  /** Ingest failure 的 full-refold recovery 是否已排程。 */
  #recoveryScheduled = false;
  /** 已套用 segment 的 canonical 尾鍵、frontier 與 entry 去重集。 */
  #lastCanonicalEntry: LogEntry | null = null;
  /** 目前 state 已 fold 到的完整 canonical frontier。 */
  #foldFrontier: readonly string[] = [];
  /**
   * 通過確定性 fold 准入且實際交給 applier 的 entry。
   * Refold 會以 checkpoint 後有界 replay window（本機 log 上限 10k）取代此集合，
   * 因此通知 diff 不會脫離保留的帳本 entry 獨立成長。
   */
  readonly #acceptedEntries = new Map<string, LogEntry>();
  /** 已接受但未通知的 payload；獨立於 checkpoint 後已接受 replay window。 */
  readonly #pendingNotificationEntries = new Map<string, LogEntry>();
  /** 已證明由完整驗證／採用 checkpoint 涵蓋的待處理 entry。 */
  readonly #checkpointCoveredPendingNotifications = new Set<string>();
  /** 已交付至目前 runtime 事件 stream 的 hash。 */
  readonly #notifiedEntryHashes = new Set<string>();
  /** 初次 refold 後才允許把新 accepted events 通知業務 observers。 */
  #notificationBaselineEstablished = false;
  /** defer 重審 timer（close 時全清） */
  readonly #deferTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: Open4wdLedgerOptions) {
    if (options.genesisState !== undefined && options.initialCheckpointProof !== undefined)
      throw new TypeError(
        'ordinary genesisState and initialCheckpointProof are mutually exclusive',
      );
    const adoptionMode = options.checkpointAdoptionMode ?? 'full-refold';
    if (adoptionMode !== 'full-refold' && adoptionMode !== 'quorum-follow')
      throw new TypeError('unknown checkpoint adoption mode');
    this.#options = options;
    this.#rulebook =
      options.rulebook === undefined
        ? singleEraRulebook('derive-v1', 1, { ...ledgerCoreAppliers, ...options.registry })
        : {
            ...options.rulebook,
            eras: options.rulebook.eras.map((era) => ({
              ...era,
              registry: { ...ledgerCoreAppliers, ...era.registry },
            })),
          };
    this.#now = options.now ?? (() => Date.now());
    this.#checkpointAdoptionMode = adoptionMode;
    this.#state =
      options.initialCheckpointProof === undefined ? this.#genesisState() : emptyDerivedState();
  }

  /** 從指定 state 取得 checkpoint governance signer set。 */
  #authorizedSignerSet(state: DerivedState): ReadonlySet<PeerId> {
    return new Set(state.economyConfig.governanceSigners);
  }

  get ledgerAddress(): string {
    return this.#ports?.log.address ?? '';
  }

  /** 開啟本機帳本、索引與同步端口，完成初始重建後才提供讀寫服務。 */
  async open(myPeerId: PeerId): Promise<Result<void>> {
    if (this.#ports !== null) return err(new Error('open：ledger 已開啟'));
    if (myPeerId !== this.#options.signer.getPeerId())
      return err(new Error('open：myPeerId 與 signer 身分不符'));
    let connected: LedgerPorts | null = null;
    try {
      connected = await this.#options.connect();
      this.#ports = connected;
      if (this.#options.initialCheckpointProof !== undefined) {
        this.#resolvedInitialCheckpointState = await verifyInitialCheckpointProof(
          this.#options.initialCheckpointProof,
          connected.blocks,
        );
        this.#state = this.#resolvedInitialCheckpointState;
      }
      this.#unsubscribeAdmission =
        connected.log.onAdmissionActivity?.((activity) => {
          this.#admissionActivity = activity;
          this.#notifyAdmission(activity);
        }) ?? null;
      const existingConflict = await connected.checkpoints.getConflict();
      this.#checkpointRevision = await connected.checkpoints.getRevision();
      this.#checkpointConflict = existingConflict !== null;
      this.#checkpointConflictReconciliationPending = existingConflict !== null;
      // durable announcement watermark 尚未穩定前，一律 fail-closed；open timeout 只釋放 UI。
      this.#checkpointReconciliationPending = true;
      this.#startupCheckpointScanActive = true;
      this.#checkpointRescanRequested = true;
      const startupGeneration = ++this.#startupScanGeneration;
      this.#adoptionQueue = new CheckpointAdoptionQueue((event, signal) =>
        this.#serializeCheckpoint(
          () => this.#adoptCheckpointAnnouncement(event, signal),
          signal,
          'rejected',
        ),
      );
      this.#unsubscribe = connected.log.onUpdate((entry) => {
        void this.#enqueue(async () => {
          if (this.#ingestFailure !== null) return;
          try {
            await this.#applyEntry(entry);
          } catch (cause) {
            this.#ingestFailure =
              cause instanceof Error ? cause : new Error(`ledger ingest failed: ${String(cause)}`);
            throw this.#ingestFailure;
          }
        }).catch(() => this.#scheduleIngestRecovery());
      });
      await this.#rebuildFromCheckpoint();
      this.#checkpointConflictReconciliationPending = false;
      // restart 不能只信 latest pointer：repeat-until-stable 掃 durable log；timeout 後背景續跑。
      const scanPromise = this.#scanCheckpointAnnouncementsUntilStable(
        connected,
        startupGeneration,
      );
      void scanPromise.catch((cause) => {
        if (this.#startupScanGeneration !== startupGeneration || this.#ports === null) return;
        this.#ingestFailure =
          cause instanceof Error
            ? cause
            : new Error(`checkpoint startup scan failed: ${String(cause)}`);
      });
      const scanTimeout =
        this.#options.checkpointStartupScanTimeoutMs ?? STARTUP_CHECKPOINT_SCAN_TIMEOUT_MS;
      if (!Number.isSafeInteger(scanTimeout) || scanTimeout < 0)
        throw new RangeError('invalid checkpoint startup scan timeout');
      await new Promise<void>((resolve, reject) => {
        const handle = setTimeout(resolve, scanTimeout);
        void scanPromise.then(
          () => {
            clearTimeout(handle);
            resolve();
          },
          (cause) => {
            clearTimeout(handle);
            reject(cause);
          },
        );
      });
      return ok(undefined);
    } catch (cause) {
      this.#unsubscribe?.();
      this.#unsubscribe = null;
      this.#unsubscribeAdmission?.();
      this.#unsubscribeAdmission = null;
      this.#publishIdleAdmission();
      await this.#adoptionQueue?.stop();
      this.#adoptionQueue = null;
      this.#checkpointConflict = false;
      this.#checkpointReconciliationPending = false;
      this.#checkpointConflictReconciliationPending = false;
      this.#startupCheckpointScanActive = false;
      this.#startupScanGeneration++;
      this.#startupExaminedCheckpointCids.clear();
      this.#ingestFailure = null;
      this.#acceptedEntries.clear();
      this.#pendingNotificationEntries.clear();
      this.#checkpointCoveredPendingNotifications.clear();
      this.#notifiedEntryHashes.clear();
      this.#notificationBaselineEstablished = false;
      this.#resolvedInitialCheckpointState = null;
      this.#state =
        this.#options.initialCheckpointProof === undefined
          ? this.#genesisState()
          : emptyDerivedState();
      this.#ports = null;
      if (connected !== null) {
        try {
          await this.#disposePorts(connected);
        } catch {
          /* preserve the original open failure */
        }
      }
      return err(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  /** 停止目前帳本或儲存元件並釋放監聽、連線與背景工作。 */
  async close(): Promise<void> {
    this.#startupScanGeneration++;
    this.#checkpointRescanRequested = false;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#unsubscribeAdmission?.();
    this.#unsubscribeAdmission = null;
    this.#publishIdleAdmission();
    for (const handle of this.#deferTimers) clearTimeout(handle);
    this.#deferTimers.clear();
    if (this.#ports !== null) {
      const ports = this.#ports;
      await this.#adoptionQueue?.stop();
      this.#adoptionQueue = null;
      await this.#checkpointQueue;
      this.#ports = null;
      await this.#queue;
      await this.#disposePorts(ports);
    }
    this.#checkpointConflict = false;
    this.#checkpointReconciliationPending = false;
    this.#checkpointConflictReconciliationPending = false;
    this.#startupCheckpointScanActive = false;
    this.#startupExaminedCheckpointCids.clear();
    this.#checkpointRevision = 0;
    this.#ingestFailure = null;
    this.#recoveryScheduled = false;
    this.#lastCanonicalEntry = null;
    this.#foldFrontier = [];
    this.#acceptedEntries.clear();
    this.#pendingNotificationEntries.clear();
    this.#checkpointCoveredPendingNotifications.clear();
    this.#notifiedEntryHashes.clear();
    this.#notificationBaselineEstablished = false;
    this.#locallyDeferredAnnouncements.clear();
    this.#resolvedInitialCheckpointState = null;
    this.#state =
      this.#options.initialCheckpointProof === undefined
        ? this.#genesisState()
        : emptyDerivedState();
  }

  /** 關閉指定帳本端口及其背景工作，彙整清理期間發生的錯誤。 */
  async #disposePorts(ports: LedgerPorts): Promise<void> {
    let failure: unknown;
    try {
      if (ports.log.stop !== undefined) await ports.log.stop();
      else await ports.log.close();
    } catch (error) {
      failure = error;
    }
    try {
      await ports.checkpoints.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }

  // ── 寫入 ──

  /** 標準單簽事件：自動 stamp（本地鐘）＋自動簽章 */
  async appendEvent<T extends LedgerEvent>(
    event: Omit<T, 'signature' | 'peerId' | 'timestamp'>,
  ): Promise<Result<string>> {
    const ports = this.#ports;
    if (ports === null) return err(new Error('ledger 未 open'));
    if (this.#checkpointReconciliationPending)
      return err(new Error('checkpoint startup reconciliation 尚未完成'));
    if (this.#checkpointConflict) return err(new Error('checkpoint sibling conflict：帳本已隔離'));
    if (this.#ingestFailure !== null) return err(new Error('ledger ingest recovery 尚未完成'));
    try {
      const unsigned = {
        ...event,
        timestamp: this.#now(),
        peerId: this.#options.signer.getPeerId(),
        signature: new Uint8Array(0) as Signature,
      };
      const signature = await this.#options.signer.sign(
        ledgerSigningDigest(ports.log.address, unsigned),
      );
      const signed = { ...unsigned, signature } as LedgerEvent;
      if (
        isPaymentIntentEvent(signed) &&
        hasProcessedPaymentIntent(this.#state, signed as PaymentIntentEvent)
      )
        return err(new Error('payment intent already processed'));
      const hash = await ports.log.add(signed);
      return ok(hash);
    } catch (cause) {
      return err(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  /**
   * 多簽事件寫入（match-result／race-consensus-anchor 等）：timestamp／peerId 已由提案
   * 流程定稿且被 signatures[] 覆蓋——原樣上鏈、不得重 stamp（會廢掉全部簽章）。
   */
  async appendPreSigned(event: LedgerEvent): Promise<Result<string>> {
    const ports = this.#ports;
    if (ports === null) return err(new Error('ledger 未 open'));
    if (this.#checkpointReconciliationPending)
      return err(new Error('checkpoint startup reconciliation 尚未完成'));
    if (this.#checkpointConflict) return err(new Error('checkpoint sibling conflict：帳本已隔離'));
    if (this.#ingestFailure !== null) return err(new Error('ledger ingest recovery 尚未完成'));
    try {
      if (
        isPaymentIntentEvent(event) &&
        hasProcessedPaymentIntent(this.#state, event as PaymentIntentEvent)
      )
        return err(new Error('payment intent already processed'));
      return ok(await ports.log.add(event));
    } catch (cause) {
      return err(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  // ── 讀取 ──

  /** 自指定 checkpoint 之後串流讀取帳本事件，避免一次載入完整歷史。 */
  async *readEvents(sinceCheckpoint?: CID): AsyncIterable<LedgerEvent> {
    const ports = this.#requirePorts();
    let entries;
    if (sinceCheckpoint === undefined) {
      entries = await ports.log.all();
    } else {
      const checkpoint = await ports.checkpoints.load(sinceCheckpoint);
      entries =
        checkpoint === null
          ? await ports.log.all()
          : await ports.log.entriesBetween(checkpoint.log_head_cids, await ports.log.heads());
    }
    for (const entry of entries) {
      const event = decodeLedgerEvent(entry.value);
      if (event !== null) yield event;
    }
  }

  /** 讀取目前可達的全部帳本事件，回傳不可變快照供診斷或重建使用。 */
  async getAllEvents(): Promise<readonly LedgerEvent[]> {
    const ports = this.#requirePorts();
    const entries = await ports.log.all();
    return entries
      .map((entry) => decodeLedgerEvent(entry.value))
      .filter((event): event is LedgerEvent => event !== null);
  }

  /** 取得由目前已驗證事件推導出的最新應用狀態快照。 */
  async getDerivedState(): Promise<DerivedState> {
    await this.#awaitBusinessReady();
    return this.#state;
  }

  /** 取得目前帳本各分支的最新內容識別碼，供增量同步與 checkpoint 使用。 */
  async getLatestLogHeads(): Promise<readonly CID[]> {
    return (await this.#requirePorts().log.heads()) as CID[];
  }

  /** 訂閱新採用的帳本事件，並回傳可停止接收通知的函式。 */
  onEvent(handler: (event: LedgerEvent) => void): Unsubscribe {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  /** 訂閱 admission 佇列狀態，供介面顯示處理中、重試或失敗。 */
  onAdmissionActivity(handler: (activity: LedgerAdmissionActivity) => void): Unsubscribe {
    this.#admissionHandlers.add(handler);
    try {
      handler(this.#admissionActivity);
    } catch {
      // 狀態觀察者屬 UI 邊界；不得反向中斷帳本生命週期。
    }
    return () => this.#admissionHandlers.delete(handler);
  }

  /** 中止目前 admission 計算與提交工作，但保留可恢復的持久紀錄。 */
  cancelAdmissionWork(): Promise<void> {
    return this.#ports?.log.cancelAdmissionWork?.() ?? Promise.resolve();
  }

  /** Close/disconnect 時發布一次 idle admission 快照。 */
  #publishIdleAdmission(): void {
    if (this.#admissionActivity.phase === 'idle') return;
    this.#admissionActivity = IDLE_ADMISSION_ACTIVITY;
    this.#notifyAdmission(IDLE_ADMISSION_ACTIVITY);
  }

  /** 隔離通知 admission observers，避免 UI 例外影響 ledger。 */
  #notifyAdmission(activity: LedgerAdmissionActivity): void {
    for (const handler of [...this.#admissionHandlers]) {
      try {
        handler(activity);
      } catch {
        // 單一 UI 觀察者故障不影響其他觀察者或帳本提交流程。
      }
    }
  }

  // ── 比賽記錄查詢（hot → cold lazy） ──

  /** 依 「matchId」 取得 Promise<MatchRecord | null>；沒有符合項目時回傳空值，且不修改來源資料。 */
  async getMatchRecord(matchId: string): Promise<MatchRecord | null> {
    await this.#awaitBusinessReady();
    const hot = this.#state.match.recentMatches.get(matchId);
    if (hot !== undefined) return hot;
    // hot miss → cold 由新到舊逐 partition 拉（quarter 鍵字典序＝時間序）
    const keys = [...this.#state.coldMatchPartitions.keys()].sort().reverse();
    for (const key of keys) {
      const found = await this.#getMatchFromPartitionReady(key, matchId);
      if (found !== null) return found;
    }
    return null;
  }

  /** 依 「key」 與 「matchId」 取得 Promise<MatchRecord | null>；沒有符合項目時回傳空值，且不修改來源資料。 */
  async getMatchFromPartition(key: ColdPartitionKey, matchId: string): Promise<MatchRecord | null> {
    await this.#awaitBusinessReady();
    return this.#getMatchFromPartitionReady(key, matchId);
  }

  /** 依 「key」 與 「matchId」 取得 Promise<MatchRecord | null>；沒有符合項目時回傳空值，且不修改來源資料。 */
  async #getMatchFromPartitionReady(
    key: ColdPartitionKey,
    matchId: string,
  ): Promise<MatchRecord | null> {
    const partition = await this.#getColdPartitionReady(key);
    return partition?.matchRecords.get(matchId) ?? null;
  }

  /** 依 「key」 取得 Promise<ColdMatchPartition | null>；沒有符合項目時回傳空值，且不修改來源資料。 */
  async #getColdPartitionReady(key: ColdPartitionKey): Promise<ColdMatchPartition | null> {
    const cid = this.#state.coldMatchPartitions.get(key);
    if (cid === undefined) return null;
    const bytes = await this.#requirePorts().blocks.get(
      cid,
      BLOCK_FETCH_TIMEOUT_MS,
      LEDGER_COLD_PARTITION_MAX_BYTES,
    );
    this.#assertBusinessReady();
    if (bytes === null) return null;
    return decodeColdPartition(bytes);
  }

  /** 依 「peerId」 與 「request」 取得 Promise<MatchHistoryPage>，且不修改來源資料。 */
  async getRecentMatchesForPlayer(
    peerId: PeerId,
    request: MatchHistoryPageRequest = {},
  ): Promise<MatchHistoryPage> {
    await this.#awaitBusinessReady();
    return collectMatchHistoryPage({
      peerId,
      hotRecords: this.#state.match.recentMatches,
      coldPartitionKeys: [...this.#state.coldMatchPartitions.keys()],
      loadPartition: (key) => this.#getColdPartitionReady(key),
      request,
    });
  }

  // ── 推導 ──

  /** canon 純函數形：不動本機 cache；塊／條目拉不齊（總超時 10s）回 null */
  async deriveStateAt(logHeadCids: readonly CID[]): Promise<DerivedState | null> {
    const deadline = this.#now() + DERIVE_STATE_TIMEOUT_MS;
    try {
      const canonical = canonicalizeLedgerHeadCids(logHeadCids) as CID[];
      return await this.#withDeadline(this.#deriveStateAtInner(canonical), deadline);
    } catch {
      return null;
    }
  }

  /** 從指定 log heads 推導一致狀態；歷史不足或無法驗證時回傳空值。 */
  async #deriveStateAtInner(logHeadCids: readonly CID[]): Promise<DerivedState | null> {
    const ports = this.#requirePorts();
    const now = this.#now();
    const latest = await ports.checkpoints.getLatest();
    if (latest !== null) {
      const bytes = await ports.blocks.get(
        latest.checkpoint.derived_state_cid,
        BLOCK_FETCH_TIMEOUT_MS,
        LEDGER_DERIVED_STATE_MAX_BYTES,
      );
      if (bytes !== null) {
        try {
          if (sameHeadSet(latest.checkpoint.log_head_cids, logHeadCids))
            return decodeDerivedState(bytes);
          const entries = await ports.log.entriesBetween(
            latest.checkpoint.log_head_cids,
            logHeadCids,
          );
          return this.#foldEntries(decodeDerivedState(bytes), entries, now).state;
        } catch {
          // 檢查點 head 不在目標鏈上（fork 邊界）→ 落到全量 replay
        }
      }
    }
    // 目標 head 未知＝entriesAfter 拋出→外層 null（兼 canon reviewAndSign「log_head
    // 須為當前 head 祖先」檢核——不在本地鏈上即重算失敗拒簽）
    const entries = await ports.log.entriesBetween([], logHeadCids);
    return this.#foldEntries(this.#genesisState(), entries, now).state;
  }

  // ── 檢查點三法（本代 authority＝previous checkpoint state；首代＝genesis） ──

  /** 依目前穩定帳本狀態建立 checkpoint 提案，並以結果回報是否具備提案資格。 */
  async proposeCheckpoint(): Promise<Result<LedgerCheckpointProposal>> {
    const ports = this.#requirePorts();
    await this.#queue;
    if (this.#checkpointReconciliationPending)
      return err(new Error('proposeCheckpoint：checkpoint startup reconciliation 尚未完成'));
    if (this.#ingestFailure !== null)
      return err(new Error('proposeCheckpoint：ledger ingest recovery 尚未完成'));
    if (this.#checkpointConflict)
      return err(new Error('proposeCheckpoint：checkpoint sibling conflict 已隔離'));
    const me = this.#options.signer.getPeerId();

    const latest = await ports.checkpoints.getLatest();
    if (latest !== null && !shouldProposeCheckpoint(latest.checkpoint.timestamp, this.#now()))
      return err(new Error('proposeCheckpoint：距上一檢查點未滿間隔'));
    const previousCid = latest?.cid ?? null;
    const logHeads = await ports.log.heads();
    if (logHeads.length === 0) return err(new Error('proposeCheckpoint：空帳本'));
    const frontierState = await this.deriveStateAt(logHeads as CID[]);
    if (frontierState === null)
      return err(new Error('proposeCheckpoint：無法從完整 ledger frontier 推導狀態'));
    const authorityState = await this.#checkpointAuthorityState(previousCid);
    if (authorityState === null)
      return err(new Error('proposeCheckpoint：前一 checkpoint 治理狀態不可得'));
    const signerSet = this.#authorizedSignerSet(authorityState);
    if (!canFinalizeSignerSet(signerSet.size))
      return err(new Error('proposeCheckpoint：signer set 只允許 N=1 或 N>=3'));
    if (!signerSet.has(me)) return err(new Error('proposeCheckpoint：非治理 signer'));

    const built = await this.#buildCheckpointState(frontierState, previousCid);
    if (!built.ok) return built;
    for (const block of built.value.coldBlocks) {
      await ports.blocks.putDagCbor(block.bytes);
      await ports.blocks.pin(block.cid);
    }
    const stateBytes = encodeDerivedState(built.value.state);
    const derivedStateCid = await ports.blocks.putDagCbor(stateBytes);
    await ports.blocks.pin(derivedStateCid);
    const signerSetCid = await ports.blocks.putDagCbor(encodeSignerSet(signerSet));
    await ports.blocks.pin(signerSetCid);

    const checkpoint: Omit<LedgerCheckpoint, 'signatures'> = {
      checkpoint_version: 1,
      timestamp: this.#now(),
      log_head_cids: logHeads as CID[],
      derived_state_cid: derivedStateCid,
      previous_checkpoint_cid: previousCid,
      signer_set_cid: signerSetCid,
      signer_set_size: signerSet.size,
      quorum: checkpointQuorum(signerSet.size),
      proposer: me,
    };
    const digest = ledgerSigningDigest(ports.log.address, checkpoint);
    const proposerSignature = await this.#options.signer.sign(digest);
    return ok({
      proposalId: cidOfBytes(digest),
      checkpoint,
      proposer: me,
      proposerSignature,
      expiresAt: this.#now() + CHECKPOINT_PROPOSAL_EXPIRY_MS,
    });
  }

  /** reviewAndSign：驗提案簽章→節流→期限→重算 derived state 逐位比對→簽 */
  async signCheckpoint(proposal: LedgerCheckpointProposal): Promise<Result<Signature>> {
    const ports = this.#requirePorts();
    if (this.#checkpointReconciliationPending)
      return err(new Error('signCheckpoint：checkpoint startup reconciliation 尚未完成'));
    if (this.#checkpointConflict)
      return err(new Error('signCheckpoint：checkpoint sibling conflict 已隔離'));
    const { checkpoint } = proposal;
    if (
      !isUnsignedCheckpointShape(checkpoint) ||
      !Number.isSafeInteger(proposal.expiresAt) ||
      proposal.proposerSignature.byteLength !== 64
    )
      return err(new Error('signCheckpoint：提案 shape 無效'));
    const latest = await ports.checkpoints.getLatest();
    if (checkpoint.previous_checkpoint_cid !== (latest?.cid ?? null))
      return err(new Error('signCheckpoint：previous checkpoint 已過期'));
    if (this.#now() > proposal.expiresAt) return err(new Error('signCheckpoint：提案已過期'));
    const proposerKey = peerIdToPublicKey(proposal.proposer);
    if (
      proposerKey === null ||
      proposal.proposer !== checkpoint.proposer ||
      !verifyMessage(
        proposerKey,
        ledgerSigningDigest(ports.log.address, checkpoint),
        proposal.proposerSignature,
      )
    )
      return err(new Error('signCheckpoint：提案簽章無效'));
    const candidateFold = await this.#deriveCheckpointCandidateState(checkpoint);
    if (candidateFold === null) return err(new Error('signCheckpoint：無法重算 derived state'));
    const authorityState = await this.#checkpointAuthorityState(checkpoint.previous_checkpoint_cid);
    if (authorityState === null)
      return err(new Error('signCheckpoint：前一 checkpoint 治理狀態不可得'));
    const signerSet = this.#authorizedSignerSet(authorityState);
    if (!signerSet.has(proposal.proposer))
      return err(new Error('signCheckpoint：提案者不在治理 signer set'));
    if (
      checkpoint.signer_set_size !== signerSet.size ||
      checkpoint.quorum !== checkpointQuorum(signerSet.size) ||
      cidOfBytes(encodeSignerSet(signerSet)) !== checkpoint.signer_set_cid
    )
      return err(new Error('signCheckpoint：signer set／quorum 與前一 checkpoint 治理不符'));
    if (checkpoint.previous_checkpoint_cid !== null) {
      const previous = await ports.checkpoints.load(checkpoint.previous_checkpoint_cid);
      if (previous !== null && !shouldProposeCheckpoint(previous.timestamp, checkpoint.timestamp))
        return err(new Error('signCheckpoint：距上一檢查點未滿間隔（節流拒簽）'));
    }
    const rebuilt = await this.#buildCheckpointState(
      candidateFold.state,
      checkpoint.previous_checkpoint_cid,
    );
    if (!rebuilt.ok) return rebuilt;
    if (cidOfBytes(encodeDerivedState(rebuilt.value.state)) !== checkpoint.derived_state_cid)
      return err(new Error('signCheckpoint：derived state 重算不符'));
    return ok(await this.#options.signer.sign(ledgerSigningDigest(ports.log.address, checkpoint)));
  }

  /** 驗證 checkpoint 提案與足夠簽署後寫入最終 checkpoint，拒絕狀態或摘要不一致的內容。 */
  async finalizeCheckpoint(
    proposal: LedgerCheckpointProposal,
    signatures: readonly Signature[],
  ): Promise<Result<CID>> {
    // durable conflict 設旗後不得排在仍待 pointer reconciliation 的 checkpoint queue 後等待。
    if (this.#checkpointReconciliationPending)
      return err(new Error('finalizeCheckpoint：checkpoint startup reconciliation 尚未完成'));
    if (this.#checkpointConflict)
      return err(new Error('finalizeCheckpoint：checkpoint sibling conflict 已隔離'));
    return this.#serializeCheckpoint(() => this.#finalizeCheckpointInner(proposal, signatures));
  }

  /** 在序列化鎖內完成 checkpoint 驗證、寫入與公告，避免並行最終化。 */
  async #finalizeCheckpointInner(
    proposal: LedgerCheckpointProposal,
    signatures: readonly Signature[],
  ): Promise<Result<CID>> {
    const ports = this.#requirePorts();
    if (this.#checkpointConflict)
      return err(new Error('finalizeCheckpoint：checkpoint sibling conflict 已隔離'));
    if (
      !isUnsignedCheckpointShape(proposal.checkpoint) ||
      !Number.isSafeInteger(proposal.expiresAt) ||
      proposal.expiresAt < 0
    )
      return err(new Error('finalizeCheckpoint：提案 shape 無效'));
    if (signatures.length !== proposal.checkpoint.quorum || signatures.length > 64)
      return err(new Error('finalizeCheckpoint：簽章集不是 canonical quorum'));
    if (this.#now() > proposal.expiresAt) return err(new Error('finalizeCheckpoint：提案已過期'));
    const latest = await ports.checkpoints.getLatest();
    const authorityState = await this.#checkpointAuthorityState(
      proposal.checkpoint.previous_checkpoint_cid,
    );
    if (authorityState === null)
      return err(new Error('finalizeCheckpoint：前一 checkpoint 治理狀態不可得'));
    const signerSet = this.#authorizedSignerSet(authorityState);
    if (
      !signerSet.has(proposal.checkpoint.proposer) ||
      proposal.checkpoint.signer_set_size !== signerSet.size ||
      proposal.checkpoint.quorum !== checkpointQuorum(signerSet.size) ||
      cidOfBytes(encodeSignerSet(signerSet)) !== proposal.checkpoint.signer_set_cid
    )
      return err(new Error('finalizeCheckpoint：signer set 未錨定前一 checkpoint 治理狀態'));
    const canonicalSignatures = canonicalCheckpointSignatures(
      proposal.checkpoint,
      signatures,
      signerSet,
      ports.log.address,
    );
    if (canonicalSignatures === null)
      return err(new Error('finalizeCheckpoint：簽章數未達 quorum 或簽章無效'));
    const full: LedgerCheckpoint = { ...proposal.checkpoint, signatures: canonicalSignatures };
    const encoded = dagCbor.encode(full);
    const encodedBytes = new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    const candidateCid = cidOfBytes(encodedBytes);
    if (proposal.checkpoint.previous_checkpoint_cid !== (latest?.cid ?? null)) {
      // 另一同源 runtime 可能已從本次 durable announcement 採納同一 CID；retry 冪等成功。
      if (latest?.cid === candidateCid && this.#locallyDeferredAnnouncements.has(candidateCid)) {
        const pending = await ports.checkpoints.getPendingBoundaryAdvance();
        if (pending?.cid === candidateCid) {
          await ports.log.advanceCheckpointBoundary?.(pending.checkpoint.log_head_cids);
          this.#checkpointRevision = await ports.checkpoints.completeBoundaryAdvance(
            candidateCid,
            this.#checkpointRevision,
          );
        }
        this.#locallyDeferredAnnouncements.delete(candidateCid);
        return ok(candidateCid);
      }
      return err(new Error('finalizeCheckpoint：previous checkpoint 已過期'));
    }
    try {
      await ports.log.entriesBetween(latest?.checkpoint.log_head_cids ?? [], full.log_head_cids);
    } catch {
      return err(new Error('finalizeCheckpoint：log head 不在目前已驗鏈上'));
    }
    let preparedBoundary: { commit(): void; rollback(): void } | undefined;
    try {
      const cid = await ports.blocks.putDagCbor(encodedBytes);
      if (cid !== candidateCid) throw new Error('finalizeCheckpoint：content store CID 不一致');
      await ports.blocks.pin(cid);
      await ports.checkpoints.save(cid, full);
      // announcement 可能已在前次 setLatest failure 前成功；先掃 canon log，retry 不重複。
      const alreadyAnnounced = (await ports.log.all()).some((entry) => {
        const event = decodeLedgerEvent(entry.value);
        return (
          event?.type === 'ledger-checkpoint' &&
          'checkpointCid' in event &&
          event.checkpointCid === cid
        );
      });
      this.#locallyDeferredAnnouncements.add(cid);
      if (!alreadyAnnounced) {
        const announced = await this.appendPreSigned({
          type: 'ledger-checkpoint',
          timestamp: this.#now(),
          peerId: this.#options.signer.getPeerId(),
          signature: new Uint8Array(0) as Signature,
          checkpointCid: cid,
          signatures: full.signatures,
        } as LedgerEvent);
        if (!announced.ok) {
          this.#locallyDeferredAnnouncements.delete(cid);
          return announced;
        }
      }
      // crash-safe 順序：redo journal → durable pointer → boundary/eviction → journal complete。
      // pointer 前絕不授予 coverage；pointer 後 crash 最多多留舊資料，重啟可安全 redo。
      this.#checkpointRevision = await ports.checkpoints.beginBoundaryAdvance(
        cid,
        this.#checkpointRevision,
      );
      this.#checkpointRevision = await ports.checkpoints.setLatest(cid, this.#checkpointRevision);
      preparedBoundary = await ports.log.prepareCheckpointBoundary?.(full.log_head_cids);
      preparedBoundary?.commit();
      this.#checkpointRevision = await ports.checkpoints.completeBoundaryAdvance(
        cid,
        this.#checkpointRevision,
      );
      try {
        await this.#rebuildFromCheckpoint();
      } catch {
        // commit 已完成；本機 cache 可由下一次 syncFromCheckpoint 重建，不回報假失敗。
      }
      this.#locallyDeferredAnnouncements.delete(cid);
      return ok(cid);
    } catch (cause) {
      preparedBoundary?.rollback();
      return err(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  /** 取得最新已驗證 checkpoint 的內容識別碼；尚無可用 checkpoint 時回傳拒絕原因。 */
  async getLatestCheckpoint(): Promise<Result<CID>> {
    const latest = await this.#requirePorts().checkpoints.getLatest();
    return latest === null ? err(new Error('無帳本檢查點')) : ok(latest.cid);
  }

  /** 依 CID 讀取並驗證指定 ledger checkpoint；本機不存在時回傳 null。 */
  getCheckpoint(cid: CID): Promise<LedgerCheckpoint | null> {
    return this.#requirePorts().checkpoints.load(cid);
  }

  /** 依上限讀取最近的 checkpoint 紀錄，保持由新到舊的穩定順序。 */
  async getCheckpointHistory(limit: number): Promise<LedgerCheckpoint[]> {
    return this.#requirePorts().checkpoints.history(limit);
  }

  // ── 同步 ──

  /** 從最新可採用 checkpoint 還原狀態，再補齊其後事件以縮短冷啟動時間。 */
  async syncFromCheckpoint(): Promise<Result<void>> {
    try {
      await this.#enqueue(async () => {
        await this.#rebuildInner();
        // 與 refold state assignment 同一 queue transaction 清 latch，避免 stale read window。
        this.#ingestFailure = null;
        this.#flushAcceptedNotifications();
      });
      return ok(undefined);
    } catch (cause) {
      const failure = cause instanceof Error ? cause : new Error(String(cause));
      this.#ingestFailure = failure;
      return err(failure);
    }
  }

  /** 自指定內容識別碼集合增量同步缺少的事件，並維持驗證與遍歷預算。 */
  async syncEventsSince(cids: readonly CID[]): Promise<Result<number>> {
    const ports = this.#requirePorts();
    try {
      const current = await ports.log.heads();
      const entries = current.length === 0 ? [] : await ports.log.entriesBetween(cids, current);
      await this.#rebuildFromCheckpoint();
      return ok(entries.length);
    } catch (cause) {
      return err(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  // ── 內部 ──

  /** Web Locks 可用時跨同源分頁序列化；缺少時明確只保證此 runtime 內序列。 */
  #serializeCheckpoint<T>(
    work: () => Promise<T>,
    abortSignal?: AbortSignal,
    abortValue?: T,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const locks = (
        globalThis as unknown as {
          navigator?: {
            locks?: { request<R>(name: string, callback: () => Promise<R>): Promise<R> };
          };
        }
      ).navigator?.locks;
      const guardedWork = async (): Promise<T> => {
        const ports = this.#ports;
        if (ports !== null) {
          const conflict = await ports.checkpoints.getConflict();
          this.#checkpointRevision = await ports.checkpoints.getRevision();
          if (conflict !== null && !this.#checkpointConflict) {
            this.#checkpointConflict = true;
            this.#checkpointConflictReconciliationPending = true;
            this.#checkpointReconciliationPending = true;
          }
        }
        return work();
      };
      if (locks === undefined) return guardedWork();
      return locks.request(`open4wd-checkpoint:${this.ledgerAddress}`, guardedWork);
    };
    const rawResult = this.#checkpointQueue.then(run, run);
    const result =
      abortSignal === undefined
        ? rawResult
        : Promise.race([
            rawResult,
            new Promise<T>((resolve) => {
              if (abortSignal.aborted) resolve(abortValue as T);
              else
                abortSignal.addEventListener('abort', () => resolve(abortValue as T), {
                  once: true,
                });
            }),
          ]);
    this.#checkpointQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 驗證 announcement 大小後送入 bounded adoption queue。 */
  #enqueueCheckpointAnnouncement(event: LedgerCheckpointEvent): boolean {
    const bytes = this.#checkpointAnnouncementBytes(event);
    if (bytes === null) {
      if (this.#checkpointReconciliationPending)
        this.#startupExaminedCheckpointCids.add(event.checkpointCid);
      return false;
    }
    const accepted = this.#adoptionQueue?.enqueue(event.checkpointCid, event, bytes) ?? false;
    if (this.#checkpointReconciliationPending) {
      if (accepted) this.#startupExaminedCheckpointCids.add(event.checkpointCid);
      else this.#checkpointRescanRequested = true;
    }
    return accepted;
  }

  /** 重複掃描 checkpoint 公告直到沒有新可採用項目或執行世代已失效。 */
  async #scanCheckpointAnnouncementsUntilStable(
    ports: LedgerPorts,
    generation: number,
  ): Promise<void> {
    while (this.#startupScanGeneration === generation && this.#ports === ports) {
      this.#checkpointRescanRequested = false;
      const beforeHeads = await ports.log.heads();
      for (const entry of await ports.log.all()) {
        if (this.#startupScanGeneration !== generation || this.#ports !== ports) return;
        const event = decodeLedgerEvent(entry.value);
        if (event?.type !== 'ledger-checkpoint') continue;
        const checkpointEvent = event as LedgerCheckpointEvent;
        if (this.#startupExaminedCheckpointCids.has(checkpointEvent.checkpointCid)) continue;
        const bytes = this.#checkpointAnnouncementBytes(checkpointEvent);
        if (bytes !== null)
          await this.#adoptionQueue?.enqueueWithBackpressure(
            checkpointEvent.checkpointCid,
            checkpointEvent,
            bytes,
          );
        // unavailable/retry-exhausted 只代表本輪 hint 已有界檢查；不阻塞 durable watermark。
        this.#startupExaminedCheckpointCids.add(checkpointEvent.checkpointCid);
      }
      await this.#adoptionQueue?.drain();
      if (this.#startupScanGeneration !== generation || this.#ports !== ports) return;
      const afterHeads = await ports.log.heads();
      if (this.#checkpointRescanRequested || !sameHeadSet(beforeHeads, afterHeads)) continue;
      let stable = false;
      await this.#enqueue(async () => {
        const finalHeads = await ports.log.heads();
        stable =
          this.#startupScanGeneration === generation &&
          this.#ports === ports &&
          !this.#checkpointRescanRequested &&
          sameHeadSet(afterHeads, finalHeads);
        if (stable) {
          this.#startupCheckpointScanActive = false;
          this.#checkpointReconciliationPending = this.#checkpointConflictReconciliationPending;
          this.#flushAcceptedNotifications();
        }
      });
      if (stable) {
        this.#startupExaminedCheckpointCids.clear();
        return;
      }
    }
  }

  /** 計算可信 shape 的 announcement bytes；畸形回 null。 */
  #checkpointAnnouncementBytes(event: LedgerCheckpointEvent): number | null {
    const signatures = (event as { signatures?: unknown }).signatures;
    if (
      typeof event.checkpointCid !== 'string' ||
      event.checkpointCid.length > 128 ||
      !(event.signature instanceof Uint8Array) ||
      event.signature.byteLength !== 0 ||
      !Array.isArray(signatures) ||
      signatures.length === 0 ||
      signatures.length > 64 ||
      signatures.some(
        (signature) => !(signature instanceof Uint8Array) || signature.byteLength !== 64,
      )
    )
      return null;
    const bytes =
      128 +
      event.checkpointCid.length +
      event.peerId.length +
      signatures.reduce((total, signature) => total + signature.byteLength, 0);
    return bytes;
  }

  /** 驗證公告指向的 checkpoint 與本機歷史相容性，回傳採用或拒絕裁定。 */
  async #adoptCheckpointAnnouncement(
    event: LedgerCheckpointEvent,
    signal?: AbortSignal,
  ): Promise<CheckpointAdoptionVerdict> {
    if (this.#ports === null || signal?.aborted) return 'rejected';
    const ports = this.#ports;
    const aborted = (): boolean => signal?.aborted === true || this.#ports !== ports;
    if (this.#checkpointConflict) {
      if (!this.#checkpointConflictReconciliationPending) return 'rejected';
      try {
        const conflict = await ports.checkpoints.getConflict();
        if (aborted()) return 'rejected';
        if (conflict === null) return 'rejected';
        await this.#rebuildFromCheckpoint();
        if (aborted()) return 'rejected';
        this.#checkpointConflictReconciliationPending = false;
        if (!this.#startupCheckpointScanActive) this.#checkpointReconciliationPending = false;
        return 'accepted';
      } catch {
        return 'retry';
      }
    }
    if (this.#locallyDeferredAnnouncements.has(event.checkpointCid)) return 'rejected';
    let checkpoint: LedgerCheckpoint;
    let checkpointBytes: Uint8Array;
    try {
      const bytes = await ports.blocks.get(
        event.checkpointCid,
        BLOCK_FETCH_TIMEOUT_MS,
        LEDGER_CHECKPOINT_MAX_BYTES,
      );
      if (aborted()) return 'rejected';
      if (bytes === null) return 'retry';
      checkpointBytes = bytes;
    } catch {
      return 'retry';
    }
    try {
      checkpoint = decodeCheckpointBlock(event.checkpointCid, checkpointBytes);
    } catch {
      return 'permanent-invalid';
    }
    if (
      checkpoint.timestamp > event.timestamp ||
      !sameSignatureList(event.signatures, checkpoint.signatures)
    )
      return 'rejected';

    const latest = await ports.checkpoints.getLatest();
    if (aborted()) return 'rejected';
    let cursor = latest;
    let sibling: { cid: CID; checkpoint: LedgerCheckpoint } | null = null;
    const visited = new Set<CID>();
    while (cursor !== null) {
      if (cursor.cid === event.checkpointCid) return 'accepted';
      if (
        cursor.checkpoint.previous_checkpoint_cid === checkpoint.previous_checkpoint_cid &&
        sibling === null
      )
        sibling = cursor;
      const previousCid = cursor.checkpoint.previous_checkpoint_cid;
      if (previousCid === null) break;
      if (visited.has(previousCid)) return 'rejected';
      visited.add(previousCid);
      const previous = await ports.checkpoints.load(previousCid);
      if (aborted()) return 'rejected';
      if (previous === null) return 'retry';
      cursor = { cid: previousCid, checkpoint: previous };
    }

    const expectedPrevious = latest?.cid ?? null;
    if (checkpoint.previous_checkpoint_cid !== expectedPrevious && sibling === null) return 'retry';
    const previous =
      checkpoint.previous_checkpoint_cid === null
        ? null
        : await ports.checkpoints.load(checkpoint.previous_checkpoint_cid);
    if (aborted()) return 'rejected';
    if (checkpoint.previous_checkpoint_cid !== null && previous === null) return 'retry';
    if (previous !== null && !shouldProposeCheckpoint(previous.timestamp, checkpoint.timestamp))
      return 'rejected';

    const authorityState = await this.#checkpointAuthorityState(checkpoint.previous_checkpoint_cid);
    const candidateFold =
      this.#checkpointAdoptionMode === 'full-refold'
        ? await this.#deriveCheckpointCandidateState(checkpoint)
        : authorityState === null
          ? null
          : { state: authorityState, acceptedEntries: [] };
    if (aborted()) return 'rejected';
    if (authorityState === null || candidateFold === null) return 'retry';
    const trustedSignerSet = this.#authorizedSignerSet(authorityState);
    if (
      !trustedSignerSet.has(checkpoint.proposer) ||
      checkpoint.signer_set_size !== trustedSignerSet.size ||
      checkpoint.quorum !== checkpointQuorum(trustedSignerSet.size) ||
      cidOfBytes(encodeSignerSet(trustedSignerSet)) !== checkpoint.signer_set_cid ||
      !validateCheckpointSignatures(checkpoint, trustedSignerSet, ports.log.address)
    )
      return 'rejected';
    const candidateSigners = checkpointSignatureSigners(
      checkpoint,
      checkpoint.signatures,
      trustedSignerSet,
      ports.log.address,
    );
    if (candidateSigners === null) return 'rejected';

    let derivedBytes: Uint8Array;
    let adoptedState: DerivedState;
    try {
      const fetchedDerived = await ports.blocks.get(
        checkpoint.derived_state_cid,
        BLOCK_FETCH_TIMEOUT_MS,
        LEDGER_DERIVED_STATE_MAX_BYTES,
      );
      if (aborted()) return 'rejected';
      if (fetchedDerived === null) return 'retry';
      const canonicalDerived = encodeDerivedState(decodeDerivedState(fetchedDerived));
      if (
        !sameBytes(fetchedDerived, canonicalDerived) ||
        cidOfBytes(canonicalDerived) !== checkpoint.derived_state_cid
      )
        return 'rejected';
      derivedBytes = canonicalDerived;
      adoptedState = decodeDerivedState(canonicalDerived);

      const signerBytes = await ports.blocks.get(
        checkpoint.signer_set_cid,
        BLOCK_FETCH_TIMEOUT_MS,
        LEDGER_SIGNER_SET_MAX_BYTES,
      );
      if (aborted()) return 'rejected';
      if (signerBytes === null) return 'retry';
      const decodedSigners = decodeSignerSet(signerBytes);
      const canonicalSigners = encodeSignerSet(decodedSigners);
      if (
        !sameBytes(signerBytes, canonicalSigners) ||
        cidOfBytes(canonicalSigners) !== checkpoint.signer_set_cid ||
        decodedSigners.size !== trustedSignerSet.size ||
        [...decodedSigners].some((signer) => !trustedSignerSet.has(signer))
      )
        return 'rejected';
    } catch {
      return 'rejected';
    }
    let checkpointState: DerivedState;
    if (this.#checkpointAdoptionMode === 'full-refold') {
      const rebuilt = await this.#buildCheckpointState(
        candidateFold.state,
        checkpoint.previous_checkpoint_cid,
      );
      if (aborted()) return 'rejected';
      if (!rebuilt.ok) return 'retry';
      if (
        cidOfBytes(encodeDerivedState(rebuilt.value.state)) !== checkpoint.derived_state_cid ||
        !sameBytes(encodeDerivedState(rebuilt.value.state), derivedBytes)
      )
        return 'rejected';
      checkpointState = rebuilt.value.state;
    } else {
      const nextSignerSet = new Set(adoptedState.economyConfig.governanceSigners);
      if (
        adoptedState.fromCheckpoint !== checkpoint.previous_checkpoint_cid ||
        adoptedState.economyConfig.epoch < candidateFold.state.economyConfig.epoch ||
        !canFinalizeSignerSet(nextSignerSet.size)
      )
        return 'rejected';
      checkpointState = adoptedState;
    }

    try {
      if (aborted()) return 'rejected';
      await ports.blocks.pin(event.checkpointCid);
      if (aborted()) return 'rejected';
      await ports.blocks.pin(checkpoint.derived_state_cid);
      if (aborted()) return 'rejected';
      await ports.blocks.pin(checkpoint.signer_set_cid);
      if (aborted()) return 'rejected';
      for (const cid of checkpointState.coldMatchPartitions.values()) {
        await ports.blocks.pin(cid);
        if (aborted()) return 'rejected';
      }
    } catch {
      return 'retry';
    }

    if (sibling !== null) {
      const siblingAuthorityState = await this.#checkpointAuthorityState(
        sibling.checkpoint.previous_checkpoint_cid,
      );
      if (aborted()) return 'rejected';
      if (siblingAuthorityState === null) return 'retry';
      const siblingTrustedSet = this.#authorizedSignerSet(siblingAuthorityState);
      const siblingSigners = checkpointSignatureSigners(
        sibling.checkpoint,
        sibling.checkpoint.signatures,
        siblingTrustedSet,
        ports.log.address,
      );
      if (siblingSigners === null) return 'rejected';
      const siblingSignerSet = new Set(siblingSigners);
      const equivocatedSigners = candidateSigners.filter((signer) => siblingSignerSet.has(signer));
      if (aborted()) return 'rejected';
      await ports.checkpoints.save(event.checkpointCid, checkpoint);
      if (aborted()) return 'rejected';
      this.#checkpointRevision = await ports.checkpoints.recordConflict(
        {
          previousCheckpointCid: checkpoint.previous_checkpoint_cid,
          candidateCids: [sibling.cid, event.checkpointCid],
          verifiedSignerSets: [
            {
              checkpointCid: sibling.cid,
              signerSetCid: sibling.checkpoint.signer_set_cid,
              signers: [...siblingTrustedSet],
            },
            {
              checkpointCid: event.checkpointCid,
              signerSetCid: checkpoint.signer_set_cid,
              signers: [...trustedSignerSet],
            },
          ],
          equivocatedSigners,
        },
        this.#checkpointRevision,
      );
      if (aborted()) return 'rejected';
      // durable evidence 一旦成功即 fail-closed；pointer/state reconciliation 失敗不得暫時放行。
      this.#checkpointConflict = true;
      this.#checkpointConflictReconciliationPending = true;
      this.#checkpointReconciliationPending = true;
      await this.#rebuildFromCheckpoint();
      if (aborted()) return 'rejected';
      this.#checkpointConflictReconciliationPending = false;
      if (!this.#startupCheckpointScanActive) this.#checkpointReconciliationPending = false;
      return 'accepted';
    }

    let preparedBoundary: { commit(): void; rollback(): void } | undefined;
    try {
      if (aborted()) return 'rejected';
      await ports.checkpoints.save(event.checkpointCid, checkpoint);
      if (aborted()) return 'rejected';
      this.#checkpointRevision = await ports.checkpoints.beginBoundaryAdvance(
        event.checkpointCid,
        this.#checkpointRevision,
      );
      if (aborted()) return 'rejected';
      this.#checkpointRevision = await ports.checkpoints.setLatest(
        event.checkpointCid,
        this.#checkpointRevision,
      );
      if (aborted()) return 'rejected';
      preparedBoundary = await ports.log.prepareCheckpointBoundary?.(checkpoint.log_head_cids);
      if (aborted()) {
        preparedBoundary?.rollback();
        return 'rejected';
      }
      preparedBoundary?.commit();
      this.#checkpointRevision = await ports.checkpoints.completeBoundaryAdvance(
        event.checkpointCid,
        this.#checkpointRevision,
      );
      if (aborted()) return 'rejected';
      await this.#rebuildFromCheckpoint(candidateFold.acceptedEntries);
      if (aborted()) return 'rejected';
      return 'accepted';
    } catch {
      preparedBoundary?.rollback();
      return 'retry';
    }
  }

  /** Single-flight 排程 full refold，直到 ingest failure 清除。 */
  #scheduleIngestRecovery(): void {
    if (this.#recoveryScheduled || this.#ports === null) return;
    this.#recoveryScheduled = true;
    void this.#enqueue(async () => {
      try {
        await this.#rebuildInner();
        this.#ingestFailure = null;
        this.#flushAcceptedNotifications();
      } catch (cause) {
        this.#ingestFailure =
          cause instanceof Error ? cause : new Error(`ledger refold failed: ${String(cause)}`);
        throw this.#ingestFailure;
      } finally {
        this.#recoveryScheduled = false;
      }
    }).catch(() => undefined);
  }

  /** 從 candidate 自報的 previous checkpoint 基底重放；不依賴目前 active/latest 分支。 */
  async #deriveCheckpointCandidateState(
    checkpoint: Omit<LedgerCheckpoint, 'signatures'> | LedgerCheckpoint,
  ): Promise<{ state: DerivedState; acceptedEntries: LogEntry[] } | null> {
    const ports = this.#requirePorts();
    try {
      let base = this.#genesisState();
      let previousHeads: readonly CID[] = [];
      if (checkpoint.previous_checkpoint_cid !== null) {
        const previous = await ports.checkpoints.load(checkpoint.previous_checkpoint_cid);
        if (previous === null) return null;
        const bytes = await ports.blocks.get(
          previous.derived_state_cid,
          BLOCK_FETCH_TIMEOUT_MS,
          LEDGER_DERIVED_STATE_MAX_BYTES,
        );
        if (bytes === null) return null;
        const canonical = encodeDerivedState(decodeDerivedState(bytes));
        if (!sameBytes(bytes, canonical) || cidOfBytes(canonical) !== previous.derived_state_cid)
          return null;
        base = decodeDerivedState(canonical);
        previousHeads = previous.log_head_cids;
      }
      const entries = await ports.log.entriesBetween(previousHeads, checkpoint.log_head_cids);
      return this.#foldEntries(base, entries, checkpoint.timestamp);
    } catch {
      return null;
    }
  }

  /** quorum-follow 只信任已採納 previous state；本次 checkpoint state 只能推進下一 epoch。 */
  async #checkpointAuthorityState(previousCheckpointCid: CID | null): Promise<DerivedState | null> {
    if (previousCheckpointCid === null) return this.#genesisState();
    try {
      const ports = this.#requirePorts();
      const previous = await ports.checkpoints.load(previousCheckpointCid);
      if (previous === null) return null;
      const bytes = await ports.blocks.get(
        previous.derived_state_cid,
        BLOCK_FETCH_TIMEOUT_MS,
        LEDGER_DERIVED_STATE_MAX_BYTES,
      );
      if (bytes === null) return null;
      const canonical = encodeDerivedState(decodeDerivedState(bytes));
      if (!sameBytes(bytes, canonical) || cidOfBytes(canonical) !== previous.derived_state_cid)
        return null;
      return decodeDerivedState(canonical);
    } catch {
      return null;
    }
  }

  /** 取得 open ports；未 open 時 fail closed。 */
  #requirePorts(): LedgerPorts {
    if (this.#ports === null) throw new Error('ledger 未 open');
    return this.#ports;
  }

  /** 以目前 internal flags 套用共用業務 readiness 守門。 */
  #assertBusinessReady(): void {
    assertLedgerBusinessReady({
      open: this.#ports !== null,
      checkpointReconciliationPending: this.#checkpointReconciliationPending,
      checkpointConflict: this.#checkpointConflict,
      ingestFailure: this.#ingestFailure,
    });
  }

  /** 公開業務讀取在 drain 前後共用單一封閉式失敗就緒 contract。 */
  async #awaitBusinessReady(): Promise<void> {
    this.#assertBusinessReady();
    await this.#queue;
    this.#assertBusinessReady();
  }

  /** 狀態變更全走佇列（錯誤不斷鏈、向呼叫端傳遞） */
  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * 條目落地（佇列內執行）：live 窗內走注入驗證＝即時 fold／通知的快閘；窗外
   * 走 fold 決定性守門。⭐live 拒收只擋「即時」——決定性去留由 #foldEntries 統一
   * 裁（refold 時與晚同步 peer 收斂一致；業務級量化拒收由各域 apply 守門落地）。
   */
  async #applyEntry(entry: LogEntry, attempt = 0): Promise<void> {
    const ports = this.#requirePorts();
    const stableHeads = await ports.log.heads();
    if (sameHeadSet(this.#foldFrontier, stableHeads)) return;
    let pending: LogEntry[];
    try {
      pending = (
        stableHeads.length === 0
          ? []
          : await ports.log.entriesBetween(this.#foldFrontier, stableHeads)
      ).filter((candidate) => !this.#acceptedEntries.has(candidate.hash));
    } catch (cause) {
      if (!(cause instanceof LedgerFrontierContinuityError)) throw cause;
      // P→A 已 fold 後，P→B sibling 到達形成 [A,B]；production continuity 正確拒絕
      // [A]→[A,B] 的增量差集，改由 checkpoint/genesis 對 stable full DAG refold。
      await this.#rebuildInner(true);
      return;
    }
    let previous = this.#lastCanonicalEntry;
    if (
      pending.some((candidate) => {
        if (previous !== null && canonicalLedgerEntryOrder(candidate, previous) <= 0) return true;
        previous = candidate;
        return false;
      })
    ) {
      await this.#rebuildInner(true);
      return;
    }
    for (const candidate of pending) {
      if (
        !(await this.#processIncrementalEntry(
          candidate,
          candidate.hash === entry.hash ? attempt : 0,
        ))
      )
        return;
    }
    this.#foldFrontier = stableHeads;
  }

  /** 驗證並處理單筆增量日誌項目，回傳是否造成可觀察狀態變更。 */
  async #processIncrementalEntry(entry: LogEntry, attempt: number): Promise<boolean> {
    const event = decodeLedgerEvent(entry.value);
    if (event === null) {
      this.#advanceCanonicalWatermark(entry, false);
      return true;
    }
    if (event.type === 'ledger-checkpoint') {
      this.#enqueueCheckpointAnnouncement(event as LedgerCheckpointEvent);
      this.#advanceCanonicalWatermark(entry, false);
      return true;
    }
    if (this.#checkpointConflict) {
      this.#advanceCanonicalWatermark(entry, false);
      return true;
    }
    const now = this.#now();
    if (Math.abs(now - event.timestamp) <= TOLERANCE_MS) {
      const validate = this.#options.validateIncoming ?? defaultLiveValidator;
      const verdict = validate(event, now, this.ledgerAddress);
      if (verdict.kind === 'defer') {
        this.#scheduleDeferRetry(entry, attempt);
        return false;
      }
      if (verdict.kind !== 'accept') {
        this.#advanceCanonicalWatermark(entry, false);
        return true;
      }
    }
    const folded = foldLedgerEntrySafely(
      this.#state,
      event,
      entry.hash,
      this.#rulebook,
      now,
      this.ledgerAddress,
    );
    if (!folded.accepted) {
      this.#advanceCanonicalWatermark(entry, false);
      return true;
    }
    this.#state = folded.state;
    this.#advanceCanonicalWatermark(entry, true);
    this.#flushAcceptedNotifications();
    return true;
  }

  /** 推進 canonical entry 尾鍵，並追蹤 accepted notification 候選。 */
  #advanceCanonicalWatermark(entry: LogEntry, accepted: boolean): void {
    this.#lastCanonicalEntry = entry;
    if (!accepted) return;
    this.#acceptedEntries.set(entry.hash, entry);
    if (this.#acceptedEntries.size > LRU_ENTRY_LIMIT)
      throw new RangeError('accepted ledger notification window exceeds local log retention');
    if (!this.#notifiedEntryHashes.has(entry.hash))
      this.#pendingNotificationEntries.set(entry.hash, entry);
    this.#assertPendingNotificationBound();
  }

  /** defer＝可恢復（base 未同步／視圖暖中）：有界延遲重審；燒完＝放棄（refold 統一裁） */
  #scheduleDeferRetry(entry: LogEntry, attempt: number): void {
    const delays = this.#options.deferRetryDelaysMs ?? DEFER_RETRY_DELAYS_MS;
    const delay = delays[attempt];
    if (delay === undefined) return;
    const handle = setTimeout(() => {
      this.#deferTimers.delete(handle);
      if (this.#ports === null) return;
      this.#enqueue(() => this.#applyEntry(entry, attempt + 1)).catch(() => undefined);
    }, delay);
    this.#deferTimers.add(handle);
  }

  /** 檢查點基底＋後續條目全量 refold（佇列序列化） */
  #rebuildFromCheckpoint(validatedCheckpointEntries?: readonly LogEntry[]): Promise<void> {
    return this.#enqueue(async () => {
      if (validatedCheckpointEntries !== undefined)
        this.#preserveValidatedCheckpointNotifications(validatedCheckpointEntries);
      await this.#rebuildInner();
    });
  }

  /** 在 checkpoint refold 前保留已驗覆蓋但尚未通知的 accepted entries。 */
  #preserveValidatedCheckpointNotifications(entries: readonly LogEntry[]): void {
    const covered = new Set(entries.map((entry) => entry.hash));
    for (const hash of covered)
      if (this.#acceptedEntries.has(hash) && this.#pendingNotificationEntries.has(hash))
        this.#checkpointCoveredPendingNotifications.add(hash);
  }

  /** 從目前可達日誌重建推導狀態與索引，並依設定通知新採用事件。 */
  async #rebuildInner(emitNew = false): Promise<void> {
    const ports = this.#requirePorts();
    // 先固定 active log head；此後到達的 onUpdate 會排在本 refold 後增量套用，
    // 不得用 generation 將 snapshot watermark 之後的 durable entry 一併丟棄。
    const targetHeads = await ports.log.heads();
    const latest = await ports.checkpoints.getLatest();
    if (latest !== null) {
      const bytes = await ports.blocks.get(
        latest.checkpoint.derived_state_cid,
        BLOCK_FETCH_TIMEOUT_MS,
        LEDGER_DERIVED_STATE_MAX_BYTES,
      );
      if (bytes !== null) {
        if (this.#checkpointConflict) {
          this.#state = decodeDerivedState(bytes);
          this.#commitFoldWatermark(targetHeads, [], [], emitNew);
          return;
        }
        const entries =
          targetHeads.length === 0 || sameHeadSet(targetHeads, latest.checkpoint.log_head_cids)
            ? []
            : await ports.log.entriesBetween(latest.checkpoint.log_head_cids, targetHeads);
        const folded = this.#foldEntries(decodeDerivedState(bytes), entries, this.#now());
        this.#state = folded.state;
        this.#commitFoldWatermark(targetHeads, entries, folded.acceptedEntries, emitNew);
        return;
      }
    }
    if (this.#checkpointConflict) {
      this.#state = this.#genesisState();
      this.#commitFoldWatermark(targetHeads, [], [], emitNew);
      return;
    }
    const entries = targetHeads.length === 0 ? [] : await ports.log.entriesBetween([], targetHeads);
    const folded = this.#foldEntries(this.#genesisState(), entries, this.#now());
    this.#state = folded.state;
    this.#commitFoldWatermark(targetHeads, entries, folded.acceptedEntries, emitNew);
  }

  /** 原子替換 fold frontier/accepted 索引並決定可通知 entries。 */
  #commitFoldWatermark(
    targetHeads: readonly string[],
    entries: readonly LogEntry[],
    acceptedEntries: readonly LogEntry[],
    emitNew: boolean,
  ): void {
    this.#lastCanonicalEntry = entries.at(-1) ?? null;
    this.#foldFrontier = targetHeads.length === 0 ? [] : canonicalizeLedgerHeadCids(targetHeads);
    this.#acceptedEntries.clear();
    for (const entry of acceptedEntries) this.#acceptedEntries.set(entry.hash, entry);
    if (this.#acceptedEntries.size > LRU_ENTRY_LIMIT)
      throw new RangeError('accepted ledger notification window exceeds local log retention');

    if (this.#checkpointConflict) {
      this.#pendingNotificationEntries.clear();
      this.#checkpointCoveredPendingNotifications.clear();
    } else {
      for (const hash of this.#pendingNotificationEntries.keys())
        if (
          !this.#acceptedEntries.has(hash) &&
          !this.#checkpointCoveredPendingNotifications.has(hash)
        )
          this.#pendingNotificationEntries.delete(hash);
      for (const [hash, entry] of this.#acceptedEntries)
        if (!this.#notifiedEntryHashes.has(hash)) this.#pendingNotificationEntries.set(hash, entry);
      this.#assertPendingNotificationBound();
    }
    for (const hash of this.#notifiedEntryHashes)
      if (
        !this.#acceptedEntries.has(hash) &&
        !this.#checkpointCoveredPendingNotifications.has(hash)
      )
        this.#notifiedEntryHashes.delete(hash);

    if (!this.#notificationBaselineEstablished) {
      // open 前已存在的 durable history 是 baseline，不可在 open timeout 後補送成 live event。
      this.#pendingNotificationEntries.clear();
      this.#checkpointCoveredPendingNotifications.clear();
      this.#notifiedEntryHashes.clear();
      for (const hash of this.#acceptedEntries.keys()) this.#notifiedEntryHashes.add(hash);
      this.#notificationBaselineEstablished = true;
      return;
    }
    if (emitNew || this.#notificationsReady()) this.#flushAcceptedNotifications();
  }

  /** 判斷 baseline、reconciliation 與 ingest 狀態是否允許事件通知。 */
  #notificationsReady(): boolean {
    return (
      this.#ports !== null &&
      !this.#checkpointReconciliationPending &&
      !this.#checkpointConflict &&
      this.#ingestFailure === null
    );
  }

  /** canonical 已接受減已通知 flush；就緒轉換與呼叫都在 state queue 執行。 */
  #flushAcceptedNotifications(): void {
    if (!this.#notificationsReady()) return;
    const pending = [...this.#pendingNotificationEntries.values()].sort(canonicalLedgerEntryOrder);
    for (const entry of pending) {
      if (
        !this.#acceptedEntries.has(entry.hash) &&
        !this.#checkpointCoveredPendingNotifications.has(entry.hash)
      ) {
        this.#pendingNotificationEntries.delete(entry.hash);
        continue;
      }
      if (this.#notifiedEntryHashes.has(entry.hash)) {
        this.#pendingNotificationEntries.delete(entry.hash);
        this.#checkpointCoveredPendingNotifications.delete(entry.hash);
        continue;
      }
      const event = decodeLedgerEvent(entry.value);
      if (event === null || event.type === 'ledger-checkpoint') {
        this.#pendingNotificationEntries.delete(entry.hash);
        this.#checkpointCoveredPendingNotifications.delete(entry.hash);
        continue;
      }
      for (const handler of this.#handlers) handler(event);
      this.#notifiedEntryHashes.add(entry.hash);
      this.#pendingNotificationEntries.delete(entry.hash);
      this.#checkpointCoveredPendingNotifications.delete(entry.hash);
    }
  }

  /** 確保未通知 buffer 不超過本地 log retention 上限。 */
  #assertPendingNotificationBound(): void {
    if (this.#pendingNotificationEntries.size > LRU_ENTRY_LIMIT)
      throw new RangeError('pending ledger notification buffer exceeds local log retention');
  }

  /** 從部署注入 trust root 或 canonical 預設建立全新 fold 起點。 */
  #genesisState(): DerivedState {
    if (this.#options.initialCheckpointProof !== undefined) {
      if (this.#resolvedInitialCheckpointState === null)
        throw new Error('initial checkpoint proof has not been verified');
      return this.#resolvedInitialCheckpointState;
    }
    return this.#options.genesisState?.() ?? emptyDerivedState();
  }

  /**
   * fold 統一守門（決定性）：shape／單簽 timeless 驗章／未來時戳（> fold 時鐘）
   * 排除——未來戳若放行會把 consensus clock 推去未來、癱瘓全部 time-based derive；
   * 各誠實 peer 於各自 fold 時刻做同判定＝時間推進下收斂（近未來戳＝檢查點重算
   * 兩造可能短暫不一致→拒簽重試、fail-closed）。
   */
  #foldEntries(
    base: DerivedState,
    entries: readonly LogEntry[],
    now: Timestamp,
  ): { state: DerivedState; acceptedEntries: LogEntry[] } {
    let state = base;
    const acceptedEntries: LogEntry[] = [];
    for (const entry of entries) {
      const event = decodeLedgerEvent(entry.value);
      if (event === null) continue;
      const folded = foldLedgerEntrySafely(
        state,
        event,
        entry.hash,
        this.#rulebook,
        now,
        this.ledgerAddress,
      );
      if (folded.accepted) {
        state = folded.state;
        acceptedEntries.push(entry);
      }
    }
    return { state, acceptedEntries };
  }

  /**
   * 檢查點狀態成形（proposer 與 reviewAndSign 共用＝重算可逐位比對）：先對時間窗
   * 結構 GC（recentMatchCombos／recentPrizedMatches／ugcUsageStats[].lastRoyaltyAtByPlayer／
   * monthlyFlowsByMonth
   * 修剪過窗 entry；純函式、讀點自帶窗過濾＝不影響任何判定；settledMatchIds 為
   * 冪等閘持久集、永不逐出），再 hot/cold 以 consensusNow（＝state.derivedAt）
   * 分桶、過期 quarter 併既有 cold partition 成新塊；基線 fromCheckpoint＝
   * previous、套用計數歸零。GC 窗長與 hot 保留窗皆讀 state 的 epoch 化治理
   * config——proposer 與 reviewer 對同一 base 必得同結果。
   */
  async #buildCheckpointState(
    base: DerivedState,
    previousCheckpointCid: CID | null,
  ): Promise<Result<{ state: DerivedState; coldBlocks: { cid: CID; bytes: Uint8Array }[] }>> {
    const ports = this.#requirePorts();
    // 檢查點時 GC（共識時鐘＝derivedAt、禁牆鐘）：兩端同式修剪＝derived_state_cid 可逐位比對
    const trimmed = gcExpiredWindowEntries(base, base.derivedAt);
    const { hot, cold } = bucketMatchesForCold(
      trimmed.match.recentMatches,
      trimmed.derivedAt,
      trimmed.economyConfig.hot_match_quarters,
    );
    const coldMap = new Map(trimmed.coldMatchPartitions);
    const coldBlocks: { cid: CID; bytes: Uint8Array }[] = [];
    for (const [key, bucket] of cold) {
      const merged = new Map(bucket);
      const existingCid = coldMap.get(key);
      if (existingCid !== undefined) {
        const existingBytes = await ports.blocks.get(
          existingCid,
          BLOCK_FETCH_TIMEOUT_MS,
          LEDGER_COLD_PARTITION_MAX_BYTES,
        );
        if (existingBytes === null)
          return err(new Error(`checkpoint：既有 cold partition ${key} 塊不可得、無法安全合併`));
        for (const [matchId, record] of decodeColdPartition(existingBytes).matchRecords)
          if (!merged.has(matchId)) merged.set(matchId, record);
      }
      const bytes = encodeColdPartition({ partitionKey: key, matchRecords: merged });
      const cid = cidOfBytes(bytes);
      coldBlocks.push({ cid, bytes });
      coldMap.set(key, cid);
    }
    return ok({
      state: {
        ...trimmed,
        match: { ...trimmed.match, recentMatches: hot },
        coldMatchPartitions: coldMap,
        fromCheckpoint: previousCheckpointCid,
        eventsAppliedSinceCheckpoint: 0,
      },
      coldBlocks,
    });
  }

  /** 在指定期限內執行非同步工作；逾時時中止並回報期限錯誤。 */
  async #withDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
    const remaining = deadline - this.#now();
    if (remaining <= 0) throw new Error('deadline exceeded');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('deadline exceeded')), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
