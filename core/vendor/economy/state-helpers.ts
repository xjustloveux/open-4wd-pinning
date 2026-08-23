/**
 * Derived state 輔助純函式——全 immutable、時間判定一律吃
 * event.timestamp（非機器時鐘）；月度跨界＝每筆 mint/burn 前純函數 rollover、
 * 不寫 month-reset 事件。視窗過濾在 append 時就地過濾＋檢查點 GC 兜底修剪
 * （gcExpiredWindowEntries）、皆以共識可決時間決定＝跨 peer 一致。
 * 檔案層邊界：ledger-api 會值引本葉檔；本檔只可 type-import ledger，不得 runtime 回引。
 */
import { sha256 } from '@noble/hashes/sha2.js';
import type { CID, PeerId, Timestamp } from '@open4wd/interfaces';
import { Protocol } from '@open4wd/system-constants';
// 深路徑匯入（ledger 檢查點成形反向引本檔 GC——繞開 barrel 防環；derived-state 為型別葉檔）
import type {
  DerivedState,
  EconomyDerivedState,
  MonthlyEconomyFlow,
  UgcRecord,
  UgcUsageStat,
} from '../ledger/derived-state';
import type { EconomyConfig } from './config';

const HOUR_MS = 60 * 60 * 1000;
/** per-player 有獎場數窗（per day＝24h rolling） */
const PRIZED_WINDOW_MS = 24 * HOUR_MS;

// ── 餘額 ──

/** 在不可變餘額 map 的複本中增加指定玩家金額，原 map 不受修改。 */
export function addBalance(
  balances: ReadonlyMap<PeerId, bigint>,
  peer: PeerId,
  amount: bigint,
): ReadonlyMap<PeerId, bigint> {
  const next = new Map(balances);
  next.set(peer, (balances.get(peer) ?? 0n) + amount);
  return next;
}

/** 從指定玩家餘額扣除金額並回傳新的 map。 */
export function subBalance(
  balances: ReadonlyMap<PeerId, bigint>,
  peer: PeerId,
  amount: bigint,
): ReadonlyMap<PeerId, bigint> {
  return addBalance(balances, peer, -amount);
}

// ── 月度跨界 ──

/** UTC 月初（純函數、跨 peer 一致） */
export function startOfUtcMonth(timestamp: Timestamp): Timestamp {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** 每筆 mint/burn 前呼叫：跨月＝monthMinted 歸零＋錨定新月初；同月原樣回傳 */
export function checkMonthRollover(
  economy: EconomyDerivedState,
  timestamp: Timestamp,
): EconomyDerivedState {
  const monthStart = startOfUtcMonth(timestamp);
  if (monthStart <= economy.monthStartTimestamp) return economy;
  return { ...economy, monthMinted: 0n, monthStartTimestamp: monthStart };
}

const MONTH_KEY_PATTERN = /^(?<year>\d{4,})-(?<month>0[1-9]|1[0-2])$/;

function utcMonthIndex(timestamp: Timestamp): number {
  const date = new Date(timestamp);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

function utcMonthKey(timestamp: Timestamp): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function utcMonthIndexFromKey(key: string): number {
  const match = MONTH_KEY_PATTERN.exec(key);
  if (match?.groups === undefined) throw new TypeError(`invalid UTC month key: ${key}`);
  return Number(match.groups['year']) * 12 + Number(match.groups['month']) - 1;
}

/**
 * 以共識時間錨保留當月＋前 11 個月。同式用於 fold 即時裁剪與 checkpoint GC。
 * 遇到非 canonical 月鍵即 fail-closed，避免不同 peer 對破損 state 做不同容錯。
 */
export function pruneMonthlyEconomyFlows(
  flows: EconomyDerivedState['monthlyFlowsByMonth'],
  anchorTimestamp: Timestamp,
): EconomyDerivedState['monthlyFlowsByMonth'] {
  const anchor = utcMonthIndex(anchorTimestamp);
  const oldest = anchor - (Protocol.ledger.ECONOMY_MONTHLY_FLOW_RETENTION_MONTHS - 1);
  let changed = false;
  const kept: [string, ReadonlyMap<PeerId, MonthlyEconomyFlow>][] = [];
  for (const [month, peers] of flows) {
    const index = utcMonthIndexFromKey(month);
    if (index >= oldest && index <= anchor) kept.push([month, peers]);
    else changed = true;
  }
  if (!changed) return flows;
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new Map(kept);
}

/** 只記錄實際入帳的非負鑑／燒增量；過期遲到事件不得復活舊月。 */
export function recordMonthlyEconomyFlow(
  economy: EconomyDerivedState,
  peer: PeerId,
  timestamp: Timestamp,
  mintedMinor: bigint,
  burnedMinor: bigint,
): EconomyDerivedState {
  if (mintedMinor < 0n || burnedMinor < 0n)
    throw new RangeError('monthly economy flow deltas must be non-negative');
  if (mintedMinor === 0n && burnedMinor === 0n) return economy;

  const eventMonth = utcMonthIndex(timestamp);
  let anchorMonth = eventMonth;
  for (const month of economy.monthlyFlowsByMonth.keys())
    anchorMonth = Math.max(anchorMonth, utcMonthIndexFromKey(month));
  const oldest = anchorMonth - (Protocol.ledger.ECONOMY_MONTHLY_FLOW_RETENTION_MONTHS - 1);
  if (eventMonth < oldest) return economy;

  const month = utcMonthKey(timestamp);
  const peers = economy.monthlyFlowsByMonth.get(month) ?? new Map<PeerId, MonthlyEconomyFlow>();
  const current = peers.get(peer) ?? { mintedMinor: 0n, burnedMinor: 0n };
  const nextPeers = new Map(peers);
  nextPeers.set(peer, {
    mintedMinor: current.mintedMinor + mintedMinor,
    burnedMinor: current.burnedMinor + burnedMinor,
  });
  const withEvent = new Map(economy.monthlyFlowsByMonth);
  withEvent.set(month, nextPeers);
  const anchorYear = Math.floor(anchorMonth / 12);
  const anchorMonthOfYear = anchorMonth - anchorYear * 12;
  const pruned = pruneMonthlyEconomyFlows(
    withEvent,
    Date.UTC(anchorYear, anchorMonthOfYear, 1) as Timestamp,
  );
  const sorted = new Map([...pruned].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { ...economy, monthlyFlowsByMonth: sorted };
}

/** per-recipient lifetime royalty 累加；非正金額不建 entry。 */
export function addLifetimeRoyaltyMinted(
  economy: EconomyDerivedState,
  peer: PeerId,
  amount: bigint,
): EconomyDerivedState {
  if (amount <= 0n) return economy;
  const lifetimeRoyaltyMintedByPeer = new Map(economy.lifetimeRoyaltyMintedByPeer);
  lifetimeRoyaltyMintedByPeer.set(peer, (lifetimeRoyaltyMintedByPeer.get(peer) ?? 0n) + amount);
  return { ...economy, lifetimeRoyaltyMintedByPeer };
}

// ── K=5 combo 窗 ──

/**
 * 完賽者群組 hash（⭐共識值——全 client 必須同式）：PeerId 字典序排序後以 '\n'
 * 連接、sha256 → hex（排序＝集合語意、與名次無關）。
 */
export function computeComboHash(finishers: readonly PeerId[]): string {
  const canonical = [...finishers].sort().join('\n');
  const digest = sha256(new TextEncoder().encode(canonical));
  return Array.from(digest)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** 窗內同 comboHash 的合格場時間戳（過期就地淘汰） */
export function appendRecentMatchCombo(
  combos: ReadonlyMap<string, Timestamp[]>,
  comboHash: string,
  timestamp: Timestamp,
  windowHours: number,
): ReadonlyMap<string, Timestamp[]> {
  const cutoff = timestamp - windowHours * HOUR_MS;
  const kept = (combos.get(comboHash) ?? []).filter((at) => at > cutoff);
  const next = new Map(combos);
  next.set(comboHash, [...kept, timestamp]);
  return next;
}

/** K=5 閘：窗內同組合「合格場」數未達上限才可鑄（不合格場不佔窗） */
export function shouldGrantMatchPrize(
  comboHash: string,
  economy: EconomyDerivedState,
  config: EconomyConfig,
  timestamp: Timestamp,
): boolean {
  const cutoff = timestamp - config.match_prize.combo_window_hours * HOUR_MS;
  const count = (economy.recentMatchCombos.get(comboHash) ?? []).filter((at) => at > cutoff).length;
  return count < config.match_prize.combo_max_matches_per_day;
}

// ── per-player 有獎場數窗 ──

/** 為得獎玩家加入共識時間，並同步修剪各玩家二十四小時窗口外紀錄。 */
export function appendRecentPrizedMatches(
  prized: ReadonlyMap<PeerId, Timestamp[]>,
  recipients: readonly PeerId[],
  timestamp: Timestamp,
): ReadonlyMap<PeerId, Timestamp[]> {
  if (recipients.length === 0) return prized;
  const cutoff = timestamp - PRIZED_WINDOW_MS;
  const next = new Map(prized);
  for (const peer of recipients) {
    const kept = (next.get(peer) ?? []).filter((at) => at > cutoff);
    next.set(peer, [...kept, timestamp]);
  }
  return next;
}

/** 計算玩家在指定共識時間前 24 小時內的有獎場次。 */
export function countPrizedMatches24h(
  peer: PeerId,
  prized: ReadonlyMap<PeerId, Timestamp[]>,
  timestamp: Timestamp,
): number {
  const cutoff = timestamp - PRIZED_WINDOW_MS;
  return (prized.get(peer) ?? []).filter((at) => at > cutoff).length;
}

// ── UGC 使用統計與 royalty 去重 ──

function emptyUsageStat(): UgcUsageStat {
  return {
    totalUses: 0,
    uniqueUsers: new Set(),
    lastRoyaltyAtByPlayer: new Map(),
    totalRoyaltyMinted: 0n,
    lastUsedAt: 0,
  };
}

/** 記一次使用（僅 mintEligible 場的完賽者）；lastUsedAt 單調不降（P5 退役判定用） */
export function recordUgcUsage(
  stats: ReadonlyMap<CID, UgcUsageStat>,
  cid: CID,
  player: PeerId,
  timestamp: Timestamp,
): ReadonlyMap<CID, UgcUsageStat> {
  const stat = stats.get(cid) ?? emptyUsageStat();
  const uniqueUsers = new Set(stat.uniqueUsers);
  uniqueUsers.add(player);
  const next = new Map(stats);
  next.set(cid, {
    totalUses: stat.totalUses + 1,
    uniqueUsers,
    lastRoyaltyAtByPlayer: stat.lastRoyaltyAtByPlayer,
    totalRoyaltyMinted: stat.totalRoyaltyMinted,
    lastUsedAt: Math.max(stat.lastUsedAt, timestamp),
  });
  return next;
}

/** 實際鑄出 royalty 後更新同 (UGC, 玩家) 的去重錨；亂序舊戳不得拉低錨點。 */
export function recordRoyaltyMint(
  stats: ReadonlyMap<CID, UgcUsageStat>,
  cid: CID,
  player: PeerId,
  timestamp: Timestamp,
): ReadonlyMap<CID, UgcUsageStat> {
  const stat = stats.get(cid) ?? emptyUsageStat();
  const lastRoyaltyAtByPlayer = new Map(stat.lastRoyaltyAtByPlayer);
  lastRoyaltyAtByPlayer.set(player, Math.max(lastRoyaltyAtByPlayer.get(player) ?? 0, timestamp));
  const next = new Map(stats);
  next.set(cid, { ...stat, lastRoyaltyAtByPlayer });
  return next;
}

/** 同 (UGC, 玩家) 於去重窗內已觸發過 royalty → false（跨場去重、settlement 純讀） */
export function shouldMintRoyalty(
  cid: CID,
  player: PeerId,
  stats: ReadonlyMap<CID, UgcUsageStat>,
  dedupWindowHours: number,
  timestamp: Timestamp,
): boolean {
  const lastRoyaltyAt = stats.get(cid)?.lastRoyaltyAtByPlayer.get(player);
  if (lastRoyaltyAt === undefined) return true;
  return timestamp - lastRoyaltyAt > dedupWindowHours * HOUR_MS;
}

/** 將新鑄回饋累加至指定 UGC 的使用統計。 */
export function accumulateRoyaltyMinted(
  stats: ReadonlyMap<CID, UgcUsageStat>,
  cid: CID,
  amount: bigint,
): ReadonlyMap<CID, UgcUsageStat> {
  const stat = stats.get(cid) ?? emptyUsageStat();
  const next = new Map(stats);
  next.set(cid, { ...stat, totalRoyaltyMinted: stat.totalRoyaltyMinted + amount });
  return next;
}

// ── 檢查點 GC（時間窗結構修剪） ──

/** 時間戳陣列窗修剪（保留 at > cutoff、與讀點同式）；空鍵移除；無變更回原引用 */
function pruneTimestampListMap<K>(
  map: ReadonlyMap<K, Timestamp[]>,
  cutoff: Timestamp,
): ReadonlyMap<K, Timestamp[]> {
  let changed = false;
  const next = new Map<K, Timestamp[]>();
  for (const [key, timestamps] of map) {
    const kept = timestamps.filter((at) => at > cutoff);
    if (kept.length !== timestamps.length) changed = true;
    if (kept.length > 0) next.set(key, kept);
  }
  return changed ? next : map;
}

/**
 * usage 統計的 royalty 錨窗修剪：讀點語意＝「now − lastRoyaltyAt > 窗」才准再鑄，
 * 故 lastRoyaltyAt ≥ cutoff（含恰在邊界者）仍在去重窗內、必須保留；統計本體
 * （totalUses／uniqueUsers／totalRoyaltyMinted／lastUsedAt）為永久欄位、不動。
 */
function pruneRoyaltyAnchors(
  stats: ReadonlyMap<CID, UgcUsageStat>,
  cutoff: Timestamp,
): ReadonlyMap<CID, UgcUsageStat> {
  let changed = false;
  const next = new Map<CID, UgcUsageStat>();
  for (const [cid, stat] of stats) {
    let statChanged = false;
    const lastRoyaltyAtByPlayer = new Map<PeerId, Timestamp>();
    for (const [player, lastRoyaltyAt] of stat.lastRoyaltyAtByPlayer) {
      if (lastRoyaltyAt >= cutoff) lastRoyaltyAtByPlayer.set(player, lastRoyaltyAt);
      else statChanged = true;
    }
    if (statChanged) changed = true;
    next.set(cid, statChanged ? { ...stat, lastRoyaltyAtByPlayer } : stat);
  }
  return changed ? next : stats;
}

/**
 * 帳本檢查點時 GC（純函式、不寫事件）：對時間窗結構移除過窗 entry——
 * recentMatchCombos（combo 窗）／recentPrizedMatches（24h 有獎場窗）／
 * ugcUsageStats[].lastRoyaltyAtByPlayer（royalty 去重窗）／monthlyFlowsByMonth
 * （當月＋前 11 個 UTC 月）。窗長讀 state 現值 config 或 protocol 常數
 * ＝提案端與複核端對同一 base 必得同結果；consensusNow＝檢查點共識時鐘
 * （state.derivedAt）、禁牆鐘。⭐讀點皆自帶窗過濾＝GC 只縮 state 體積、不影響任何
 * 判定；settledMatchIds 為冪等閘持久去重集、永不逐出——不在本函式修剪範圍。
 */
export function gcExpiredWindowEntries(state: DerivedState, consensusNow: Timestamp): DerivedState {
  const config = state.economyConfig;
  const recentMatchCombos = pruneTimestampListMap(
    state.economy.recentMatchCombos,
    consensusNow - config.match_prize.combo_window_hours * HOUR_MS,
  );
  const recentPrizedMatches = pruneTimestampListMap(
    state.economy.recentPrizedMatches,
    consensusNow - PRIZED_WINDOW_MS,
  );
  const ugcUsageStats = pruneRoyaltyAnchors(
    state.ugc.ugcUsageStats,
    consensusNow - config.creator_royalty.dedup_window_hours * HOUR_MS,
  );
  const monthlyFlowsByMonth = pruneMonthlyEconomyFlows(
    state.economy.monthlyFlowsByMonth,
    consensusNow,
  );
  if (
    recentMatchCombos === state.economy.recentMatchCombos &&
    recentPrizedMatches === state.economy.recentPrizedMatches &&
    ugcUsageStats === state.ugc.ugcUsageStats &&
    monthlyFlowsByMonth === state.economy.monthlyFlowsByMonth
  )
    return state;
  return {
    ...state,
    economy: {
      ...state.economy,
      recentMatchCombos,
      recentPrizedMatches,
      monthlyFlowsByMonth,
    },
    ugc: { ...state.ugc, ugcUsageStats },
  };
}

// ── 計數器 ──

/** 在不可變計數 map 中增加指定玩家的車輛或賽道插槽數。 */
export function incrementSlot(
  counts: ReadonlyMap<PeerId, { vehicle: number; track: number }>,
  peer: PeerId,
  kind: 'vehicle' | 'track',
): ReadonlyMap<PeerId, { vehicle: number; track: number }> {
  const current = counts.get(peer) ?? { vehicle: 1, track: 1 };
  const next = new Map(counts);
  next.set(peer, { ...current, [kind]: current[kind] + 1 });
  return next;
}

/** 依作品類型增加創作者的 part 或 track 上傳計數。 */
export function incrementUploadCount(
  counts: ReadonlyMap<PeerId, { parts: number; tracks: number }>,
  peer: PeerId,
  uploadType: 'part' | 'track',
): ReadonlyMap<PeerId, { parts: number; tracks: number }> {
  const current = counts.get(peer) ?? { parts: 0, tracks: 0 };
  const next = new Map(counts);
  next.set(peer, {
    parts: current.parts + (uploadType === 'part' ? 1 : 0),
    tracks: current.tracks + (uploadType === 'track' ? 1 : 0),
  });
  return next;
}

/**
 * CID → 作者映射（royalty 收款人解析）。⭐血緣節點語意：版本後繼（successorEdges）
 * 同人不變，故 record.author 即血緣作者；跨版本映射細化隨 versioning B 軸落地。
 */
export function extractUgcAuthors(
  ugcRecords: ReadonlyMap<CID, UgcRecord>,
  lineageNodeByCid: ReadonlyMap<CID, CID> = new Map(),
): ReadonlyMap<CID, PeerId> {
  const authors = new Map<CID, PeerId>();
  for (const [cid, record] of ugcRecords) {
    const node = lineageNodeByCid.get(cid) ?? cid;
    const nodeAuthor = ugcRecords.get(node)?.author ?? record.author;
    authors.set(cid, nodeAuthor);
    authors.set(node, nodeAuthor);
  }
  return authors;
}
