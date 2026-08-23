/**
 * Derive 純函式群 — ⭐所有 time-based derive 一律 consensusNow、禁 Date.now()
 * （跨 peer 機器時鐘不同＝derive 分叉）。partition 切分＝UTC quarter 純函數；
 * deriveTotalRanking＝consensus-critical（簽章者各自重算驗 ranking、防主 peer 偽造）。
 */
import type { CID, PeerId, Timestamp } from '@open4wd/interfaces';
import { loadoutRefs, type PartRef } from '../builtin-assets';
import type { MatchResultEvent, RoundResult } from './events';

/** P2P deterministic「現在」＝已見事件最大 timestamp（空 ledger 回 0） */
export function consensusNow(events: readonly { timestamp: Timestamp }[]): Timestamp {
  return events.reduce((max, event) => Math.max(max, event.timestamp), 0);
}

/** UTC 年與季度組成的 cold match partition key。 */
export type ColdPartitionKey = `${number}-Q${1 | 2 | 3 | 4}`;

/** UTC year＋quarter（跨 peer 一致的純切分鍵） */
export function partitionKeyOf(timestamp: Timestamp): ColdPartitionKey {
  const date = new Date(timestamp);
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `${date.getUTCFullYear()}-Q${quarter}` as ColdPartitionKey;
}

/** 由 now 往回數 hotMatchQuarters 個 quarter（含當前） */
export function currentHotPartitions(now: Timestamp, hotMatchQuarters: number): ColdPartitionKey[] {
  const keys: ColdPartitionKey[] = [];
  const date = new Date(now);
  let year = date.getUTCFullYear();
  let quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  for (let index = 0; index < hotMatchQuarters; index++) {
    keys.push(`${year}-Q${quarter}` as ColdPartitionKey);
    quarter--;
    if (quarter === 0) {
      quarter = 4;
      year--;
    }
  }
  return keys;
}

/**
 * 該場比賽 N 回合用到的所有非公版 UGC CID（builtin:*＝公版不觸發 royalty、
 * local:*＝縱深過濾；Set 去重＝同 UGC 跨回合 royalty 只算一次）。
 * loadouts 雙形：事件＝plain Record（可簽章鐵則）、MatchRecord＝記憶體 Map 視圖
 * ——⭐Object.values(Map) 回空陣列＝靜默漏抓，故此處顯式分流。
 */
export function collectAllUgcUsedInMatch(match: {
  rounds: readonly Pick<RoundResult, 'trackRef'>[];
  loadouts:
    MatchResultEvent['loadouts'] | ReadonlyMap<PeerId, MatchResultEvent['loadouts'][PeerId]>;
}): ReadonlySet<CID> {
  const cids = new Set<CID>();
  const addIfUgc = (ref: PartRef): void => {
    // 非公版且非本機草稿＝鏈上 CID（PartRef 聯集扣除兩前綴後的殘餘）
    if (!ref.startsWith('builtin:') && !ref.startsWith('local:')) cids.add(ref as CID);
  };
  for (const round of match.rounds) addIfUgc(round.trackRef);
  const loadouts =
    match.loadouts instanceof Map ? [...match.loadouts.values()] : Object.values(match.loadouts);
  for (const loadout of loadouts)
    for (const car of loadout.carRotation) for (const ref of loadoutRefs(car)) addIfUgc(ref);
  return cids;
}

/**
 * 總名次（consensus-critical）：線性回合積分 roundPoints=P−k+1 加總
 * → 積分高到低；tiebreak ①總完成時間少到多（DNF 計 durationLimit）②PeerId 字典序。
 */
export function deriveTotalRanking(rounds: RoundResult[]): PeerId[] {
  const playerCount = rounds[0]!.ranking.length;
  const points = (peer: PeerId): number =>
    rounds.reduce((sum, round) => sum + (playerCount - round.ranking.indexOf(peer)), 0);
  const totalTime = (peer: PeerId): number =>
    rounds.reduce((sum, round) => sum + (round.finishTimes[peer] ?? 0), 0);
  return [...rounds[0]!.ranking].sort(
    (a, b) => points(b) - points(a) || totalTime(a) - totalTime(b) || (a < b ? -1 : a > b ? 1 : 0),
  );
}
