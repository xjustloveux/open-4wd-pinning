/**
 * Peer Scoring（appSpecificScore）— 把推導出的信譽／黑名單狀態餵給 gossipsub mesh
 * 評分。信譽 0–1000、init 500；門檻 ≥800（≈4★）加分、<300（<1.5★）扣分。
 * 兩個視圖皆為帳本推導的唯讀面（隨 ledger／reputation／moderation 模組落地餵入）。
 */
import type { PeerId } from '@open4wd/interfaces';

/** 黑名單 peer 的強制負分，確保其退出 GossipSub mesh。 */
export const APP_SCORE_BLACKLISTED = -1000;
/** 開始給予高信譽 mesh 加分的有效信譽門檻。 */
export const APP_SCORE_HIGH_REPUTATION_MIN = 800;
/** 高信譽 peer 注入 GossipSub 的 application score。 */
export const APP_SCORE_HIGH_REPUTATION_BONUS = 50;
/** 低於此有效信譽時套用低信譽扣分。 */
export const APP_SCORE_LOW_REPUTATION_MAX = 300;
/** 低信譽 peer 注入 GossipSub 的 application score。 */
export const APP_SCORE_LOW_REPUTATION_PENALTY = -50;

/** 信譽讀點（唯一讀分入口的注入面；新手下限已作用於分數本身） */
export interface ReputationView {
  effectiveScore(peerId: PeerId, nowMs: number): number;
}

/** 全域黑名單讀點（三振推導） */
export interface ModerationView {
  isBlacklisted(peerId: PeerId): boolean;
}

/** 將 ledger 推導的 moderation 與 reputation 映射為 GossipSub app score。 */
export class AppPeerScore {
  constructor(
    /** 讀取指定時間的有效信譽。 */
    private readonly reputation: ReputationView,
    /** 先於信譽判定的全域黑名單視圖。 */
    private readonly moderation: ModerationView,
    /** 提供信譽衰減判定使用的本機牆鐘。 */
    private readonly now: () => number = Date.now,
  ) {}

  /** 依驗證失敗、限流與有效貢獻計算 GossipSub 應用層節點分數。 */
  appSpecificScore(peerId: PeerId): number {
    if (this.moderation.isBlacklisted(peerId)) return APP_SCORE_BLACKLISTED;
    const score = this.reputation.effectiveScore(peerId, this.now());
    if (score >= APP_SCORE_HIGH_REPUTATION_MIN) return APP_SCORE_HIGH_REPUTATION_BONUS;
    if (score < APP_SCORE_LOW_REPUTATION_MAX) return APP_SCORE_LOW_REPUTATION_PENALTY;
    return 0;
  }
}
