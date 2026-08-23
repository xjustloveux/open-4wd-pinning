/**
 * protocol/ugc — UGC 規格約束（跨 peer 共識必須一致）
 */
import type { Gram } from '../brands';
import vehicleAdmissionPolicy from './vehicle-admission-policy.json' with { type: 'json' };

/** client 與 pinning provider 使用的正規跨服務 UnixFS 內容 profile。 */
export const UGC_CONTENT_PROFILE_ID = 'open4wd-unixfs-1m-balanced-v1';
export const UGC_CONTENT_ROOT_CODECS = ['raw', 'dag-pb'] as const;
export const UGC_CONTENT_MULTIHASH = 'sha2-256';
export const UGC_CHUNK_BYTES = 1_048_576;
export const UGC_LOGICAL_MAX_BYTES = 80 * 1024 * 1024;
export const UGC_MAX_BLOCKS = Math.ceil(UGC_LOGICAL_MAX_BYTES / UGC_CHUNK_BYTES) + 1;
export const UGC_MAX_UNIXFS_LINKS = UGC_MAX_BLOCKS - 1;
export const UGC_MAX_DAG_BYTES = UGC_LOGICAL_MAX_BYTES + 64 * 1024;

/** 車輛與零件幾何、質量及資源預算的共識邊界常數群。 */
export const VEHICLE_TOTAL_MASS_MIN_GRAMS = 50 as Gram;
export const VEHICLE_TOTAL_MASS_MAX_GRAMS = 500 as Gram;
/** 整車 [長, 寬, 高] 上限；軸對應定死：長=Z（車頭=−Z）、寬=X、高=Y（重力反向） */
export const VEHICLE_AABB_MAX_M = Object.freeze([0.25, 0.13, 0.1]) as readonly [
  number,
  number,
  number,
];
export const PART_MATERIAL_DENSITY_RATIO_MAX = 50;
export const VEHICLE_PART_MASS_RATIO_MAX = vehicleAdmissionPolicy.vehiclePartMassRatioMax;
export const PART_VERTEX_COUNT_MAX = 100_000;
export const PART_TRIANGLE_COUNT_MAX = 100_000;
export const PART_COLLIDER_PROXY_COUNT_MAX = 32;
export const PART_COLLIDER_PROXY_POINT_MAX = 26;
export const PART_AABB_MIN_M = Object.freeze([0.001, 0.001, 0.001]) as readonly [
  number,
  number,
  number,
];
export const PART_AABB_MAX_M = Object.freeze([1, 1, 1]) as readonly [number, number, number];
export const PART_DEGENERATE_TRIANGLE_AREA_MIN_M2 = 0.00000001;
/** 場地 [長, 寬, 高] 上限；軸對應同 VEHICLE_AABB_MAX_M：長=Z、寬=X、高=Y（100m） */
export const TRACK_AABB_MAX_M = Object.freeze([500, 500, 100]) as readonly [number, number, number];
export const TRACK_GLB_SIZE_MAX_MB = 80;
export const TRACK_VISUAL_TRIANGLE_COUNT_MAX = 3_000_000;
export const TRACK_COLLIDER_TRIANGLE_COUNT_MAX = 500_000;
export const TRACK_COLLIDER_REGION_COUNT_MAX = 256;
export const TRACK_TEXTURE_BUDGET_1K_MAX = 16;
export const TRACK_TEXTURE_BUDGET_4K_MAX = 4;
export const TRACK_ENTITY_COUNT_MAX = 100;
export const TRACK_DESTRUCTIBLE_ENTITY_COUNT_MAX = 50;
export const WEATHER_PATCH_COUNT_MAX = 50;
export const TRACK_MAX_PLAYERS_HARDCAP = 8;
export const ROUTEPOINT_SURFACE_TOLERANCE_M = 0.005;
export const ROUTEPOINT_MIN_SPACING_M = 0.1;
export const LAP_MODE_LOOP_DISTANCE_M = 1;
/** 賽道 Checkpoint trigger box 最小 scale（z=行進向深度）。 */
export const TRACK_CHECKPOINT_TRIGGER_MIN_M = Object.freeze([0.1, 0.1, 1]) as readonly [
  number,
  number,
  number,
];
export const TRACK_CHECKPOINT_TRIGGER_MAX_AABB_RATIO = 0.1;
export const START_GRID_SAFETY_MARGIN_M = 0.05;
/** 起跑格中心間距＝整車寬上限＋安全邊距；與 editor auto_player_max 同式。 */
export const START_GRID_CELL_WIDTH_M = VEHICLE_AABB_MAX_M[1] + START_GRID_SAFETY_MARGIN_M;
/** 車體由 RP1 surface frame 沿 up 抬升，避免初始 collider 穿插。 */
export const START_GRID_LIFT_M = 0.05;
/** 終點定向平面的前後 crossing 容差。 */
export const FINISH_GATE_PLANE_EPS_M = 0.001;
/** 終點定向平面的左右邊界容差。 */
export const FINISH_GATE_LATERAL_EPS_M = 0.001;
/** chip volume_m3 → skill slot 數階梯；初估（1.5/3/6 cm³ 的 SI 表示）。 */
export const CHIP_SLOT_VOLUME_THRESHOLDS_M3 = Object.freeze([
  0.0000015, 0.000003, 0.000006,
]) as readonly number[];
export const NARROWEST_PATH_MARGIN_M = 0.05;
export const MAX_WEAPON_DRIVEN_BODIES = 16;
export const MAX_WEAPON_DRIVEN_PIVOTS = 8;
export const LAUNCH_AMMO_COUNT_MAX = 8;
export const VORONOI_FRAGMENT_COUNT_MAX = 8;
export const WIND_SPEED_MPS_MAX = 30;
export const MAGNET_SOURCE_STRENGTH_N_MAX = 10;
export const KINEMATIC_PERIOD_MS_MIN = 500; // 初估
export const KINEMATIC_AMPLITUDE_M_MAX = 20; // 初估
export const CONVEYOR_VELOCITY_M_S_MAX = 10; // 初估
export const FORK_SIMILARITY_THRESHOLD_PERCENT = 10;
export const DEPRECATED_TO_UNUSABLE_THRESHOLD = 3;
/**
 * 資產 schema 現行版本（per-type）：上鏈提交時寫入 GLB root extras `open4wd_version`
 * （canonical local／export／chain 成品皆寫入）。pre-launch 的完整 current shape 使用
 * PhysicsManifest v1；內部候選變更不得升 compatibility version，也不保留 fallback／遷移契約。
 */
export const ASSET_SCHEMA_VERSION_CURRENT = Object.freeze({
  chassis: 1,
  body: 1,
  tire: 1,
  roller: 1,
  motor: 1,
  battery: 1,
  chip: 1,
  weapon: 1,
  track: 1,
}) as Readonly<Record<string, number>>;
