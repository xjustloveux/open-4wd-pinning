/**
 * ledger 事件結構 — 本檔僅列 ledger 自屬事件（match-result／desync／ugc-maintenance／
 * 帳本檢查點與結算訊息）；各業務事件由各自的業務模組定義。
 * ⭐可簽章欄位一律 plain Record（dag-cbor 不編碼 JS Map；ReadonlyMap 僅限記憶體視圖）。
 */
import type {
  BaseEvent,
  CID,
  PeerId,
  Signature,
  SignedPayload,
  Timestamp,
} from '@open4wd/interfaces';
import type { PartRef, VehicleLoadout } from '../builtin-assets';

/** 全場規則容器；逐回合規則只能寫在 RoundConfig／RoundResult。 */
export type MatchRules = Readonly<Record<string, never>>;

/** 可驗算起跑格所鎖定的單一 round-series context。 */
export interface GridLockedContext {
  version: 1;
  seriesId: string;
  roster: PeerId[];
  trackManifestDigests: string[];
  matchRules: MatchRules;
  roundCount: number;
}

/** 定義帳本流程交換的 GridCommitmentPayload 資料欄位與約束。 */
export interface GridCommitmentPayload {
  type: 'grid-commitment';
  contextDigest: string;
  commitment: string;
}

/** 定義帳本流程交換的 GridRevealPayload 資料欄位與約束。 */
export interface GridRevealPayload {
  type: 'grid-reveal';
  contextDigest: string;
  nonce: Uint8Array;
}

/** 定義帳本流程交換的 StartGridParticipantProof 資料欄位與約束。 */
export interface StartGridParticipantProof {
  peerId: PeerId;
  commitment: SignedPayload<GridCommitmentPayload>;
  reveal: SignedPayload<GridRevealPayload>;
}

/** 定義帳本流程交換的 StartGridProof 資料欄位與約束。 */
export interface StartGridProof {
  version: 1;
  context: GridLockedContext;
  contextDigest: string;
  participants: StartGridParticipantProof[];
  gridSeed: string;
}
/** 結構隨 versioning 模組收斂（事後審計用） */
export type ClientVersionInfo = Readonly<Record<string, unknown>>;

/** Match-result 內單一回合的終局名次、時間與共識幀摘要。 */
export interface RoundResult {
  /** 採 0-based 索引。 */
  roundIndex: number;
  trackRef: PartRef;
  /** linear／open 模式固定為 1。 */
  lapCount: number;
  /** 該回合禁用晶片主動能力；標準回合省略。 */
  disallowChip?: boolean;
  /** 回合終止原因；一律寫入並納入多簽內容。 */
  endReason: 'completed' | 'eliminated' | 'duration-limit';
  /** 本端拍板且由 MatchResult quorum 背書的回合終局幀；anchor tail 驗證基準。 */
  terminalFrame: number;
  /** 該回合名次（完賽時間→圈數→PeerId）；含全員、DNF 佔末位 */
  ranking: PeerId[];
  /** ms；DNF＝該回合 durationLimitSec×1000 */
  finishTimes: Readonly<Record<PeerId, number>>;
  /** 完整 roster 的直接致毀零件件數；零亦必填。 */
  destructionCounts: Readonly<Record<PeerId, number>>;
}

/** 一人一場的輪換車清單（長度＝回合數；可重複用同台） */
export interface MatchParticipantLoadout {
  peerId: PeerId;
  carRotation: VehicleLoadout[];
}

/** 比賽中一名玩家的自願或網路離場紀錄。 */
export interface DisconnectInfo {
  peerId: PeerId;
  disconnectedAt: Timestamp;
  reason: 'voluntary' | 'network';
}

/** 比賽獎金的收款者、金額與完賽名次。 */
export interface MatchPrizeShare {
  recipient: PeerId;
  amount: bigint;
  /** 完賽者排名（總名次序、forfeit 不佔位） */
  rank: number;
}
/** 一筆由實際使用玩家觸發、沿血緣分配的 UGC 回饋。 */
export interface RoyaltyShare {
  recipient: PeerId;
  /** 本筆 royalty 所屬的實際使用玩家；fold 依此更新 (cid, player) 去重錨。 */
  triggerPlayer: PeerId;
  amount: bigint;
  sourceCid: CID;
  forkLineageDepth: 0 | 1 | 2;
}

/** canonical fold 以事件前態算出的整場獎金與 UGC 回饋結果。 */
export interface MatchEconomySettlement {
  /** 場級鑄幣資格；false＝prizes／royalties 全空、usage 不記 */
  mintEligible: boolean;
  monthFactorX100: number;
  comboHash: string;
  matchPrizes: readonly MatchPrizeShare[];
  royalties: readonly RoyaltyShare[];
}

/** 多簽事件通用簽章對（sig 覆蓋 signingDigest(事件)＝sha256(canonical bytes 剔 signature|signatures)） */
export interface SignerSignature {
  signer: PeerId;
  sig: Signature;
}
/** canon 用名（結算訊息沿用） */
export type MatchResultSignature = SignerSignature;

/** 由完賽 quorum 多簽、可全網重算的正式比賽結算事件。 */
export interface MatchResultEvent extends BaseEvent {
  type: 'match-result';
  matchId: string;
  /** 完整 commitment/reveal proof；任何收件者可重算 seed、permutation 與逐回合 slot。 */
  gridProof: StartGridProof;
  /** 總名次（由 rounds 重算驗證、deriveTotalRanking） */
  ranking: PeerId[];
  rounds: RoundResult[];
  /** 每回合自包含 consensus certificate；缺 quorum 為 null，任一 null 時不得鑄幣。 */
  roundAnchors: (RaceConsensusAnchorEvent | null)[];
  loadouts: Readonly<Record<PeerId, MatchParticipantLoadout>>;
  /** ⭐逐 peer matchId-bound loadout 簽章（參與證明）：收件⓪家族驗有效性、applier 只罰／只評
   *  有簽章者——擋憑空自造一場塞任意玩家 disconnects 投毒信譽／斷線（簽章偽造不了、跨場不可重放） */
  loadoutSignatures: Readonly<Record<PeerId, Signature>>;
  matchRules: MatchRules;
  disconnects: DisconnectInfo[];
  startedAt: Timestamp;
  finishedAt: Timestamp;
  clientVersions: Readonly<Record<PeerId, ClientVersionInfo>>;
  /** ⌊在場/2⌋+1 完賽者簽章（BaseEvent.signature 對多簽事件固定空簽章＝長度 0） */
  signatures: MatchResultSignature[];
}

/** 每回合唯一、由當時在場 roster 嚴格多數背書的終局共識錨。 */
export interface RaceConsensusAnchorEvent extends BaseEvent {
  type: 'race-consensus-anchor';
  matchId: string;
  /** 綁定外層 MatchResult 的 start-grid proof，不重複 commitment/reveal 大型 payload。 */
  gridContextDigest: string;
  gridSeed: string;
  /** 0-based；供結算收件對應本回合唯一錨 */
  roundIndex: number;
  frame: number;
  /** physics state checksum（賽內共識產物） */
  checksum: string;
  /** 原始 roster 扣除 anchor timestamp 前已確認離場者；code-unit 排序去重。 */
  presentPeers: PeerId[];
  /** presentPeers 嚴格多數；每 signer 每回合最多簽一份。 */
  signatures: SignerSignature[];
}

/** 同回合兩張互斥的有效共識錨；完整保留原始證書與重疊簽署者供追責。 */
export interface RaceAnchorConflictEvidence {
  roundIndex: number;
  first: RaceConsensusAnchorEvent;
  second: RaceConsensusAnchorEvent;
  equivocators: PeerId[];
}

/** 玩家主動離場的 matchId-bound 本人自簽證明；不得縮小 MatchResult quorum。 */
export interface RaceLeaveEvent extends BaseEvent {
  type: 'race-leave';
  matchId: string;
  /** 建立證明時所在回合（0-based）。 */
  roundIndex: number;
  reason: 'voluntary';
}

/** 中止證據中單一回合觀察到的 frame/checksum。 */
export interface RaceAbortFrameSummary {
  roundIndex: number;
  frame: number;
  checksum: string;
}

/** 中止前收到的關鍵賽內訊息摘要。 */
export interface RaceAbortMessageDigest {
  sender: PeerId;
  kind: 'leave' | 'settlement-reject' | 'settlement-cancel' | 'checksum';
  digest: string;
}

/** 中止判定中的離場、無 quorum、desync 或 session failure 觀察。 */
export interface RaceAbortObservation {
  roundIndex: number;
  frame: number;
  kind: 'peer-left' | 'no-quorum' | 'desync' | 'session-error';
  subject?: PeerId;
}

/** 單簽、零業務 reducer 的中止證據；只供本機診斷／避配／未來仲裁。 */
export interface RaceAbortEvidenceEvent extends BaseEvent {
  type: 'race-abort-evidence';
  matchId: string;
  reason: 'settlement-no-quorum' | 'consensus-invalid' | 'session-error';
  frameSummaries: RaceAbortFrameSummary[];
  receivedMessageDigests: RaceAbortMessageDigest[];
  observations: RaceAbortObservation[];
  anchorConflicts: RaceAnchorConflictEvidence[];
}

/** 保存同幀互斥 state hashes 供事後調查的 desync 證據事件。 */
export interface DesyncEvent extends BaseEvent {
  type: 'desync';
  raceId: string;
  frame: number;
  participatingPeers: PeerId[];
  hashes: Readonly<Record<PeerId, string>>;
  /** 被踢者自簽（裸簽章、對 signingDigest；欄容多簽、他端自願附簽為開放項）；不影響信譽、純供調查 */
  signatures: Signature[];
}

/** 以 burn 支付 UGC retire、renew 或 unretire 的維護事件。 */
export interface UgcMaintenanceEvent extends BaseEvent {
  type: 'ugc-maintenance';
  cid: CID;
  /** renew／unretire 任何人可付；retire 限血緣節點創作者（apply 守門） */
  payer: PeerId;
  burnAmount: bigint;
  reason: 'retire' | 'renew' | 'unretire';
}

/**
 * 檢查點宣告事件（finalize 後上鏈；pinning service 訂閱此事件全 pin cold CID）。
 * 檢查點本體＋簽章存獨立永留儲存、事件僅為指標；signatures＝檢查點多簽轉錄。
 */
export interface LedgerCheckpointEvent extends BaseEvent {
  type: 'ledger-checkpoint';
  checkpointCid: CID;
  signatures: Signature[];
}

// ── 帳本檢查點（≠回合 consensus anchor） ──

/** 定義帳本流程交換的 LedgerCheckpoint 資料欄位與約束。 */
export interface LedgerCheckpoint {
  checkpoint_version: number;
  timestamp: Timestamp;
  /** 完整 Orbit DAG frontier；CID bytes 升冪、1..64、不得重複。 */
  log_head_cids: CID[];
  derived_state_cid: CID;
  previous_checkpoint_cid: CID | null;
  signer_set_cid: CID;
  signer_set_size: number;
  /** N=1 時 1；N>=3 時 floor(2N/3)+1；N=2 非法 */
  quorum: number;
  proposer: PeerId;
  signatures: Signature[];
}
/** 收集 checkpoint quorum 簽章前傳播的限時 proposal。 */
export interface LedgerCheckpointProposal {
  proposalId: string;
  checkpoint: Omit<LedgerCheckpoint, 'signatures'>;
  proposer: PeerId;
  proposerSignature: Signature;
  expiresAt: Timestamp;
}

// ── 結算簽章交換（pubsub `open4wd/settlement/<matchId>`、不寫 ledger） ──

/** 定義帳本邊界交換的訊息欄位與約束。 */
export interface SettlementProposalMessage {
  type: 'settlement-proposal';
  matchId: string;
  candidate: Omit<MatchResultEvent, 'signatures'>;
  proposerSignature: MatchResultSignature;
}
/** 完賽者對既定 settlement candidate hash 的簽章回覆。 */
export interface SettlementSignatureMessage {
  type: 'settlement-signature';
  matchId: string;
  candidateHash: string;
  signature: MatchResultSignature;
}
/** 完賽者拒簽 settlement candidate 的決定性或暫時原因。 */
export interface SettlementRejectMessage {
  type: 'settlement-reject';
  matchId: string;
  candidateHash: string;
  reason: string;
  rejecter: PeerId;
  /** true＝暫時性失敗（catch up 未及等）——不計入「不可能湊滿」的取消判定 */
  transient?: boolean;
}
/** 原 proposer 失聯後重用候選與既有簽章的接管訊息。 */
export interface SettlementTakeoverMessage {
  type: 'settlement-takeover';
  matchId: string;
  newProposer: PeerId;
  reusedCandidateHash: string;
  collectedSignatures: readonly MatchResultSignature[];
  proposedAt: Timestamp;
}
/** 收集端裁定不可能湊滿（決定性拒簽者過多）＝主動終局：全員即刻收攤、免等滿窗 */
export interface SettlementCancelMessage {
  type: 'settlement-cancel';
  matchId: string;
  candidateHash: string;
  reason: string;
  canceller: PeerId;
}
