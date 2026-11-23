/**
 * Ledger — 事件帳本的可替換抽象（append-only、事件簽章、帳本檢查點多簽）；
 * 方法面＝完整 LedgerApi 中以介面層型別可表達的子集（比賽記錄查詢／經濟 config
 * 等需實作層型別的方法屬 src/ledger 具體類）。
 */
import type { CID, PeerId, Result, Signature, Timestamp, Unsubscribe } from './shared';

/** 一筆本機帳本寫入從排隊到確定結果的生命週期。 */
export type LedgerAdmissionPhase =
  | 'idle'
  | 'queued'
  | 'preparing'
  | 'mining'
  | 'sealing'
  | 'submitting'
  | 'retry-pending'
  | 'permanent-reject'
  | 'uncertain';

/** 本機帳本工作狀態；不含 raw error 或事件內容，可安全直接呈現在全域 UI。 */
export interface LedgerAdmissionActivity {
  readonly phase: LedgerAdmissionPhase;
  readonly queued: number;
  readonly startedAt: number | null;
  readonly cid: string | null;
  readonly canCancel: boolean;
  readonly code: string | null;
}

/** 事件帳本的同步、追加、查詢、衍生與 admission 控制契約。 */
export interface Ledger {
  /** 連線目標位址＝鏈身分（build 注入的 LEDGER_DB_ADDRESS） */
  readonly ledgerAddress: string;
  /** 上線並 sync 至最新檢查點 */
  open(myPeerId: PeerId): Promise<Result<void>>;
  /** 標準單簽事件：自動 stamp（timestamp／peerId）＋自動簽章 */
  appendEvent<T extends LedgerEvent>(
    event: Omit<T, 'signature' | 'peerId' | 'timestamp'>,
  ): Promise<Result<EventId>>;
  /** 事件自帶 BaseEvent.signature（非 SignedPayload——事件無 nonce、CID 冪等＋首播時戳容差取代重放防護） */
  readEvents(sinceCheckpoint?: CID): AsyncIterable<LedgerEvent>;
  /** consensusNow／derive 用全量（entry miss 僅可向 authenticated source 走有界 entry-fetch） */
  getAllEvents(): Promise<readonly LedgerEvent[]>;
  getDerivedState(): Promise<DerivedState>;
  /** 純函數重算（不動本機 cache）；拉不齊（總超時）回 null */
  deriveStateAt(logHeadCids: readonly CID[]): Promise<DerivedState | null>;
  /** 同步／診斷用完整 frontier；空帳本回空集合 */
  getLatestLogHeads(): Promise<readonly CID[]>;
  onEvent(handler: (event: LedgerEvent) => void): Unsubscribe;
  onAdmissionActivity(handler: (activity: LedgerAdmissionActivity) => void): Unsubscribe;
  cancelAdmissionWork(): Promise<void>;
  proposeCheckpoint(): Promise<Result<CheckpointProposal>>;
  signCheckpoint(proposal: CheckpointProposal): Promise<Result<Signature>>;
  finalizeCheckpoint(
    proposal: CheckpointProposal,
    signatures: readonly Signature[],
  ): Promise<Result<CID>>;
  getLatestCheckpoint(): Promise<Result<CID>>;
  syncFromCheckpoint(): Promise<Result<void>>;
  syncEventsSince(cids: readonly CID[]): Promise<Result<number>>;
}
/** 已寫入帳本事件的穩定識別碼。 */
export type EventId = string;

/** 所有帳本事件的共同底座 */
export interface BaseEvent {
  type: string;
  timestamp: Timestamp;
  /** 簽署者 */
  peerId: PeerId;
  /** 對 canonical 序列化簽章 */
  signature: Signature;
  /** 因果關係（可選） */
  parentEventCid?: CID;
}

/**
 * 介面層的結構上界；production persistence 不是開放 type：custom access-controller
 * 以 src/ledger/ledger-admission 的封閉事件目錄與 exact deep schema 在落盤前裁定。
 */
export type LedgerEvent = BaseEvent;

/** 全帳本推導狀態契約上界——完整巢狀結構（hot／cold）見 src/ledger DerivedState */
export type DerivedState = object;

/** 帳本檢查點提案（checkpoint 本體結構見 src/ledger LedgerCheckpoint） */
export interface CheckpointProposal {
  proposalId: string;
  checkpoint: object;
  proposer: PeerId;
  proposerSignature: Signature;
  expiresAt: Timestamp;
}
