import { Network } from '@open4wd/system-constants';
import type { PeerId } from '@open4wd/interfaces';

/** 計算在場玩家對 race consensus anchor 的簡單多數門檻。 */
export function consensusAnchorQuorum(presentCount: number): number {
  return Math.floor(presentCount / 2) + 1;
}

/** 依 rollback buffer 計算 terminal frame 前最新可終局對齊幀。 */
export function latestFinalAnchorFrame(terminalFrame: number): number {
  const finalFrame = Math.max(0, terminalFrame - Network.sync.ROLLBACK_FRAME_BUFFER_DEFAULT);
  return (
    Math.floor(finalFrame / Network.sync.SNAPSHOT_INTERVAL_FRAMES) *
    Network.sync.SNAPSHOT_INTERVAL_FRAMES
  );
}

/** 候選只可落在最新 final 對齊幀或前一個對齊幀。 */
export function anchorFrameWithinTail(frame: number, terminalFrame: number): boolean {
  if (!Number.isInteger(frame) || frame < 0) return false;
  if (frame % Network.sync.SNAPSHOT_INTERVAL_FRAMES !== 0) return false;
  const latest = latestFinalAnchorFrame(terminalFrame);
  return (
    frame === latest ||
    (latest >= Network.sync.SNAPSHOT_INTERVAL_FRAMES &&
      frame === latest - Network.sync.SNAPSHOT_INTERVAL_FRAMES)
  );
}

/** 將 PeerIds 去重並以字典序穩定排序。 */
export function sortedUniquePeers(peers: readonly PeerId[]): PeerId[] {
  return [...new Set(peers)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
