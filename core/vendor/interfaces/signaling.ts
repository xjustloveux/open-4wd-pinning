/**
 * SignalingProvider — canonical scope WebRTC 握手的可替換 transport 抽象。
 */
import type { PeerId, Result, Unsubscribe } from './shared';

/** 單一 signaling 連線的訊息、成員事件與關閉契約。 */
export interface SignalingSession {
  readonly providerId: string;
  readonly scope: string;
  /** 精確 roster 僅 WSS 類 transport 提供；Gossip presence 由 discovery table 補足。 */
  readonly peers?: readonly PeerId[];
  send(target: PeerId, message: SignalMessage): Promise<Result<void>>;
  onMessage(
    handler: (from: PeerId, message: SignalMessage, meta: { readonly nonce: string }) => void,
  ): Unsubscribe;
  onPeerJoined?(handler: (peer: PeerId) => void): Unsubscribe;
  onPeerLeft?(handler: (peer: PeerId) => void): Unsubscribe;
  /** 傳輸層存活狀態；只有舊版或測試介面可以省略。 */
  isOpen?(): boolean;
  /** 非預期的傳輸層關閉；明確呼叫 close() 時不得觸發。 */
  onClose?(handler: () => void): Unsubscribe;
  close(): Promise<void>;
}

/** 依範圍與玩家身分建立 signaling session 的 provider 契約。 */
export interface SignalingProvider {
  readonly providerId: string;
  readonly priority: number;
  openSession(input: {
    readonly localPeerId: PeerId;
    readonly scope: string;
  }): Promise<Result<SignalingSession>>;
  isHealthy(): Promise<boolean>;
}

/** 握手 3 型（點對點轉發子集；server wire 協議另有完整型別） */
export type SignalMessage =
  | { type: 'sdp-offer'; sdp: string }
  | { type: 'sdp-answer'; sdp: string }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit };

/** matchmaking 用來形成相容候選集合的玩家條件。 */
export interface MatchCriteria {
  trueSkillMu: number;
  trueSkillSigma: number;
}
