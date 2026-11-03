/**
 * Derive 純函式群 — ⭐所有 time-based derive 一律 consensusNow、禁 Date.now()
 * （跨 peer 機器時鐘不同＝derive 分叉）。partition 切分＝UTC quarter 純函數；
 * deriveTotalRanking＝consensus-critical（簽章者各自重算驗 ranking、防主 peer 偽造；
 * forfeit 者整場壓出回合積分、排總名次末位）。
 */
import type { CID, PeerId, Timestamp } from '@open4wd/interfaces';
import { loadoutRefs, type PartRef } from '../builtin-assets';
import type { DisconnectInfo, MatchResultEvent, RoundResult } from './events';

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

/** 整場 forfeit 名單：開賽名單內的 disconnects；同一 peer 多筆取最早 disconnectedAt。 */
function forfeitTimesOf(
  roster: readonly PeerId[],
  disconnects: readonly Pick<DisconnectInfo, 'peerId' | 'disconnectedAt'>[],
): ReadonlyMap<PeerId, Timestamp> {
  const inRoster = new Set(roster);
  const times = new Map<PeerId, Timestamp>();
  for (const { peerId, disconnectedAt } of disconnects) {
    if (!inRoster.has(peerId)) continue; // 倒數期間斷線者不在開賽名單、不進名次
    const known = times.get(peerId);
    if (known === undefined || disconnectedAt < known) times.set(peerId, disconnectedAt);
  }
  return times;
}

/**
 * 單回合積分（整場 forfeit 壓縮）：forfeit 者自回合名次移除、不得分；其餘依壓縮後
 * 名次 k 得 P−k+1（P＝開賽人數、不縮減）。回傳只含該回合非 forfeit 者。
 */
export function deriveRoundPoints(
  round: Pick<RoundResult, 'ranking'>,
  playerCount: number,
  forfeited: ReadonlySet<PeerId>,
): ReadonlyMap<PeerId, number> {
  const points = new Map<PeerId, number>();
  for (const peer of round.ranking)
    if (!forfeited.has(peer)) points.set(peer, playerCount - points.size);
  return points;
}

/** 整場積分、總時間與總名次（同一份推導；結算、評分、連勝與頁面摘要共用）。 */
export interface MatchStandings {
  /** 總名次：非 forfeit 者在前、forfeit 者在後 */
  ranking: PeerId[];
  /** P＝開賽人數（首回合名次長度） */
  playerCount: number;
  forfeited: ReadonlySet<PeerId>;
  /** 整場總積分；forfeit 者為 0 */
  points: ReadonlyMap<PeerId, number>;
  /** 總完成時間（DNF 回合計時限）；只含非 forfeit 者 */
  totalTimeMs: ReadonlyMap<PeerId, number>;
}

const comparePeerId = (a: PeerId, b: PeerId): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 整場推導（consensus-critical）：各回合先移除 forfeit 者，非 forfeit 者依壓縮後名次
 * 計 P−k+1 加總；總名次＝非 forfeit 者（積分高到低 → 總時間少到多 → PeerId）後接
 * forfeit 者（disconnectedAt 早到晚 → PeerId）。
 */
export function deriveMatchStandings(
  rounds: readonly RoundResult[],
  disconnects: readonly Pick<DisconnectInfo, 'peerId' | 'disconnectedAt'>[],
): MatchStandings {
  const roster = rounds[0]!.ranking;
  const playerCount = roster.length;
  const forfeitTimes = forfeitTimesOf(roster, disconnects);
  const forfeited: ReadonlySet<PeerId> = new Set(forfeitTimes.keys());
  const points = new Map<PeerId, number>(roster.map((peer) => [peer, 0]));
  const totalTimeMs = new Map<PeerId, number>();
  for (const peer of roster) if (!forfeited.has(peer)) totalTimeMs.set(peer, 0);
  for (const round of rounds) {
    for (const [peer, value] of deriveRoundPoints(round, playerCount, forfeited))
      points.set(peer, (points.get(peer) ?? 0) + value);
    for (const [peer, total] of totalTimeMs)
      totalTimeMs.set(peer, total + (round.finishTimes[peer] ?? 0));
  }
  const finishers = roster
    .filter((peer) => !forfeited.has(peer))
    .sort(
      (a, b) =>
        points.get(b)! - points.get(a)! ||
        totalTimeMs.get(a)! - totalTimeMs.get(b)! ||
        comparePeerId(a, b),
    );
  const forfeits = roster
    .filter((peer) => forfeited.has(peer))
    .sort((a, b) => forfeitTimes.get(a)! - forfeitTimes.get(b)! || comparePeerId(a, b));
  return { ranking: [...finishers, ...forfeits], playerCount, forfeited, points, totalTimeMs };
}

/** 總名次（consensus-critical）：`deriveMatchStandings` 的 ranking。 */
export function deriveTotalRanking(
  rounds: readonly RoundResult[],
  disconnects: readonly Pick<DisconnectInfo, 'peerId' | 'disconnectedAt'>[],
): PeerId[] {
  return deriveMatchStandings(rounds, disconnects).ranking;
}
