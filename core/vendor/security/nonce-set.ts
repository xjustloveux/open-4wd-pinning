/**
 * P2P 訊息 nonce 集合 — 容差窗（30s）內拒重複；過窗自動淘汰
 * 淘汰後的重放由 timestamp 檢查擋下（verify-p2p 第 2 關），故窗外不需記憶
 * 本地防護、非共識路徑——可用機器時鐘
 */
import { Protocol } from '@open4wd/system-constants';
import { lowercaseHex as toHex } from '../encoding/bytes';

const WINDOW_MS = Protocol.security.P2P_MESSAGE_TIMESTAMP_TOLERANCE_SEC * 1000;

/** 有界、按 replay window 淘汰的本地 P2P nonce 集合。 */
export class NonceSet {
  /** nonce hex 至原訊息時間戳的有效項目。 */
  private readonly entries = new Map<string, number>();

  /**
   * 建立有界 nonce replay 集合。
   *
   * @param now 提供本機牆鐘毫秒的函式。
   * @param maxEntries 未過期 nonce 的硬上限；到達後 fail-closed。
   * @throws maxEntries 不是正整數時拋出 RangeError。
   */
  constructor(
    /** 提供本地 replay-window 判定時間的可測時鐘。 */
    private readonly now: () => number = Date.now,
    /** 未過期 nonce 的 fail-closed 容量上限。 */
    private readonly maxEntries: number = Protocol.security.P2P_NONCE_SET_MAX_ENTRIES,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1)
      throw new RangeError('maxEntries must be a positive integer');
  }

  /**
   * 檢查 nonce 是否仍在 replay window。
   *
   * @param nonce 要查詢的 nonce bytes。
   * @returns nonce 尚未過期且已存在時為 true。
   */
  has(nonce: Uint8Array): boolean {
    this.prune();
    return this.entries.has(toHex(nonce));
  }

  /**
   * 收錄已驗證 nonce；容量滿時不淘汰仍有效的項目。
   *
   * @param nonce 已通過長度與簽章驗證的 nonce。
   * @param timestamp 已通過時窗驗證的訊息時間。
   * @returns 成功收錄（或原本已存在）為 true；容量滿為 false。
   */
  add(nonce: Uint8Array, timestamp: number): boolean {
    this.prune();
    const key = toHex(nonce);
    if (this.entries.has(key)) return true;
    if (this.entries.size >= this.maxEntries) return false;
    this.entries.set(key, timestamp);
    return true;
  }

  /** @returns 目前尚未過期的 nonce 數量。 */
  get size(): number {
    this.prune();
    return this.entries.size;
  }

  /** 移除早於目前 replay window 的項目。 */
  private prune(): void {
    const cutoff = this.now() - WINDOW_MS;
    for (const [key, timestamp] of this.entries) if (timestamp < cutoff) this.entries.delete(key);
  }
}
