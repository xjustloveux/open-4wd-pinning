/**
 * 已驗證傳輸來源的 nonce registry。每個 authenticated GossipSub source 擁有獨立
 * replay window，避免大量 Sybil 身分共用單一全域 nonce 容量而鎖死正常節點。
 */
import type { PeerId } from '@open4wd/interfaces';
import { NonceSet } from '../security';

interface SourceState {
  nonces: NonceSet;
  lastSeen: number;
}

/** Sybil 輪替也無法重置的 subscriber-global Gossip admission 固定窗口。 */
export class GossipGlobalAdmission {
  /** 目前固定窗口開始時間。 */
  private windowStart: number;
  /** 窗口內在解碼前已接受的總 bytes。 */
  private rawBytes = 0;
  /** 窗口內在解碼前已接受的訊息數。 */
  private rawMessages = 0;
  /** 窗口內允許進入密碼驗證的訊息數。 */
  private verifications = 0;

  constructor(
    /** 可測試替換的本機牆鐘。 */
    private readonly now: () => number,
    /** subscriber-global 固定窗口長度。 */
    private readonly windowMs: number,
    /** 窗口內所有來源合計的 raw bytes 上限。 */
    private readonly maxRawBytes: number,
    /** 窗口內所有來源合計的 raw message 上限。 */
    private readonly maxRawMessages: number,
    /** 窗口內所有來源合計的簽章驗證上限。 */
    private readonly maxVerifications: number,
  ) {
    this.windowStart = now();
  }

  /** 在解碼前檢查全域固定窗口的訊息數與位元組配額，接納時原子增加計數。 */
  admitRaw(bytes: number): boolean {
    this.refresh();
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      this.rawBytes + bytes > this.maxRawBytes ||
      this.rawMessages + 1 > this.maxRawMessages
    )
      return false;
    this.rawBytes += bytes;
    this.rawMessages++;
    return true;
  }

  /** 在進入密碼驗證前消耗全域驗章配額，超過窗口上限時拒絕。 */
  admitVerification(): boolean {
    this.refresh();
    if (this.verifications + 1 > this.maxVerifications) return false;
    this.verifications++;
    return true;
  }

  /** 窗口到期時一次重置所有 global admission 計數。 */
  private refresh(): void {
    const at = this.now();
    if (at - this.windowStart <= this.windowMs) return;
    this.windowStart = at;
    this.rawBytes = 0;
    this.rawMessages = 0;
    this.verifications = 0;
  }
}

/** 有界 per-source replay registry；容量滿時只淘汰最久未活動的 source state。 */
export class SourceNonceRegistry {
  /** 每個 authenticated source 的 replay window 與 LRU 時間。 */
  private readonly states = new Map<PeerId, SourceState>();

  /**
   * @param now 本機牆鐘毫秒提供者。
   * @param maxSources 同時保留的 authenticated source 上限。
   * @param maxNoncesPerSource 單一 source replay nonce 上限。
   */
  constructor(
    /** 可測試替換的本機牆鐘。 */
    private readonly now: () => number,
    /** 同時保留的 authenticated source 狀態硬上限。 */
    private readonly maxSources: number,
    /** 單一來源可保留的 replay nonce 數量。 */
    private readonly maxNoncesPerSource: number,
  ) {
    if (!Number.isInteger(maxSources) || maxSources < 1)
      throw new RangeError('maxSources must be a positive integer');
    if (!Number.isInteger(maxNoncesPerSource) || maxNoncesPerSource < 1)
      throw new RangeError('maxNoncesPerSource must be a positive integer');
  }

  /**
   * @param source 已與 envelope signer 綁定且驗簽成功的傳輸來源。
   * @param nonce 要查詢的 nonce。
   * @returns 此來源在 replay window 內已收過該 nonce 時為 true。
   */
  has(source: PeerId, nonce: Uint8Array): boolean {
    return this.states.get(source)?.nonces.has(nonce) ?? false;
  }

  /**
   * 在驗簽與 rate limit 通過後提交 nonce。
   *
   * @param source 已驗證的傳輸來源。
   * @param nonce 已驗證 nonce。
   * @param timestamp 已驗證訊息時間。
   * @returns 成功收錄（或原本存在）為 true；單一來源容量異常耗盡時為 false。
   */
  commit(source: PeerId, nonce: Uint8Array, timestamp: number): boolean {
    const at = this.now();
    let state = this.states.get(source);
    if (!state) {
      this.pruneExpiredSources();
      if (this.states.size >= this.maxSources) this.evictLeastRecentlyActive();
      state = { nonces: new NonceSet(this.now, this.maxNoncesPerSource), lastSeen: at };
      this.states.set(source, state);
    }
    const added = state.nonces.add(nonce, timestamp);
    if (added) state.lastSeen = at;
    return added;
  }

  /** @returns 目前保留的 authenticated source state 數量。 */
  get size(): number {
    return this.states.size;
  }

  /** 移除 nonce 已全部過期的來源狀態。 */
  private pruneExpiredSources(): void {
    for (const [source, state] of this.states)
      if (state.nonces.size === 0) this.states.delete(source);
  }

  /** 容量滿時逐出最久未成功提交 nonce 的來源。 */
  private evictLeastRecentlyActive(): void {
    let oldestSource: PeerId | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [source, state] of this.states)
      if (state.lastSeen < oldestAt) {
        oldestSource = source;
        oldestAt = state.lastSeen;
      }
    if (oldestSource !== undefined) this.states.delete(oldestSource);
  }
}
