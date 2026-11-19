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
/**
 * chassis 的原點（整車的 root）可以落在 chassis 包圍盒外的最大距離（m）。比賽的位置判定與起跑、
 * 回定位的擺放都以 root 為準，所以 root 必須在車身上；留 1 毫米是給幾何量化的誤差（issue 001409）。
 */
export const CHASSIS_ORIGIN_AABB_TOLERANCE_M = 0.001;
/** 非輪胎零件最低點對四輪接地平面的最小離地高度（m）。 */
export const VEHICLE_GROUND_CLEARANCE_MIN_M = 0.001;
export const PART_MATERIAL_DENSITY_RATIO_MAX = 50;
export const VEHICLE_PART_MASS_RATIO_MAX = vehicleAdmissionPolicy.vehiclePartMassRatioMax;
export const PART_VERTEX_COUNT_MAX = 100_000;
export const PART_TRIANGLE_COUNT_MAX = 100_000;
export const PART_COLLIDER_PROXY_COUNT_MAX = 32;
/** 每個碰撞 proxy 的點數上限：98 個整數支撐方向各取一點（issue 001436）。 */
export const PART_COLLIDER_PROXY_POINT_MAX = 98;
/**
 * 零件碰撞覆蓋門檻（issue 001440）：碰撞表面到最近可見外觀、可見外觀到最近碰撞，兩個方向的最大距離都不得超過
 * 「零件外框對角線 × 此比例」，再夾在下列上下限之間。
 */
export const PART_COLLIDER_COVERAGE_RATIO = 0.03;
/** 零件碰撞覆蓋門檻下限（公尺）。 */
export const PART_COLLIDER_COVERAGE_MIN_M = 0.001;
/** 零件碰撞覆蓋門檻上限（公尺）。 */
export const PART_COLLIDER_COVERAGE_MAX_M = 0.005;
/**
 * 覆蓋驗證的探測球半徑（公尺，issue 001440）：這麼大的球從外面到不了的空間（封閉空腔、比球窄的槽，以及依
 * 零件類型視為被相鄰零件蓋住的區域），碰撞可以填實而不計誤差。
 */
export const PART_COLLIDER_PROBE_RADIUS_M = 0.0025;
/**
 * 底盤往上凸起的放寬高度（公尺，issue 001440）：外觀取樣點往正下方移動不超過這個距離後，離碰撞在覆蓋門檻
 * 內，就視為已覆蓋。底盤上方是車殼與車內零件的位置，外界碰到底盤的方向是側面與底面，所以只放寬往上的
 * 矮凸起；側面與底面的凸出仍照覆蓋門檻計。
 */
export const PART_COLLIDER_LAYERED_DROP_M = 0.006;
/**
 * 覆蓋量測的取樣預算（issue 001440）：以取樣點的記帳次數計。碰撞表面的每個取樣點記 1 次，外觀表面的每個取樣點
 * 記「碰撞塊數」次，底盤的下移檢查另依「步數 × 碰撞塊數」記帳；超過即中止並記為不通過。取樣數由三角形最長邊
 * 決定、與面積無關，所以要有上限；以次數計，各端在同一處中止，結果與機器快慢無關。記帳只涵蓋取樣迴圈，參考
 * 實體的建立與每次距離查詢內部的三角形比對不在內，所以不是整體工作量或時間的上限。底盤與車殼另有一條中止條件：
 * 留給細桿分區的露出取樣點超過 50 萬個時同樣中止並記為不通過。
 */
export const PART_COLLIDER_COVERAGE_EVALUATION_MAX = 20_000_000;
/**
 * 各類零件的碰撞塊上限（issue 001440）：編輯器拆塊加到這個數量為止，到上限仍蓋不住外觀就不通過覆蓋驗證。
 * 車殼造型變化多、武器種類多，留給創作的空間較大；效能由創作者與組裝的玩家自行衡量，整車不另設合計上限。
 * 輪胎、導輪與車內零件各一塊。
 */
export const PART_COLLIDER_PIECE_MAX = Object.freeze({
  chassis: 10, // 底板、前後保桿與側向凸出
  body: 12, // 造型變化多
  weapon: 15, // 種類多
  battery: 1, // 整顆零件一塊凸包
  motor: 1, // 整顆零件一塊凸包
  chip: 1, // 整顆零件一塊凸包
  tire: 1, // 判圓 cylinder 或保角凸包
  roller: 1, // 判圓 cylinder 或保角凸包
});
export const PART_AABB_MIN_M = Object.freeze([0.001, 0.001, 0.001]) as readonly [
  number,
  number,
  number,
];
export const PART_AABB_MAX_M = Object.freeze([1, 1, 1]) as readonly [number, number, number];
export const PART_DEGENERATE_TRIANGLE_AREA_MIN_M2 = 0.00000001;
/**
 * 退化面積下限隨尺寸縮小：實際下限＝min(PART_DEGENERATE_TRIANGLE_AREA_MIN_M2, 本值 × 世界 AABB
 * 對角線²)。大型零件與場地維持絕對值，小零件不必為了撐大三角形而大幅減面。
 */
export const PART_DEGENERATE_TRIANGLE_AREA_DIAGONAL_RATIO = 0.000002;
/** 場地 [長, 寬, 高] 上限；軸對應同 VEHICLE_AABB_MAX_M：長=Z、寬=X、高=Y（100m） */
export const TRACK_AABB_MAX_M = Object.freeze([500, 500, 100]) as readonly [number, number, number];
export const TRACK_GLB_SIZE_MAX_MB = 80;
export const TRACK_VISUAL_TRIANGLE_COUNT_MAX = 3_000_000;
export const TRACK_COLLIDER_TRIANGLE_COUNT_MAX = 500_000;
export const TRACK_COLLIDER_REGION_COUNT_MAX = 256;
/**
 * 場地地面碰撞體的 XZ 格邊長預設值（公尺）。CCD TOI 對靜態 trimesh 的成本隨 piece 三角數放大：
 * 公版八車（heavy8、1,200 幀）每幀實付 P50 在 8 m 時都市 79 ms、叢林 51 ms，4 m 為 39／24 ms；2 m 只讓
 * 都市再降約兩成，叢林與雪地反而略升且快照更大（issue 001074、D-20261105-01）。
 */
export const TRACK_GROUND_CELL_M = 4;
/** manifest `collision.groundCellM` 的合法下限（公尺）。 */
export const TRACK_GROUND_CELL_MIN_M = 2;
/** manifest `collision.groundCellM` 的合法上限（公尺）。 */
export const TRACK_GROUND_CELL_MAX_M = 16;
/** 場地牆條帶沿路線方向的預設分段長度（公尺）。 */
export const TRACK_WALL_SEGMENT_LENGTH_M = 0.25;
/** 場地牆條帶沿路線方向的單段長度上限（公尺）。 */
export const TRACK_WALL_SEGMENT_LENGTH_MAX_M = 0.5;
/** 場地靜態碰撞體分段（地面格＋牆段）總數上限。 */
export const TRACK_COLLIDER_PIECE_COUNT_MAX = 8192;
/** 場地牆條帶宣告的單一截面環點數上限（含）；admission 在任何幾何運算前檢查。 */
export const TRACK_WALL_RING_POINTS_MAX = 64;
export const TRACK_TEXTURE_BUDGET_1K_MAX = 16;
export const TRACK_TEXTURE_BUDGET_4K_MAX = 4;
export const TRACK_ENTITY_COUNT_MAX = 100;
export const TRACK_DESTRUCTIBLE_ENTITY_COUNT_MAX = 50;
export const WEATHER_PATCH_COUNT_MAX = 50;
export const TRACK_MAX_PLAYERS_HARDCAP = 8;
export const ROUTEPOINT_SURFACE_TOLERANCE_M = 0.005;
/** RoutePoint 表面法線與重力反向夾角超過此值（度）時給軟警告（牆面／倒掛路段需作者確認）。 */
export const ROUTEPOINT_UP_GRAVITY_WARN_DEG = 60;
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
/**
 * 車體由 RP1 surface frame 沿 up 抬升，避免初始 collider 穿插；掉出場地後回定位到 RespawnPoint
 * 或起點時也沿該點的 up 抬升同一個量（issue 001405）。
 */
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
/** 場地不屬於 entity 的靜態磁源數量上限（D-20261116-05）；每幀磁力計算對每個磁源與每個目標各算一次。 */
export const TRACK_STATIC_MAGNET_SOURCE_COUNT_MAX = 64;
/** 每個場地 entity 的磁源數量上限（D-20261116-05）。 */
export const TRACK_ENTITY_MAGNET_SOURCE_COUNT_MAX = 8;
export const KINEMATIC_PERIOD_MS_MIN = 500; // 初估
/** step 曲線終點與起點各自的最短停留時間（D-20261116-03）；換算 60Hz 為 30 幀。 */
export const KINEMATIC_STEP_DWELL_MS_MIN = 500;
export const KINEMATIC_AMPLITUDE_M_MAX = 20; // 初估
export const CONVEYOR_VELOCITY_M_S_MAX = 10; // 初估
export const FORK_SIMILARITY_THRESHOLD_PERCENT = 10;
export const DEPRECATED_TO_UNUSABLE_THRESHOLD = 3;
/**
 * 編輯器預載彈脆弱警告門檻（D-20261025-01）：彈體獨立耐久開啟時，任一顆一擊損毀能量低於此值即警告。
 * 依據：公版八車三場（mixed8／heavy8、各 1,200 幀）車輛撞擊能量最大 0.37 J，依 canon 車重上限
 * 500 g 對公版 heavy 339 g 比例放大、再乘 2 倍安全係數約 1.1 J，考量 UGC 車較重較快取 1.0 J。
 */
export const PROJECTILE_FRAGILE_WARN_BURST_ENERGY_J = 1.0;
/**
 * 編輯器預載彈耐久估計旁顯示的參考值（D-20261025-01）：公版八車三場（mixed8／heavy8、各 1,200 幀）
 * 量測的車輛典型最大撞擊能量（J）。只供作者對照，不參與判定。
 */
export const PROJECTILE_FRAGILE_REFERENCE_IMPACT_ENERGY_J = 0.37;
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
