/**
 * EconomyConfig — 治理 config 傘（名稱歷史沿用、實含非經濟群組）；
 * **介面＋預設值＝權威轉錄、本檔不另造**。治理
 * ConfigUpdateEvent 可調、每次 epoch +1（＝economy_config_version）；
 * newcomer／reputation 群組不在 config（累積型 derive 消費值＝protocol 常數）。
 * 標注「待 playtest」之預設為初估值。
 * 檔案層邊界：ledger 會值引本葉檔；本檔不得 runtime import ledger，否則閉成初始化環。
 */
import type { PeerId, Timestamp } from '@open4wd/interfaces';
import {
  FORK_DETECTION_DEFAULTS,
  type ForkDetectionConfig,
  type ForkThreshold,
} from '../ugc-fork/config';

/** 治理設定每次有效更新後單調增加的版本號。 */
export type EconomyConfigEpoch = number;
export type { ForkDetectionConfig };

/** 當代、父代與祖代創作者間的回饋拆分規則。 */
export interface RevShareConfig {
  /** pct 整數（共識計算不用浮點比例）；三層總和必須＝100（不變式） */
  currentTierPct: number;
  parentTierPct: number;
  grandparentTierPct: number;
  /** 封頂三層 */
  maxDepth: number;
}

/** 共識推導所使用、由治理 epoch 版本化的完整設定。 */
export interface EconomyConfig {
  epoch: EconomyConfigEpoch;
  signedAt: Timestamp;
  signers: readonly PeerId[];
  revShare: RevShareConfig;
  forkDetection: ForkDetectionConfig;
  /** 月軟曲線軟上限（match-prize／royalty 計入 monthMinted）；待 playtest */
  month_soft_cap_minor: number;
  /** 月鑄幣聚合硬頂（fold 端 timeless 守門）：當月已鑄達此值＝後續 match-result 整場不鑄；設 ≈100×soft＝對齊 live 軟曲線自停之處，合法 live play 先撞軟曲線 0、碰不到此頂，僅擋歷史 append 繞過軟曲線的憑空鑄幣；待 playtest */
  month_hard_cap_minor: number;
  match_prize: {
    /** 待 playtest（初估） */
    base_amount_minor: number;
    /** 名次乘數 pct（尾檔攤平）；待 playtest */
    rank_multipliers_pct: readonly number[];
    /** finisherCount 低於此＝整場經濟 void */
    min_player_count: number;
    /** K=5 combo 窗（小時） */
    combo_window_hours: number;
    /** 同組合窗內合格場上限（K） */
    combo_max_matches_per_day: number;
    /** per-player 24h 有獎場數上限 */
    player_prized_matches_per_day: number;
  };
  creator_royalty: {
    /** 待 playtest（初估、對齊維度驗算例） */
    base_per_use_minor: number;
    /** 同 (UGC, 玩家) 去重窗（小時） */
    dedup_window_hours: number;
  };
  upload_costs: {
    part_upload_minor: number;
    track_upload_minor: number;
    metadata_update_minor: number;
  };
  expansion_costs: {
    /** 車位無上限、場地無位數概念 */
    vehicle_slot_minor: number;
  };
  sponsorship: {
    /** 治理下限且不得低於 1 minor；builder、live、fold 共用 sponsor-policy */
    min_amount_minor: number;
  };
  /** 治理 multisig signer set 本體（genesis 初始化；變更＝ConfigUpdateEvent、quorum 以 prevEpoch set 計） */
  governanceSigners: readonly PeerId[];
  /** DerivedState.recentMatches 保留窗（近 N quarter） */
  hot_match_quarters: number;
  /** P5 退役門檻；全待 playtest */
  ugc_lifecycle: {
    candidate_no_use_ms: number;
    candidate_low_rating_threshold_x100: number;
    candidate_low_rating_no_use_ms: number;
    candidate_creator_gone_ms: number;
    maintenance_grace_ms: number;
    maintenance_burn_minor: number;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 凍結版 fork 門檻（不就地凍結共享常數、以深拷貝凍結——共識預設不可被執行期改寫） */
const frozenThreshold = (threshold: ForkThreshold): ForkThreshold =>
  Object.freeze({ ...threshold });

/**
 * genesis 預設（部署時 governanceSigners 注入真值；待 playtest 值＝初估）。
 * rank_multipliers_pct 範例：8 人賽月初＝400/200/120/56 minor。
 * ⭐逐層深凍結：genesis 為 fold 起點共識值，任何執行期改寫（含巢狀陣列）都會
 * 讓各 client derive 分歧——比照地基層常數慣例全樹 Object.freeze。
 */
export const GENESIS_ECONOMY_CONFIG: EconomyConfig = Object.freeze({
  epoch: 1,
  signedAt: 0,
  signers: Object.freeze<PeerId[]>([]),
  revShare: Object.freeze({
    currentTierPct: 70,
    parentTierPct: 20,
    grandparentTierPct: 10,
    maxDepth: 3,
  }),
  forkDetection: Object.freeze({
    stage1_geometry: Object.freeze({ ...FORK_DETECTION_DEFAULTS.stage1_geometry }),
    stage2_physics: Object.freeze({
      rigid: frozenThreshold(FORK_DETECTION_DEFAULTS.stage2_physics.rigid),
      rolling: frozenThreshold(FORK_DETECTION_DEFAULTS.stage2_physics.rolling),
      functional_mesh: frozenThreshold(FORK_DETECTION_DEFAULTS.stage2_physics.functional_mesh),
      functional_sidecar: frozenThreshold(
        FORK_DETECTION_DEFAULTS.stage2_physics.functional_sidecar,
      ),
      chip_mesh: frozenThreshold(FORK_DETECTION_DEFAULTS.stage2_physics.chip_mesh),
      chip_skill: frozenThreshold(FORK_DETECTION_DEFAULTS.stage2_physics.chip_skill),
      track: frozenThreshold(FORK_DETECTION_DEFAULTS.stage2_physics.track),
    }),
  }),
  month_soft_cap_minor: 1_000_000, // 初估（1 萬幣／月）；待 playtest
  month_hard_cap_minor: 100_000_000, // ＝100×soft（fold 聚合硬頂、對齊軟曲線自停點）；待 playtest
  match_prize: Object.freeze({
    base_amount_minor: 50, // 初估；待 playtest
    rank_multipliers_pct: Object.freeze([100, 50, 30, 14]), // 初估；待 playtest
    min_player_count: 3,
    combo_window_hours: 24,
    combo_max_matches_per_day: 5,
    player_prized_matches_per_day: 20,
  }),
  creator_royalty: Object.freeze({
    base_per_use_minor: 50, // 初估；待 playtest
    dedup_window_hours: 24,
  }),
  upload_costs: Object.freeze({
    part_upload_minor: 50,
    track_upload_minor: 500,
    metadata_update_minor: 0,
  }),
  expansion_costs: Object.freeze({ vehicle_slot_minor: 1000 }),
  sponsorship: Object.freeze({ min_amount_minor: 1 }), // canon 定值：≥1 minor
  governanceSigners: Object.freeze<PeerId[]>([]),
  hot_match_quarters: 2,
  ugc_lifecycle: Object.freeze({
    candidate_no_use_ms: 90 * DAY_MS, // 以下六值全初估；待 playtest
    candidate_low_rating_threshold_x100: 300,
    candidate_low_rating_no_use_ms: 60 * DAY_MS,
    candidate_creator_gone_ms: 180 * DAY_MS,
    maintenance_grace_ms: 30 * DAY_MS,
    maintenance_burn_minor: 100,
  }),
});

/** 部署 trust root 注入；其餘 genesis 欄位沿用深凍結權威值。 */
export function genesisEconomyConfigWithGovernance(
  governanceSigners: readonly PeerId[],
  genesisTimestamp = 0,
): EconomyConfig {
  if (!Number.isSafeInteger(genesisTimestamp) || genesisTimestamp < 0)
    throw new TypeError('genesisTimestamp must be a non-negative safe integer');
  return Object.freeze({
    ...GENESIS_ECONOMY_CONFIG,
    signedAt: genesisTimestamp,
    governanceSigners: Object.freeze([...governanceSigners]),
  });
}

/** config 不變式（載入／治理更新時檢查）：revShare 三層總和必須＝100 */
export function validateEconomyConfig(config: EconomyConfig): boolean {
  const { currentTierPct, parentTierPct, grandparentTierPct } = config.revShare;
  return currentTierPct + parentTierPct + grandparentTierPct === 100;
}

const nonNegInt = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const finiteNonNeg = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const stringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

const ROOT_KEYS = [
  'epoch',
  'signedAt',
  'signers',
  'revShare',
  'forkDetection',
  'month_soft_cap_minor',
  'month_hard_cap_minor',
  'match_prize',
  'creator_royalty',
  'upload_costs',
  'expansion_costs',
  'sponsorship',
  'governanceSigners',
  'hot_match_quarters',
  'ugc_lifecycle',
] as const;
const REV_SHARE_KEYS = [
  'currentTierPct',
  'parentTierPct',
  'grandparentTierPct',
  'maxDepth',
] as const;
const FORK_KEYS = ['stage1_geometry', 'stage2_physics'] as const;
const STAGE1_KEYS = ['passthrough_threshold'] as const;
const STAGE2_KEYS = [
  'rigid',
  'rolling',
  'functional_mesh',
  'functional_sidecar',
  'chip_mesh',
  'chip_skill',
  'track',
] as const;
const THRESHOLD_KEYS = ['strict', 'loose'] as const;
const MATCH_PRIZE_KEYS = [
  'base_amount_minor',
  'rank_multipliers_pct',
  'min_player_count',
  'combo_window_hours',
  'combo_max_matches_per_day',
  'player_prized_matches_per_day',
] as const;
const CREATOR_ROYALTY_KEYS = ['base_per_use_minor', 'dedup_window_hours'] as const;
const UPLOAD_COST_KEYS = [
  'part_upload_minor',
  'track_upload_minor',
  'metadata_update_minor',
] as const;
const EXPANSION_COST_KEYS = ['vehicle_slot_minor'] as const;
const SPONSORSHIP_KEYS = ['min_amount_minor'] as const;
const UGC_LIFECYCLE_KEYS = [
  'candidate_no_use_ms',
  'candidate_low_rating_threshold_x100',
  'candidate_low_rating_no_use_ms',
  'candidate_creator_gone_ms',
  'maintenance_grace_ms',
  'maintenance_burn_minor',
] as const;

function isForkThresholdShape(value: unknown): boolean {
  return (
    plain(value) &&
    exactKeys(value, THRESHOLD_KEYS) &&
    finiteNonNeg(value['strict']) &&
    finiteNonNeg(value['loose'])
  );
}

/**
 * 結構守門（治理 fold 前置）：欄位缺失／型別違規的 newConfig 一旦入 state 會毒化
 * 後續全部費率驗證（甚至 governanceSigners 壞形＝治理永久斷鏈），故整棵樹逐欄驗
 * ——金額／計數＝非負安全整數、fork 門檻＝非負有限數、signer 集＝字串陣列。
 */
export function isEconomyConfigShape(value: unknown): value is EconomyConfig {
  if (!plain(value)) return false;
  const fork = value['forkDetection'] as Record<string, unknown> | undefined;
  const stage1 = plain(fork) ? (fork['stage1_geometry'] as Record<string, unknown>) : undefined;
  const stage2 = plain(fork) ? (fork['stage2_physics'] as Record<string, unknown>) : undefined;
  const prize = value['match_prize'] as Record<string, unknown> | undefined;
  const royalty = value['creator_royalty'] as Record<string, unknown> | undefined;
  const uploads = value['upload_costs'] as Record<string, unknown> | undefined;
  const expansion = value['expansion_costs'] as Record<string, unknown> | undefined;
  const sponsorship = value['sponsorship'] as Record<string, unknown> | undefined;
  const revShare = value['revShare'] as Record<string, unknown> | undefined;
  const life = value['ugc_lifecycle'] as Record<string, unknown> | undefined;
  return (
    exactKeys(value, ROOT_KEYS) &&
    nonNegInt(value['epoch']) &&
    nonNegInt(value['signedAt']) &&
    stringArray(value['signers']) &&
    plain(revShare) &&
    exactKeys(revShare, REV_SHARE_KEYS) &&
    nonNegInt(revShare['currentTierPct']) &&
    nonNegInt(revShare['parentTierPct']) &&
    nonNegInt(revShare['grandparentTierPct']) &&
    nonNegInt(revShare['maxDepth']) &&
    plain(fork) &&
    exactKeys(fork, FORK_KEYS) &&
    plain(stage1) &&
    exactKeys(stage1, STAGE1_KEYS) &&
    finiteNonNeg(stage1['passthrough_threshold']) &&
    plain(stage2) &&
    exactKeys(stage2, STAGE2_KEYS) &&
    (
      [
        'rigid',
        'rolling',
        'functional_mesh',
        'functional_sidecar',
        'chip_mesh',
        'chip_skill',
        'track',
      ] as const
    ).every((key) => isForkThresholdShape(stage2[key])) &&
    nonNegInt(value['month_soft_cap_minor']) &&
    (value['month_soft_cap_minor'] as number) >= 1 && // 月曲線除數基底＝不可為 0（否則 monthFactor 除零）
    nonNegInt(value['month_hard_cap_minor']) &&
    (value['month_hard_cap_minor'] as number) >= (value['month_soft_cap_minor'] as number) && // 聚合硬頂須 ≥ 軟上限（hard=0 會讓全部 match no-op＝永久關閉鑄幣）
    plain(prize) &&
    exactKeys(prize, MATCH_PRIZE_KEYS) &&
    nonNegInt(prize['base_amount_minor']) &&
    Array.isArray(prize['rank_multipliers_pct']) &&
    (prize['rank_multipliers_pct'] as unknown[]).length >= 1 &&
    (prize['rank_multipliers_pct'] as unknown[]).every(nonNegInt) &&
    nonNegInt(prize['min_player_count']) &&
    nonNegInt(prize['combo_window_hours']) &&
    nonNegInt(prize['combo_max_matches_per_day']) &&
    nonNegInt(prize['player_prized_matches_per_day']) &&
    plain(royalty) &&
    exactKeys(royalty, CREATOR_ROYALTY_KEYS) &&
    nonNegInt(royalty['base_per_use_minor']) &&
    nonNegInt(royalty['dedup_window_hours']) &&
    plain(uploads) &&
    exactKeys(uploads, UPLOAD_COST_KEYS) &&
    nonNegInt(uploads['part_upload_minor']) &&
    nonNegInt(uploads['track_upload_minor']) &&
    nonNegInt(uploads['metadata_update_minor']) &&
    plain(expansion) &&
    exactKeys(expansion, EXPANSION_COST_KEYS) &&
    nonNegInt(expansion['vehicle_slot_minor']) &&
    plain(sponsorship) &&
    exactKeys(sponsorship, SPONSORSHIP_KEYS) &&
    nonNegInt(sponsorship['min_amount_minor']) &&
    Number(sponsorship['min_amount_minor']) >= 1 &&
    stringArray(value['governanceSigners']) &&
    typeof value['hot_match_quarters'] === 'number' &&
    Number.isSafeInteger(value['hot_match_quarters']) &&
    value['hot_match_quarters'] >= 1 &&
    plain(life) &&
    exactKeys(life, UGC_LIFECYCLE_KEYS) &&
    nonNegInt(life['candidate_no_use_ms']) &&
    nonNegInt(life['candidate_low_rating_threshold_x100']) &&
    nonNegInt(life['candidate_low_rating_no_use_ms']) &&
    nonNegInt(life['candidate_creator_gone_ms']) &&
    nonNegInt(life['maintenance_grace_ms']) &&
    nonNegInt(life['maintenance_burn_minor'])
  );
}
