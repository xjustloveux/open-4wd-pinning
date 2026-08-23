/**
 * DerivedState 決定性序列化（記憶體 Map/Set 視圖 ↔ dag-cbor 塊）——Map→plain
 * Record（dag-cbor canonical 鍵排序＝插入序無關）、Set→字典序排序陣列（陣列序
 * dag-cbor 不管、必須自排）、bigint 原樣；解碼側⭐bigint 歸一（安全範圍整數
 * dag-cbor 解回 number——貨幣欄位逐一還原，同 event-codec 坑）。塊身分＝
 * CIDv1(dag-cbor, sha2-256)，內容定址＝跨 peer 重算比對的完整性錨。
 */
import * as dagCbor from '@ipld/dag-cbor';
import type { CID, PeerId, Timestamp } from '@open4wd/interfaces';
import { peerIdToPublicKey } from '../key-manager/ed25519';
import { GENESIS_ECONOMY_CONFIG, type EconomyConfig } from '../economy/config';
import { cidOfDagCborBytes } from './content-cid';
import type { ColdPartitionKey } from './derive-utils';
import type {
  ColdMatchPartition,
  CreatorRatingMilestone,
  DerivedState,
  MatchRecord,
  MonthlyEconomyFlow,
  UgcRatingStat,
  UgcRecord,
  UgcUsageStat,
} from './derived-state';
import { validateUgcPresentationMetadata } from '../ugc-fork/presentation';
import type { MatchEconomySettlement } from './events';

/** Governance signer-set content block 的 canonical byte 上限。 */
export const LEDGER_SIGNER_SET_MAX_BYTES = 16 * 1024;
/** 完整 derived-state checkpoint block 的 canonical byte 上限。 */
export const LEDGER_DERIVED_STATE_MAX_BYTES = 16 * 1024 * 1024;
/** 單一 cold match partition block 的 canonical byte 上限。 */
export const LEDGER_COLD_PARTITION_MAX_BYTES = 8 * 1024 * 1024;

/** dag-cbor bytes 的 CIDv1（字串形＝專案 CID brand） */
export function cidOfBytes(bytes: Uint8Array): CID {
  return cidOfDagCborBytes(bytes);
}

// ── 泛型轉換 ──

function mapToRecord<V, W = V>(
  source: ReadonlyMap<string, V>,
  mapValue?: (value: V) => W,
): Record<string, W> {
  const record: Record<string, W> = {};
  for (const [key, value] of source)
    record[key] = mapValue === undefined ? (value as unknown as W) : mapValue(value);
  return record;
}

function recordToMap<V, W = V, K extends string = string>(
  source: Record<string, V>,
  mapValue?: (value: V) => W,
): Map<K, W> {
  const map = new Map<K, W>();
  for (const [key, value] of Object.entries(source))
    map.set(key as K, mapValue === undefined ? (value as unknown as W) : mapValue(value));
  return map;
}

function setToSortedArray(source: ReadonlySet<string>): string[] {
  return [...source].sort();
}

/** dag-cbor 解回的整數可能是 number（安全範圍）或 bigint（超範圍）——歸一 bigint */
function asBigInt(value: unknown): bigint {
  return typeof value === 'bigint' ? value : BigInt(value as number);
}

// ── MatchRecord 與 wire 互轉 ──

function settlementFromWire(wire: Record<string, unknown>): MatchEconomySettlement {
  const shares = (list: unknown): Record<string, unknown>[] =>
    (list as Record<string, unknown>[]).map((share) => ({
      ...share,
      amount: asBigInt(share['amount']),
    }));
  return {
    ...(wire as unknown as MatchEconomySettlement),
    matchPrizes: shares(wire['matchPrizes']) as unknown as MatchEconomySettlement['matchPrizes'],
    royalties: shares(wire['royalties']) as unknown as MatchEconomySettlement['royalties'],
  };
}

function matchRecordToWire(record: MatchRecord): Record<string, unknown> {
  return {
    ...record,
    loadouts: mapToRecord(record.loadouts),
    clientVersions: mapToRecord(record.clientVersions),
  };
}

function matchRecordFromWire(wire: Record<string, unknown>): MatchRecord {
  return {
    ...(wire as unknown as MatchRecord),
    loadouts: recordToMap(wire['loadouts'] as Record<string, never>),
    clientVersions: recordToMap(wire['clientVersions'] as Record<string, never>),
    settlement: settlementFromWire(wire['settlement'] as Record<string, unknown>),
    economyOutcome: {
      ...(wire['economyOutcome'] as MatchRecord['economyOutcome']),
      mintedTotal: asBigInt((wire['economyOutcome'] as Record<string, unknown>)['mintedTotal']),
    },
  };
}

// ── UgcRecord ↔ wire（metadata.fingerprint bigint 復原） ──

/** 整數量化欄位命名規約：這些單位後綴＝bigint（ugc-fork 指紋 mg/μm/mm 系） */
const QUANTIZED_SUFFIXES = ['_mg', '_um', '_um2', '_um3', '_mm', '_mm2'];

function isQuantizedKey(key: string): boolean {
  return QUANTIZED_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

/**
 * fingerprint 解碼歸一：dag-cbor 把安全範圍 bigint 解回 number——依單位後綴規約
 * 還原（含 bigint 陣列如 com_um）；非量化欄（slotCount／allocationPct 等）保持 number。
 */
function reviveFingerprint(wire: Record<string, unknown>): Record<string, unknown> {
  const revived: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wire)) {
    if (isQuantizedKey(key))
      revived[key] = Array.isArray(value) ? value.map(asBigInt) : asBigInt(value);
    else revived[key] = value;
  }
  return revived;
}

function ugcRecordFromWire(wire: Record<string, unknown>): UgcRecord {
  if (!validateUgcPresentationMetadata(wire['presentation']))
    throw new TypeError('ugc record presentation is missing or invalid');
  if (
    typeof wire['presentationRevision'] !== 'number' ||
    !Number.isSafeInteger(wire['presentationRevision']) ||
    wire['presentationRevision'] < 0
  )
    throw new TypeError('ugc record presentationRevision is missing or invalid');
  if (
    typeof wire['presentationUpdatedAt'] !== 'number' ||
    !Number.isSafeInteger(wire['presentationUpdatedAt']) ||
    wire['presentationUpdatedAt'] < 0
  )
    throw new TypeError('ugc record presentationUpdatedAt is missing or invalid');
  const metadata = wire['metadata'] as Record<string, unknown> | undefined;
  const fingerprint = metadata?.['fingerprint'] as Record<string, unknown> | undefined;
  return {
    ...wire,
    sponsoredTotalMinor: asBigInt(wire['sponsoredTotalMinor']),
    ...(metadata !== undefined && fingerprint !== undefined
      ? { metadata: { ...metadata, fingerprint: reviveFingerprint(fingerprint) } }
      : {}),
  } as unknown as UgcRecord;
}

// ── UgcUsageStat 與 wire 互轉 ──

function usageStatToWire(stat: UgcUsageStat): Record<string, unknown> {
  return {
    ...stat,
    uniqueUsers: setToSortedArray(stat.uniqueUsers),
    lastRoyaltyAtByPlayer: mapToRecord(stat.lastRoyaltyAtByPlayer),
  };
}

function usageStatFromWire(wire: Record<string, unknown>): UgcUsageStat {
  return {
    ...(wire as unknown as UgcUsageStat),
    uniqueUsers: new Set(wire['uniqueUsers'] as PeerId[]),
    lastRoyaltyAtByPlayer: recordToMap(
      wire['lastRoyaltyAtByPlayer'] as Record<string, Timestamp>,
    ) as ReadonlyMap<PeerId, Timestamp>,
    totalRoyaltyMinted: asBigInt(wire['totalRoyaltyMinted']),
  };
}

function monthlyEconomyFlowFromWire(wire: Record<string, unknown>): MonthlyEconomyFlow {
  return {
    mintedMinor: asBigInt(wire['mintedMinor']),
    burnedMinor: asBigInt(wire['burnedMinor']),
  };
}

function paymentIntentSetFromWire(value: unknown): ReadonlySet<string> {
  if (
    !Array.isArray(value) ||
    value.some((digest) => typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) ||
    new Set(value).size !== value.length
  )
    throw new TypeError('derived state processedPaymentIntents is invalid');
  return new Set(value);
}

// ── DerivedState 與 wire 互轉 ──

/** DerivedState → dag-cbor bytes（決定性：同狀態不同插入序＝同 bytes 同 CID） */
export function encodeDerivedState(state: DerivedState): Uint8Array {
  const wire = {
    economy: {
      ...state.economy,
      balances: mapToRecord(state.economy.balances),
      uploadCounts: mapToRecord(state.economy.uploadCounts),
      firstUploadDebtUsed: setToSortedArray(state.economy.firstUploadDebtUsed),
      recentMatchCombos: mapToRecord(state.economy.recentMatchCombos),
      recentPrizedMatches: mapToRecord(state.economy.recentPrizedMatches),
      monthlyFlowsByMonth: mapToRecord(state.economy.monthlyFlowsByMonth, (peers) =>
        mapToRecord(peers),
      ),
      lifetimeRoyaltyMintedByPeer: mapToRecord(state.economy.lifetimeRoyaltyMintedByPeer),
      processedPaymentIntents: setToSortedArray(state.economy.processedPaymentIntents),
    },
    ugc: {
      ugcRecords: mapToRecord(state.ugc.ugcRecords),
      forkLineage: mapToRecord(state.ugc.forkLineage),
      ugcUsageStats: mapToRecord(state.ugc.ugcUsageStats, usageStatToWire),
      similarityPending: setToSortedArray(state.ugc.similarityPending),
    },
    moderation: {
      blacklist: setToSortedArray(state.moderation.blacklist),
      peerBlacklist: setToSortedArray(state.moderation.peerBlacklist),
      pendingReports: mapToRecord(state.moderation.pendingReports),
      reportsByReporter: mapToRecord(state.moderation.reportsByReporter, (inner) =>
        mapToRecord(inner),
      ),
      reportAccuracy: mapToRecord(state.moderation.reportAccuracy),
      arbitrationResults: mapToRecord(state.moderation.arbitrationResults),
      convictionsByOffender: mapToRecord(state.moderation.convictionsByOffender),
      uploadPendingConvictions: mapToRecord(state.moderation.uploadPendingConvictions),
    },
    reputation: {
      scores: mapToRecord(state.reputation.scores),
      history: mapToRecord(state.reputation.history),
      lastMaliciousReporterAt: mapToRecord(state.reputation.lastMaliciousReporterAt),
      recentMatchGains: mapToRecord(state.reputation.recentMatchGains),
      registeredAt: mapToRecord(state.reputation.registeredAt),
      matchCount: mapToRecord(state.reputation.matchCount),
      ugcCount: mapToRecord(state.reputation.ugcCount),
      ugcMilestonesAwarded: mapToRecord(state.reputation.ugcMilestonesAwarded),
    },
    ratings: {
      ugcRatings: mapToRecord(state.ratings.ugcRatings, (stat) => ({
        ...stat,
        explicitVotes: mapToRecord(stat.explicitVotes),
      })),
      creatorMilestones: mapToRecord(state.ratings.creatorMilestones, (milestone) => ({
        ...milestone,
        awardedCids: setToSortedArray(milestone.awardedCids),
      })),
    },
    match: {
      recentMatches: mapToRecord(state.match.recentMatches, matchRecordToWire),
      settledMatchIds: setToSortedArray(state.match.settledMatchIds),
      trueSkillRatings: mapToRecord(state.match.trueSkillRatings),
      playerSlotCounts: mapToRecord(state.match.playerSlotCounts),
      disconnectCounts: mapToRecord(state.match.disconnectCounts),
      processedDisconnectEffects: setToSortedArray(state.match.processedDisconnectEffects),
    },
    assetVersion: {
      minSupportedByType: mapToRecord(state.assetVersion.minSupportedByType),
      versionStatusByCid: mapToRecord(state.assetVersion.versionStatusByCid),
      successorEdges: mapToRecord(state.assetVersion.successorEdges),
      lineageNodeByCid: mapToRecord(state.assetVersion.lineageNodeByCid),
    },
    deriveRuleEpoch: state.deriveRuleEpoch,
    // 全 number/string/巢狀 plain（無 bigint）——dag-cbor canonical 鍵排序保決定性
    economyConfig: state.economyConfig,
    lastEventAt: mapToRecord(state.lastEventAt),
    coldMatchPartitions: mapToRecord(state.coldMatchPartitions),
    derivedAt: state.derivedAt,
    fromCheckpoint: state.fromCheckpoint,
    eventsAppliedSinceCheckpoint: state.eventsAppliedSinceCheckpoint,
  };
  const encoded = dagCbor.encode(wire);
  return new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
}

/** dag-cbor bytes → DerivedState（塊來源以 CID 內容定址擔保完整性） */
export function decodeDerivedState(bytes: Uint8Array): DerivedState {
  if (bytes.byteLength > LEDGER_DERIVED_STATE_MAX_BYTES)
    throw new RangeError('derived state block too large');
  const wire = dagCbor.decode(bytes) as Record<string, Record<string, never>>;
  const economy = wire['economy'] as Record<string, unknown>;
  const ugc = wire['ugc'] as Record<string, unknown>;
  const moderation = wire['moderation'] as Record<string, unknown>;
  const reputation = wire['reputation'] as Record<string, unknown>;
  const ratings = wire['ratings'] as Record<string, unknown>;
  const match = wire['match'] as Record<string, unknown>;
  const assetVersion = wire['assetVersion'] as Record<string, unknown>;
  const deriveRuleEpoch = wire['deriveRuleEpoch'];
  if (
    typeof deriveRuleEpoch !== 'string' ||
    String(deriveRuleEpoch).length === 0 ||
    new TextEncoder().encode(deriveRuleEpoch).byteLength > 256
  )
    throw new TypeError('derived state deriveRuleEpoch is invalid');
  const record = (value: unknown): Record<string, never> => value as Record<string, never>;
  return {
    economy: {
      balances: recordToMap(record(economy['balances']), asBigInt) as ReadonlyMap<PeerId, bigint>,
      totalMinted: asBigInt(economy['totalMinted']),
      totalBurned: asBigInt(economy['totalBurned']),
      monthMinted: asBigInt(economy['monthMinted']),
      monthStartTimestamp: economy['monthStartTimestamp'] as Timestamp,
      uploadCounts: recordToMap(record(economy['uploadCounts'])),
      firstUploadDebtUsed: new Set(economy['firstUploadDebtUsed'] as PeerId[]),
      recentMatchCombos: recordToMap(record(economy['recentMatchCombos'])),
      recentPrizedMatches: recordToMap(record(economy['recentPrizedMatches'])),
      monthlyFlowsByMonth: recordToMap(
        record(economy['monthlyFlowsByMonth']),
        (peers: Record<string, never>) =>
          recordToMap(peers, monthlyEconomyFlowFromWire) as ReadonlyMap<PeerId, MonthlyEconomyFlow>,
      ),
      lifetimeRoyaltyMintedByPeer: recordToMap(
        record(economy['lifetimeRoyaltyMintedByPeer']),
        asBigInt,
      ) as ReadonlyMap<PeerId, bigint>,
      processedPaymentIntents: paymentIntentSetFromWire(economy['processedPaymentIntents']),
    },
    ugc: {
      ugcRecords: recordToMap(record(ugc['ugcRecords']), ugcRecordFromWire),
      forkLineage: recordToMap(record(ugc['forkLineage'])),
      ugcUsageStats: recordToMap(record(ugc['ugcUsageStats']), usageStatFromWire),
      similarityPending: new Set(ugc['similarityPending'] as CID[]),
    },
    moderation: {
      blacklist: new Set(moderation['blacklist'] as CID[]),
      peerBlacklist: new Set(moderation['peerBlacklist'] as PeerId[]),
      pendingReports: recordToMap(record(moderation['pendingReports'])),
      reportsByReporter: recordToMap(record(moderation['reportsByReporter']), (inner) =>
        recordToMap(inner),
      ),
      reportAccuracy: recordToMap(record(moderation['reportAccuracy'])),
      arbitrationResults: recordToMap(record(moderation['arbitrationResults'])),
      convictionsByOffender: recordToMap(record(moderation['convictionsByOffender'] ?? {})),
      uploadPendingConvictions: recordToMap(record(moderation['uploadPendingConvictions'] ?? {})),
    },
    reputation: {
      scores: recordToMap(record(reputation['scores'])),
      history: recordToMap(record(reputation['history'])),
      lastMaliciousReporterAt: recordToMap(record(reputation['lastMaliciousReporterAt'])),
      recentMatchGains: recordToMap(record(reputation['recentMatchGains'])),
      registeredAt: recordToMap(record(reputation['registeredAt'])),
      matchCount: recordToMap(record(reputation['matchCount'])),
      ugcCount: recordToMap(record(reputation['ugcCount'])),
      ugcMilestonesAwarded: recordToMap(record(reputation['ugcMilestonesAwarded'] ?? {})),
    },
    ratings: {
      ugcRatings: recordToMap(record(ratings['ugcRatings']), (wireStat: Record<string, never>) => ({
        ...(wireStat as unknown as UgcRatingStat),
        explicitVotes: recordToMap(wireStat['explicitVotes']),
        weightedSumX10000: asBigInt(wireStat['weightedSumX10000']),
        totalWeightX100: asBigInt(wireStat['totalWeightX100']),
      })),
      creatorMilestones: recordToMap(
        record(ratings['creatorMilestones']),
        (wireMilestone: Record<string, never>) => ({
          ...(wireMilestone as unknown as CreatorRatingMilestone),
          awardedCids: new Set(wireMilestone['awardedCids'] as readonly CID[]),
        }),
      ),
    },
    match: {
      recentMatches: recordToMap(record(match['recentMatches']), matchRecordFromWire),
      // 持久去重集為權威欄（encode 端恆為 recentMatches 超集）；缺欄＝空集，不由 hot 窗推播種
      settledMatchIds: new Set((match['settledMatchIds'] as string[] | undefined) ?? []),
      trueSkillRatings: recordToMap(record(match['trueSkillRatings'])),
      playerSlotCounts: recordToMap(record(match['playerSlotCounts'])),
      disconnectCounts: recordToMap(record(match['disconnectCounts'] ?? {})),
      processedDisconnectEffects: new Set(
        (match['processedDisconnectEffects'] as string[] | undefined) ?? [],
      ),
    },
    assetVersion: {
      minSupportedByType: recordToMap(record(assetVersion['minSupportedByType'])),
      versionStatusByCid: recordToMap(record(assetVersion['versionStatusByCid'])),
      successorEdges: recordToMap(record(assetVersion['successorEdges'])),
      lineageNodeByCid: recordToMap(record(assetVersion['lineageNodeByCid'])),
    },
    deriveRuleEpoch,
    economyConfig: (wire['economyConfig'] ?? GENESIS_ECONOMY_CONFIG) as unknown as EconomyConfig,
    lastEventAt: recordToMap(record(wire['lastEventAt'] ?? {})) as ReadonlyMap<PeerId, Timestamp>,
    coldMatchPartitions: recordToMap(record(wire['coldMatchPartitions'])) as ReadonlyMap<
      ColdPartitionKey,
      CID
    >,
    derivedAt: wire['derivedAt'] as unknown as Timestamp,
    fromCheckpoint: wire['fromCheckpoint'] as unknown as CID | null,
    eventsAppliedSinceCheckpoint: wire['eventsAppliedSinceCheckpoint'] as unknown as number,
  };
}

// ── Cold partition／signer set 塊 ──

/** 將 「partition」 轉換為 Uint8Array，供帳本流程顯示或傳輸。 */
export function encodeColdPartition(partition: ColdMatchPartition): Uint8Array {
  const encoded = dagCbor.encode({
    partitionKey: partition.partitionKey,
    matchRecords: mapToRecord(partition.matchRecords, matchRecordToWire),
  });
  return new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
}

/** 驗證大小與 schema 後解碼 canonical cold match partition。 */
export function decodeColdPartition(bytes: Uint8Array): ColdMatchPartition {
  if (bytes.byteLength > LEDGER_COLD_PARTITION_MAX_BYTES)
    throw new RangeError('cold partition block too large');
  const wire = dagCbor.decode(bytes) as Record<string, unknown>;
  return {
    partitionKey: wire['partitionKey'] as ColdPartitionKey,
    matchRecords: recordToMap(wire['matchRecords'] as Record<string, never>, matchRecordFromWire),
  };
}

/** 治理 signer set 塊（字典序排序＝決定性 CID） */
export function encodeSignerSet(signers: ReadonlySet<PeerId>): Uint8Array {
  const encoded = dagCbor.encode(setToSortedArray(signers));
  return new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
}

/** 驗證 canonical encoding、排序、唯一性與大小後解碼 signer set。 */
export function decodeSignerSet(bytes: Uint8Array): ReadonlySet<PeerId> {
  if (bytes.byteLength > LEDGER_SIGNER_SET_MAX_BYTES)
    throw new RangeError('signer set block too large');
  const decoded: unknown = dagCbor.decode(bytes);
  if (
    !Array.isArray(decoded) ||
    (decoded.length !== 1 && decoded.length < 3) ||
    decoded.length > 64
  )
    throw new Error('invalid signer set shape');
  const signers: PeerId[] = [];
  let previous: string | null = null;
  for (const value of decoded) {
    if (typeof value !== 'string' || peerIdToPublicKey(value as PeerId) === null)
      throw new Error('invalid signer set PeerId');
    if (previous !== null && previous >= value)
      throw new Error('signer set must be unique and canonically sorted');
    previous = value;
    signers.push(value as PeerId);
  }
  const canonical = encodeSignerSet(new Set(signers));
  if (
    canonical.byteLength !== bytes.byteLength ||
    !canonical.every((byte, index) => byte === bytes[index])
  )
    throw new Error('signer set block is not canonical');
  return new Set(signers);
}
