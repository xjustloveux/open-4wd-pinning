/**
 * Topic rate limit — 每 authenticated source 跨 topic 共用窗口上限（防換 topic 繞過）。
 * ephemeral 牆鐘計時（非共識）；窗口起點固定、期滿重開（非滑動窗）。
 */
import type { PeerId } from '@open4wd/interfaces';
import { Network } from '@open4wd/system-constants';

/** 對每個已驗證來源施加跨 topic 固定窗口配額與有界狀態。 */
export class TopicRateLimiter {
  /** 來源目前窗口計數及 LRU 活動時間。 */
  private readonly counters = new Map<
    PeerId,
    { count: number; windowStart: number; lastSeen: number }
  >();
  /** 上次全表過期清掃的牆鐘時間。 */
  private lastSweep = 0;

  /**
   * 建立有界的 per-authenticated-source 固定窗口限流器。
   *
   * @param now 本機牆鐘毫秒提供者。
   * @param windowMs 限流窗口長度。
   * @param maxPerWindow 每窗口接受上限。
   * @param maxCounters 同時保留的 source counter 硬上限。
   * @throws 任一數值參數不是正整數時拋出 RangeError。
   */
  constructor(
    /** 可測試替換的本機牆鐘。 */
    private readonly now: () => number = Date.now,
    /** 每個固定配額窗口的長度。 */
    private readonly windowMs: number = Network.peerDiscovery.TOPIC_RATE_WINDOW_MS,
    /** 單一 authenticated source 在窗口內可接受的訊息數。 */
    private readonly maxPerWindow: number = Network.peerDiscovery.TOPIC_RATE_MAX_PER_WINDOW,
    /** 同時追蹤的來源 counter 硬上限。 */
    private readonly maxCounters: number = Network.peerDiscovery.TOPIC_RATE_COUNTERS_MAX,
  ) {
    if (
      !Number.isInteger(windowMs) ||
      windowMs < 1 ||
      !Number.isInteger(maxPerWindow) ||
      maxPerWindow < 1 ||
      !Number.isInteger(maxCounters) ||
      maxCounters < 1
    )
      throw new RangeError('rate limiter limits must be positive integers');
    this.lastSweep = now();
  }

  /**
   * 計入一則來源已和 signer 綁定且完成驗簽的訊息。
   *
   * @param peerId authenticated GossipSub source PeerId。
   * @param topic 已通過 allowlist 的 topic；只供呼叫語意，配額跨 topic 聚合。
   * @returns 位於窗口配額內時為 true；狀態滿時會淘汰最久未活動者而非鎖死新來源。
   */
  shouldAccept(peerId: PeerId, topic: string): boolean {
    void topic;
    const key = peerId;
    const at = this.now();
    if (at - this.lastSweep > this.windowMs) this.prune(at);
    const counter = this.counters.get(key);
    if (!counter || at - counter.windowStart > this.windowMs) {
      if (!counter && this.counters.size >= this.maxCounters) {
        this.prune(at);
        if (this.counters.size >= this.maxCounters) this.evictLeastRecentlyActive();
      }
      this.counters.set(key, { count: 1, windowStart: at, lastSeen: at });
      return true;
    }
    counter.count++;
    counter.lastSeen = at;
    return counter.count <= this.maxPerWindow;
  }

  /** @returns 目前保留的 authenticated source counter 數量。 */
  get size(): number {
    return this.counters.size;
  }

  /** 移除已跨過完整窗口的 counter 並更新掃描節點。 */
  private prune(at: number): void {
    for (const [key, counter] of this.counters)
      if (at - counter.windowStart > this.windowMs) this.counters.delete(key);
    this.lastSweep = at;
  }

  /** 容量滿時逐出最久未活動來源，讓新來源仍有 admission 機會。 */
  private evictLeastRecentlyActive(): void {
    let oldestKey: PeerId | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, counter] of this.counters)
      if (counter.lastSeen < oldestAt) {
        oldestKey = key;
        oldestAt = counter.lastSeen;
      }
    if (oldestKey !== undefined) this.counters.delete(oldestKey);
  }
}
