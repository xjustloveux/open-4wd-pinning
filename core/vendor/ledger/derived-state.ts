/**
 * DerivedState 巢狀結構（hot／cold 兩層）＋ applyEvent fold 骨架。
 * matchRecords 隨比賽數線性增長 → 按 UTC quarter 自然時間分區：hot 恆小量級、
 * cold lazy fetch；apply 一律入 hot（不查當前時間）、hot/cold 切分只在檢查點
 * proposer 階段用 consensusNow 決定（兩階段純函數性）。
 * ⭐本檔為記憶體視圖（ReadonlyMap/ReadonlySet 合法——不簽章）；state-codec 序列化為
 * derived_state_cid 時另做決定性 Map→Record 轉換。各域 reducer 隨對應業務模組
 * （economy/moderation/reputation…）注入 registry，本檔只固定共通 fold 與 dispatch。
 */
import type { CID, PeerId, Timestamp } from '@open4wd/interfaces';
// 檔案層依賴無環：economy/config 僅引 interfaces＋ugc-fork/config（皆葉檔）、不回引 ledger
import { GENESIS_ECONOMY_CONFIG, type EconomyConfig } from '../economy/config';
import type { UgcPresentationMetadata } from '../ugc-fork/presentation';
import type { ColdPartitionKey } from './derive-utils';
import type {
  ClientVersionInfo,
  DisconnectInfo,
  MatchEconomySettlement,
  MatchParticipantLoadout,
  MatchRules,
  RoundResult,
} from './events';

// ── 各業務域共用的結構占位（欄位權威＝各業務 spec） ──

/** UGC metadata（fingerprint/parentCid；版權模組收斂） */
export type UgcMetadata = Readonly<Record<string, unknown>>;
/** 檢舉案內部記錄（reason 收窄 union 在 moderation 模組；outcome no-quorum＝流局） */
export interface ReportInfo {
  /** fold 無 entry hash＝`${reporter}@${timestamp}` 合成引用 */
  reportEventId: string;
  reporter: PeerId;
  targetKind: 'cid' | 'peer';
  reason: string;
  details?: string;
  /** ReportEvent 原始證據字串；聊天案可由仲裁端逐筆離線驗章。 */
  evidence?: readonly string[];
  reportedAt: Timestamp;
  revoked: boolean;
  revokedAt?: Timestamp;
  outcome?: 'pass' | 'reject' | 'no-quorum';
}
/** 仲裁結果摘要（同案首筆有效；鍵=reportEventId） */
export interface ArbitrationResultRecord {
  result: 'pass' | 'reject' | 'no-quorum';
  passRatioX100: number;
  caseKind: 'report' | 'upload-pending';
  target: CID | PeerId;
}
/** 信譽變動明細（最近 100 筆、僅 UI 非規則依據；reason 收窄 union 在 reputation 模組） */
export interface ReputationDelta {
  target: PeerId;
  delta: number;
  reason: string;
  causeEventId: string;
  appliedAt: Timestamp;
}

/** 單筆有效顯式投票（同 rater 覆蓋＝取最新） */
export interface ExplicitVote {
  score: 1 | 2 | 3 | 4 | 5;
  /** reputation 階梯量化 50/100/150 */
  weightX100: number;
  ratedAt: Timestamp;
  useMatchId: string;
}

/** UGC 評分統計（整數量化 ×100） */
export interface UgcRatingStat {
  cid: CID;
  explicitVotes: ReadonlyMap<PeerId, ExplicitVote>;
  /** 計算式為 Σ(score×100×weightX100)。 */
  weightedSumX10000: bigint;
  totalWeightX100: bigint;
  voteCount: number;
  /** 0–500 */
  computedRatingX100: number;
  /** 來自隱式 fallback（零票、純使用量推估） */
  isImplicit: boolean;
  lastUpdatedAt: Timestamp;
}

/** 高評分里程碑去重（per-CID 一次、+20 信譽） */
export interface CreatorRatingMilestone {
  peerId: PeerId;
  awardedCids: ReadonlySet<CID>;
}
/** 資產型別鍵（B 軸 per-type 破壞牆；versioning 模組收斂） */
export type AssetTypeKey = string;

/** 單一 UGC 的作者、metadata、生命週期與贊助累積狀態。 */
export interface UgcRecord {
  cid: CID;
  author: PeerId;
  uploadType: 'part' | 'track';
  uploadedAt: Timestamp;
  metadata: UgcMetadata;
  /** 純顯示欄位；不參與內容 CID 或原始 upload 簽章。 */
  presentation: UgcPresentationMetadata;
  presentationRevision: number;
  presentationUpdatedAt: Timestamp;
  /** P5 退役候選起點（純 derive）；非候選＝null */
  maintenanceCandidateSince: Timestamp | null;
  retired: boolean;
  /** 最近一次 renew／unretire 的事件時間（續租 grace 屏障；無＝null）。lastUsedAt 不受續租影響 */
  lastMaintenanceAt: Timestamp | null;
  /** 歷來贊助燒毀總額；永久隨 UGC 記錄進 checkpoint，不代表作者收入 */
  sponsoredTotalMinor: bigint;
  /** 歷來有效贊助事件數；不保存贊助者身分集合 */
  sponsorEventCount: number;
  /** 最近一筆有效贊助事件時間（單調不降）；無贊助＝0 */
  lastSponsoredAt: Timestamp;
}

/** 單一 UGC 的使用者、回饋鑄幣與最後使用統計。 */
export interface UgcUsageStat {
  totalUses: number;
  uniqueUsers: ReadonlySet<PeerId>;
  /** 每位玩家上次實際鑄出 royalty 的時間；24h 去重窗錨（會 GC） */
  lastRoyaltyAtByPlayer: ReadonlyMap<PeerId, Timestamp>;
  totalRoyaltyMinted: bigint;
  /** 史上最後一次被用（單調、永不 GC）；P5 退役判定用 */
  lastUsedAt: Timestamp;
}

/** 已接受 match-result 的可審計比賽紀錄。 */
export interface MatchRecord {
  matchId: string;
  /** 總名次 */
  ranking: readonly PeerId[];
  rounds: readonly RoundResult[];
  loadouts: ReadonlyMap<PeerId, MatchParticipantLoadout>;
  matchRules: MatchRules;
  disconnects: readonly DisconnectInfo[];
  startedAt: Timestamp;
  finishedAt: Timestamp;
  /** canonical fold 依事件前態算出的公式結果。 */
  settlement: MatchEconomySettlement;
  /** 公式資格與實際入帳分開，避免 hard cap 場被顯示成已付款。 */
  economyOutcome: {
    status: 'applied' | 'not-eligible' | 'monthly-hard-cap';
    mintedTotal: bigint;
  };
  /** rolling windows 使用的 canonical monotonic fold time。 */
  settledAt: Timestamp;
  /** 事後審計用 */
  clientVersions: ReadonlyMap<PeerId, ClientVersionInfo>;
}

// ── 七域 ──

/** 描述帳本流程可保存或交換的狀態快照。 */
export interface EconomyDerivedState {
  /** 以最小貨幣單位表示。 */
  balances: ReadonlyMap<PeerId, bigint>;
  totalMinted: bigint;
  totalBurned: bigint;
  monthMinted: bigint;
  /** 月初 UTC 重置 */
  monthStartTimestamp: Timestamp;
  uploadCounts: ReadonlyMap<PeerId, { parts: number; tracks: number }>;
  /** 首次上鏈負資產旗標（每 PeerId 一生一次） */
  firstUploadDebtUsed: ReadonlySet<PeerId>;
  /** comboHash → 過去 24h 結算時間（checkpoint GC） */
  recentMatchCombos: ReadonlyMap<string, Timestamp[]>;
  /** per-player 過去 24h 領獎場次（有獎場數上限；GC 同 combos） */
  recentPrizedMatches: ReadonlyMap<PeerId, Timestamp[]>;
  /** 最近 12 個 UTC 月的實際入帳鑑燒；月鍵為 canonical YYYY-MM。 */
  monthlyFlowsByMonth: ReadonlyMap<string, ReadonlyMap<PeerId, MonthlyEconomyFlow>>;
  /** per-recipient 歷來 royalty 鑑幣額；creator profile 永久讀點。 */
  lifetimeRoyaltyMintedByPeer: ReadonlyMap<PeerId, bigint>;
  /**
   * chain-bound UGC 付費意圖摘要的永久去重集。任何逐出都會讓已簽 sponsor／maintenance
   * payload 再次可扣款，因此與 settledMatchIds 相同，必須隨 checkpoint 完整持久化。
   */
  processedPaymentIntents: ReadonlySet<string>;
}

/** 單一玩家在一個 UTC 月的實際鑄幣與燃燒流量。 */
export interface MonthlyEconomyFlow {
  readonly mintedMinor: bigint;
  readonly burnedMinor: bigint;
}

/** UGC records、血緣、使用統計與相似審查集合。 */
export interface UgcDerivedState {
  ugcRecords: ReadonlyMap<CID, UgcRecord>;
  /** 至多 2 筆 [parent, grandparent] */
  forkLineage: ReadonlyMap<CID, readonly CID[]>;
  ugcUsageStats: ReadonlyMap<CID, UgcUsageStat>;
  /** 灰區上傳待審（經濟隔離） */
  similarityPending: ReadonlySet<CID>;
}

/** 檢舉、仲裁、黑名單與三振規則的推導索引。 */
export interface ModerationDerivedState {
  /** CID 黑名單（仲裁下架） */
  blacklist: ReadonlySet<CID>;
  /** 玩家三振（純 derive） */
  peerBlacklist: ReadonlySet<PeerId>;
  pendingReports: ReadonlyMap<CID | PeerId, readonly ReportInfo[]>;
  reportsByReporter: ReadonlyMap<PeerId, ReadonlyMap<CID | PeerId, ReportInfo>>;
  reportAccuracy: ReadonlyMap<PeerId, { reports: number; successful: number }>;
  arbitrationResults: ReadonlyMap<string, ArbitrationResultRecord>;
  /** 規則索引：責任人仲裁定罪數（≥3＝三振全域黑名單） */
  convictionsByOffender: ReadonlyMap<PeerId, number>;
  /** 規則索引：上傳期案判抄時間戳（anti-piracy 安全港 30 天窗；寫入時修剪） */
  uploadPendingConvictions: ReadonlyMap<PeerId, Timestamp[]>;
}

/** 玩家 raw 信譽、歷史與各增減規則防重索引。 */
export interface ReputationDerivedState {
  /** 0–1000 整數（raw；新手下限於讀點套用） */
  scores: ReadonlyMap<PeerId, number>;
  /** 最近 100 筆、僅 UI（非規則依據） */
  history: ReadonlyMap<PeerId, readonly ReputationDelta[]>;
  /** 規則索引：惡意檢舉前科（30 天 rolling） */
  lastMaliciousReporterAt: ReadonlyMap<PeerId, Timestamp>;
  /** 規則索引：24h 比賽加分窗 */
  recentMatchGains: ReadonlyMap<PeerId, readonly { at: Timestamp; delta: number }[]>;
  /** 首筆事件套用時 consensusNow（自報倒填無效；共通 fold 維護） */
  registeredAt: ReadonlyMap<PeerId, Timestamp>;
  matchCount: ReadonlyMap<PeerId, number>;
  ugcCount: ReadonlyMap<PeerId, number>;
  /** 規則索引：UGC 使用門檻已頒發數（每 100 次 +5 防重複） */
  ugcMilestonesAwarded: ReadonlyMap<CID, number>;
}

/** UGC ratings 與創作者評分里程碑狀態。 */
export interface RatingDerivedState {
  ugcRatings: ReadonlyMap<CID, UgcRatingStat>;
  creatorMilestones: ReadonlyMap<PeerId, CreatorRatingMilestone>;
}

/** TrueSkill 整數定點（X1000；共識 derive、全網重算 bit-exact） */
export interface TrueSkillRatingX1000 {
  muX1000: number;
  sigmaX1000: number;
}

/** Hot matches、持久去重、TrueSkill、slots 與離場效果狀態。 */
export interface MatchDerivedState {
  /** hot：限近 N quarter（N＝EconomyConfig.hot_match_quarters） */
  recentMatches: ReadonlyMap<string, MatchRecord>;
  /**
   * ⭐match-result 冪等閘的持久去重集（僅 matchId、永不逐出、隨檢查點序列化）：
   * hot 窗逐出與 economy no-op（界限拒／月硬頂）都不得讓同 matchId 的複製 append
   * 重套累積型 reducer（TrueSkill／信譽）——「已入帳＝重播 no-op」不變式的載體。
   * ⭐完整性＝閘的正確性前提：不同於顯示用 recentMatches（可逐出），此集任一 matchId
   * 被逐出＝該場的重複結算窗重開（雙記分）。故永不逐出、隨場數線性成長（每筆 ~46B、
   * 成長極緩、決定性不受影響）＝刻意接受的代價；任何未來 bounding 須維持「全集同步命中」
   * 語意（例：緊湊持久索引），不得採 recentMatches 式 hot 窗逐出。
   */
  settledMatchIds: ReadonlySet<string>;
  trueSkillRatings: ReadonlyMap<PeerId, TrueSkillRatingX1000>;
  /** sparse——未出現＝預設 { vehicle: 1, track: 1 }；車位無上限 */
  playerSlotCounts: ReadonlyMap<PeerId, { vehicle: number; track: number }>;
  /** 規則索引：累積斷線次數（≥ 門檻＝σ 托底不收斂） */
  disconnectCounts: ReadonlyMap<PeerId, number>;
  /**
   * match-result 與 race-leave 共用的離場效果持久去重集；鍵＝(matchId, peerId)，
   * 永不逐出並隨 checkpoint 序列化，確保到達順序與重播不會重複扣分／計次。
   */
  processedDisconnectEffects: ReadonlySet<string>;
}

/** 資產最低支援版、狀態、successor 與 lineage-node 索引。 */
export interface AssetVersionDerivedState {
  /** B 軸 per-type 動態最低支援版（單調 ratchet） */
  minSupportedByType: ReadonlyMap<AssetTypeKey, number>;
  /** 純鏈上推導；yanked＝client 清單讀取層 overlay、不入本狀態 */
  versionStatusByCid: ReadonlyMap<CID, 'active' | 'deprecated' | 'unusable'>;
  /** 舊 CID → 新 CID（血緣節點映射用） */
  successorEdges: ReadonlyMap<CID, CID>;
  /** concrete 版本 CID → 首 CID 血緣節點（O(1)，版本邊不增加 fork 深度） */
  lineageNodeByCid: ReadonlyMap<CID, CID>;
}

/** 從 genesis/checkpoint 與 canonical ledger entries 純函數推導的全域狀態。 */
export interface DerivedState {
  economy: EconomyDerivedState;
  ugc: UgcDerivedState;
  moderation: ModerationDerivedState;
  reputation: ReputationDerivedState;
  ratings: RatingDerivedState;
  match: MatchDerivedState;
  assetVersion: AssetVersionDerivedState;
  /** 鏈錨定 derive 規則 epoch；必須隨檢查點持久化，不得由本機版本猜測。 */
  deriveRuleEpoch: string;
  /**
   * 治理 config 現值（epoch 化）：genesis 起、config-update 事件依 log 序推進——
   * fold 至任一位置時本欄即該位置生效的 config（事件建立期消費值照鐵則內嵌事件、
   * 此欄供 fold 守門與後續事件的費率驗證）。
   */
  economyConfig: EconomyConfig;
  /** 規則索引：各 peer 最近寫 ledger 的事件套用時鐘（P5 creatorGone 判定；共通 fold 維護） */
  lastEventAt: ReadonlyMap<PeerId, Timestamp>;
  /** 按 quarter 的歷史 matchRecords CID（lazy、本體不載） */
  coldMatchPartitions: ReadonlyMap<ColdPartitionKey, CID>;
  /** 已套用事件的 max timestamp＝running consensusNow */
  derivedAt: Timestamp;
  fromCheckpoint: CID | null;
  eventsAppliedSinceCheckpoint: number;
}

/** 一個季度已冷化、以 CID 延遲載入的 match records。 */
export interface ColdMatchPartition {
  partitionKey: ColdPartitionKey;
  matchRecords: ReadonlyMap<string, MatchRecord>;
}

/** 以指定 genesis economy config 建立所有域皆空的 fold 起點。 */
export function emptyDerivedState(
  economyConfig: EconomyConfig = GENESIS_ECONOMY_CONFIG,
): DerivedState {
  return {
    economy: {
      balances: new Map(),
      totalMinted: 0n,
      totalBurned: 0n,
      monthMinted: 0n,
      monthStartTimestamp: Date.UTC(
        new Date(economyConfig.signedAt).getUTCFullYear(),
        new Date(economyConfig.signedAt).getUTCMonth(),
        1,
      ),
      uploadCounts: new Map(),
      firstUploadDebtUsed: new Set(),
      recentMatchCombos: new Map(),
      recentPrizedMatches: new Map(),
      monthlyFlowsByMonth: new Map(),
      lifetimeRoyaltyMintedByPeer: new Map(),
      processedPaymentIntents: new Set(),
    },
    ugc: {
      ugcRecords: new Map(),
      forkLineage: new Map(),
      ugcUsageStats: new Map(),
      similarityPending: new Set(),
    },
    moderation: {
      blacklist: new Set(),
      peerBlacklist: new Set(),
      pendingReports: new Map(),
      reportsByReporter: new Map(),
      reportAccuracy: new Map(),
      arbitrationResults: new Map(),
      convictionsByOffender: new Map(),
      uploadPendingConvictions: new Map(),
    },
    reputation: {
      scores: new Map(),
      history: new Map(),
      lastMaliciousReporterAt: new Map(),
      recentMatchGains: new Map(),
      registeredAt: new Map(),
      matchCount: new Map(),
      ugcCount: new Map(),
      ugcMilestonesAwarded: new Map(),
    },
    ratings: { ugcRatings: new Map(), creatorMilestones: new Map() },
    match: {
      recentMatches: new Map(),
      settledMatchIds: new Set(),
      trueSkillRatings: new Map(),
      playerSlotCounts: new Map(),
      disconnectCounts: new Map(),
      processedDisconnectEffects: new Set(),
    },
    assetVersion: {
      minSupportedByType: new Map(),
      versionStatusByCid: new Map(),
      successorEdges: new Map(),
      lineageNodeByCid: new Map(),
    },
    deriveRuleEpoch: 'derive-v1',
    economyConfig,
    lastEventAt: new Map(),
    coldMatchPartitions: new Map(),
    derivedAt: economyConfig.signedAt,
    fromCheckpoint: null,
    eventsAppliedSinceCheckpoint: 0,
  };
}

/** 域 reducer：吃前態＋事件回新態（純函數、不得讀機器時鐘） */
export type EventApplier = (
  state: DerivedState,
  event: { type: string; timestamp: Timestamp; peerId: PeerId },
) => DerivedState;

/** type → reducer；各業務模組落地時注入（未註冊型別＝前向相容 no-op） */
export type ApplierRegistry = Readonly<Record<string, EventApplier>>;

/**
 * 多域 registry 組合：同一事件型別的各域 reducer 依**引數序**鏈接（state 流經每個；
 * 例：ugc-upload＝economy 收費 → ugc 記錄）。⭐鏈接序＝derive 決定性的一部分，
 * 站點 bootstrap 的組合順序必須全 client 一致（隨 client 發版、非執行期動態）。
 */
export function composeApplierRegistries(...registries: ApplierRegistry[]): ApplierRegistry {
  const composed: Record<string, EventApplier[]> = {};
  for (const registry of registries)
    for (const [type, applier] of Object.entries(registry)) (composed[type] ??= []).push(applier);
  const result: Record<string, EventApplier> = {};
  for (const [type, chain] of Object.entries(composed))
    result[type] =
      chain.length === 1
        ? chain[0]!
        : (state, event) => chain.reduce((current, applier) => applier(current, event), state);
  return result;
}

/**
 * 多簽事件族（以 signatures[] 取代單簽）：其 BaseEvent.peerId＝發布者、非共識綁定
 * 身分（fold 不驗其單簽），故不得以其驅動身分歸屬（見 applyEvent）。ledger-api 的
 * live 放行與 foldGuard 引用同一集＝單一權威（改此集＝改多簽判定範圍）。
 */
export const MULTISIG_EVENT_TYPES: ReadonlySet<string> = new Set([
  'match-result',
  'race-consensus-anchor',
  'desync',
  'ledger-checkpoint',
  'config-update',
]);

/**
 * 單事件 fold：共通部分（clock＝max(derivedAt, e.timestamp)、registeredAt 首見即定、
 * lastEventAt 活動索引、套用計數）對**所有**事件生效——含未註冊型別，使新舊 client
 * 對共通欄位 derive 一致；之後 dispatch 至 registry 對應 reducer。⭐身分歸屬
 * （registeredAt／lastEventAt）僅認單簽事件的 peerId：多簽事件 peerId＝發布者可被冒名
 * （任一 peer 舊時戳重播他人多簽即繞 live 直達 fold），冒名歸屬會延後受害者 UGC 退役／
 * 預釘其註冊時點——故多簽事件只推進 clock／計數、不記身分歸屬（finisher 場數改由
 * reputation reducer 以已驗 ranking 記、註冊時點由本人單簽事件定）。
 */
export function applyEvent(
  state: DerivedState,
  event: { type: string; timestamp: Timestamp; peerId: PeerId },
  registry: ApplierRegistry,
): DerivedState {
  const clock = Math.max(state.derivedAt, event.timestamp);
  let reputation = state.reputation;
  let lastEventAt = state.lastEventAt;
  if (!MULTISIG_EVENT_TYPES.has(event.type)) {
    if (!reputation.registeredAt.has(event.peerId)) {
      const registeredAt = new Map(reputation.registeredAt);
      registeredAt.set(event.peerId, clock);
      reputation = { ...reputation, registeredAt };
    }
    // 活動索引：以套用時鐘記（同 registeredAt 反倒填語意——寫入本身即活動）
    const nextActivity = new Map(state.lastEventAt);
    nextActivity.set(event.peerId, clock);
    lastEventAt = nextActivity;
  }
  const folded: DerivedState = {
    ...state,
    reputation,
    lastEventAt,
    derivedAt: clock,
    eventsAppliedSinceCheckpoint: state.eventsAppliedSinceCheckpoint + 1,
  };
  const applier = registry[event.type];
  return applier === undefined ? folded : applier(folded, event);
}
