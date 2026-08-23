import type { PeerId } from '@open4wd/interfaces';

/**
 * MatchResult 與本人自簽 race-leave 共用的離場效果冪等鍵。
 * JSON tuple 保留欄位邊界，避免字串分隔符碰撞；輸入順序固定故跨 client 決定性。
 */
export function disconnectEffectKey(matchId: string, peerId: PeerId): string {
  return JSON.stringify([matchId, peerId]);
}
