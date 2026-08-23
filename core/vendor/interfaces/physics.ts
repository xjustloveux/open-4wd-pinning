/**
 * PhysicsEngine — 確定性物理引擎的可替換抽象（固定 60Hz、整數量化、跨 peer 一致）。
 * 所有 meshBytes 輸入（loadVehicle／loadTrack／computeMesh*）前提＝已通過 sanitize
 * 的可信 GLB；引擎不重跑完整消毒、僅做索引越界與非有限值的縱深檢查。
 */
import type { CID, PeerId, Result } from './shared';

/** 確定性世界載入、步進、快照、查詢與銷毀的引擎邊界。 */
export interface PhysicsEngine {
  readonly engineName: string;
  /** 物理引擎版本字串——影響 deterministic、同場全員必須一致 */
  readonly engineVersion: string;
  initWorld(config: PhysicsWorldConfig): Promise<Result<void>>;
  loadVehicle(vehicleSpec: VehicleSpec, startGrid?: StartGridPlacement): Result<VehicleId>;
  loadTrack(trackSpec: TrackSpec): Result<TrackId>;
  /** 推進一 frame（固定 60Hz） */
  step(inputs: readonly PlayerInput[]): StepOutput;
  /**
   * 建立可供 rollback/catch-up 使用的完整原子快照。
   * @returns SavedState v1 二進位封裝；包含 sim、破壞歸因、weather、track entity lifecycle、immutable world config 與 Rapier world。
   * @throws 當 JS metadata 與 Rapier topology 已不一致、無法形成可信快照時。
   */
  saveState(): SavedState;
  /**
   * side-effect-free 檢查完整快照 schema、immutable topology 並取出 frame。
   * @param state 待檢查的 SavedState v1 bytes。
   * @returns 驗證成功的 frame；任一 schema/topology/版本不符則回 null。
   */
  savedStateFrame(state: SavedState): number | null;
  /**
   * 原子還原完整快照；所有 schema/topology 檢查通過後才替換現有 world/sim。
   * @param state 已序列化的 SavedState v1 bytes。
   * @returns 無回傳值。
   * @throws 快照畸形、版本/設定/拓撲不符或 Rapier 無法還原時。
   */
  loadState(state: SavedState): void;
  /**
   * 取得該 peer 本回合已驗證的 chip 技能 schema。
   * @param peerId 回合 roster 內的 peer。
   * @returns 已綁定車輛的唯讀技能槽；無綁定則回 null。
   */
  inputSchemaForPeer(peerId: PeerId): readonly SkillSlot[] | null;
  /** 體積 m³；表面積 m²（熱模型散熱輸入） */
  computeMeshVolume(meshBytes: Uint8Array): Result<number>;
  computeMeshSurfaceArea(meshBytes: Uint8Array): Result<number>;
  /** mesh 幾何指紋（防複製比對用） */
  computeMeshFingerprint(meshBytes: Uint8Array): Result<MeshFingerprint>;
  /** 全世界狀態雜湊（desync 偵測用） */
  computeStateHash(): string;
  destroy(): void;
}

/** 建立單一賽事物理世界時不可變的規則設定。 */
export interface PhysicsWorldConfig {
  gravity: Vec3;
  /** 鎖死 60Hz（1/60 s 精確值）＋ substep 上限 4 */
  timestep: number;
  /** 本回合禁用晶片主動能力；被動武器幾何與材質仍保留。 */
  disallowChip?: boolean;
}
/** 依 X、Y、Z 順序排列的三維數值向量。 */
export type Vec3 = [number, number, number];

/** 正式賽由可驗算 proof 明確指定；省略僅供單車 local-test，絕不由載入序推導。 */
export interface StartGridPlacement {
  slot: number;
  playerCount: number;
}

// ── 載入型別 ──

/** 描述載入決定論世界所需的車體、零件、碰撞、質量與武器規格。 */
export interface VehicleSpec {
  vehicleId: VehicleId;
  parts: readonly PartInstance[];
  /** 套用組裝層被動武器加持後的整車有效質量；各 PartInstance 烘焙原值不變。 */
  totalMassGrams: number;
  /** motor 宣告與體積派生輸入功率上限（整數 mW） */
  motor: { torqueRatio: number; autoInputMw: number };
  /** battery 設定輸出（mW）與滿電能量（mJ） */
  battery: { configuredOutputMw: number; energyCapacityMj: number };
  /** chip 技能槽（Σ allocationPct ≤ 100） */
  chipSlots: readonly SkillSlot[];
  /** 武器（未裝＝省略）；passive＝純物理被動（仍占 chip weapon 槽、其 allocationPct＝加持總量） */
  weapon?: VehicleWeaponSpec;
  // 重心／慣量等組裝產物隨車輛組裝層收斂
}

/** 組裝車選用武器的玩法分支與烘焙物理描述。 */
export interface VehicleWeaponSpec {
  passive: boolean;
  /** active 必填 */
  branch?: WeaponBranch;
  /** passive 專屬：減重 vs 抗性分配（0–100、預設 50、組裝層） */
  passiveWeightSplitPct?: number;
  /** launch 滿彈數（真 mesh 時代自 GLB 子節點掃描；box 近似期由此宣告） */
  ammoCount?: number;
  /** Stage 3 bake 的作用中武器拓撲；runtime 不得推斷替代 sphere／box。 */
  physics?: WeaponPhysicsSpec;
}

/** 武器節點相對 vehicle root 的位置與四元數旋轉。 */
export interface WeaponPhysicsPose {
  readonly positionM: Vec3;
  readonly rotation: [number, number, number, number];
}

/** collider local 六向投影面積（m²）。 */
export interface DirectionalContactAreasM2 {
  readonly front: number;
  readonly back: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** 零件烘焙後單一 collider proxy 的來源、材質與質量。 */
export interface PartPhysicsProxy {
  readonly nodeName: string;
  readonly sourceNodeIndex: number;
  readonly material: MaterialId;
  readonly massGrams: number;
  /** 量化 sqrt(k × densityKgM3 × specificHeat)，已 bake 出共識路徑。 */
  readonly thermalExchangeFactor: number;
  /** 用於限制固體表面熱交換的確定性代理投影。 */
  readonly thermalContactAreaM2: number;
  /** collider local 六向投影面積；衝撞依量化接觸法線平滑加權。 */
  readonly contactAreasM2: DirectionalContactAreasM2;
  /** 僅輪胎接觸區域使用的磨耗容量；非輪胎代理不存在。 */
  readonly wearCapacityJ?: number;
  readonly centroidM: Vec3;
  readonly pointsM: readonly Vec3[];
}

/** 武器專用且綁定穩定 proxy id 的 collider proxy。 */
export type WeaponPhysicsProxy = Omit<
  PartPhysicsProxy,
  'sourceNodeIndex' | 'thermalExchangeFactor' | 'thermalContactAreaM2'
>;

/** 連接武器 proxy 與父剛體的烘焙 joint。 */
export interface WeaponPhysicsJoint {
  readonly fromNode: string;
  readonly toNode: string;
  readonly type: 'revolute' | 'spherical';
  readonly anchorM: Vec3;
  readonly axisM?: Vec3;
}

/** 驅動指定 joint 的轉角、速度權重與動作曲線。 */
export interface WeaponPhysicsActuator {
  readonly actuatorIndex: number;
  readonly pivotNode: string;
  readonly pivotPose: WeaponPhysicsPose;
  readonly axisM: Vec3;
  readonly maxAngleDeg: number;
  readonly speedWeight: number;
  readonly phaseOffsetDeg: number;
  readonly motionCurve: 'sin' | 'linear';
  readonly payload: readonly WeaponPhysicsProxy[];
  readonly joints: readonly WeaponPhysicsJoint[];
}

/** 發射武器可消耗 projectile proxy 與 muzzle pose。 */
export interface FluidProjectilePayload {
  /** Stage 3 對 projectile mesh 套用合法變換後重算的 canonical 體積。 */
  readonly volumeM3: number;
  readonly behavior: 'grip_loss' | 'sticky' | 'freeze' | 'burn' | 'corrosive';
  readonly params: Readonly<Record<string, number>>;
}

/** 發射武器可消耗 projectile proxy、muzzle pose 與可選 fluid 部署描述。 */
export interface WeaponPhysicsProjectile {
  readonly projectileIndex: number;
  readonly nodeName: string;
  readonly pose: WeaponPhysicsPose;
  readonly proxy: WeaponPhysicsProxy;
  /** projectile 初始位置沿 weapon Axis +Z 到 source-local LaunchExit 平面的量化距離。 */
  readonly exitDistanceUm: number;
  readonly fluidPayload?: FluidProjectilePayload;
}

/** active 武器完整的 proxy、joint、actuator 與 projectile 拓撲。 */
export interface WeaponPhysicsSpec {
  readonly version: 1;
  readonly axisPose: WeaponPhysicsPose;
  readonly fixedProxies: readonly WeaponPhysicsProxy[];
  readonly actuators: readonly WeaponPhysicsActuator[];
  readonly projectiles: readonly WeaponPhysicsProjectile[];
}

/** 零件類型（8 類；單一來源——material-params／builtin-assets 由此 re-export） */
export type PartType =
  'chassis' | 'body' | 'tire' | 'motor' | 'battery' | 'roller' | 'chip' | 'weapon';

/** 每回合 canonical 淘汰原因。 */
export type EliminationReason = 'vehicle-destroyed';

/** 只有 chassis 損壞會令整車退出物理；battery／motor 僅造成動力失能。 */
export const LETHAL_PART_TYPES: ReadonlySet<PartType> = new Set(['chassis']);

/** 任一致命零件損壞時回傳 canonical 淘汰原因。 */
export function checkElimination(
  parts: readonly { partType: PartType; broken: boolean }[],
): EliminationReason | null {
  return parts.some((part) => part.broken && LETHAL_PART_TYPES.has(part.partType))
    ? 'vehicle-destroyed'
    : null;
}

/** 零件損毀呈現用的版本化純視覺碎片；不得派生碰撞或傷害。 */
export interface PartVisualFragmentPlan {
  readonly version: 1;
  readonly method: 'cell_fracture' | 'voxel_fallback';
  readonly totalVolumeLossPct: number;
  readonly fragments: readonly {
    readonly fragmentIndex: number;
    readonly seedM: Vec3;
    readonly volumeM3: number;
  }[];
}

/** 組裝進 vehicle 的單一零件、掛點與烘焙物理資料。 */
export interface PartInstance {
  cid: CID;
  partType: PartType;
  /** 視覺／指紋用；⭐物理載入不從此重推幾何（改讀 bakedGeometry，跨 peer 決定性） */
  meshBytes: Uint8Array;
  /** 多材質宣告陣列（單材質寫成單元素）；鍵名 mesh_node 刻意鏡像 GLB extras wire 格式（snake_case）；場景合法性由材質自身的禁限規則自動檢核 */
  materials: readonly { mesh_node: string; material: MaterialId }[];
  /** 恰一筆 slot attachment；matrix＝chassisMount × inverse(partMount)，column-major SI rigid transform。 */
  mountTransforms: readonly MountTransform[];
  /** ⭐烘焙幾何（SI 浮點；共識量化只在 wire/checksum 邊界）：載入層自 GLB extras 供給，引擎據此建 box collider／質量／散熱，不重推 mesh */
  bakedGeometry: BakedPartGeometry;
  /** canonical manifest 烘焙的純視覺碎裂描述。 */
  visualFragments: PartVisualFragmentPlan;
  /** Stage 3 確定性凸拓撲；runtime 不得推斷 AABB 替代。 */
  physicsProxies: readonly PartPhysicsProxy[];
  /** tire／roller 專屬：完整 Mount frame 派生的 Revolute 與保守 cylinder 資料。 */
  hingePhysics?: PartHingePhysics;
  /** 僅 body 的六軸空氣力學 bake；軸與壓力中心為 body mesh 局部值。 */
  aero?: VehicleAeroSpec;
}

/** 車體單一空力軸的面積與阻力係數。 */
export interface VehicleAeroAxis {
  readonly dragAreaM2: number;
  readonly centerOfPressureM: Vec3;
}

/** 車體三軸空力與升力係數的烘焙摘要。 */
export interface VehicleAeroSpec {
  readonly positiveX: VehicleAeroAxis;
  readonly negativeX: VehicleAeroAxis;
  readonly positiveY: VehicleAeroAxis;
  readonly negativeY: VehicleAeroAxis;
  readonly positiveZ: VehicleAeroAxis;
  readonly negativeZ: VehicleAeroAxis;
  /** 正值順重力（下壓力）；負值逆重力（升力）。 */
  readonly liftFactor: number;
}

/** Mount-authoritative tire／roller 物理描述；外形與 AABB 軸序不具 axle 權威。 */
export interface PartHingePhysics {
  readonly anchorLocalM: Vec3;
  readonly axisLocal: Vec3;
  readonly centerLocalM: Vec3;
  readonly cylinderRotationLocal: [number, number, number, number];
  readonly halfHeightM: number;
  readonly radiusM: number;
  readonly driven: boolean;
}

/** 零件烘焙幾何（auto_* extras 的物理子集；race 載入時的唯一幾何來源） */
export interface BakedPartGeometry {
  /** AABB（m；box collider 與接觸面積來源） */
  aabbMinM: Vec3;
  aabbMaxM: Vec3;
  /** 實體體積（m³） */
  volumeM3: number;
  /** 表面積（m²；熱模型散熱輸入） */
  surfaceAreaM2: number;
  /** 質量（g；＝體積×材質密度的烘焙結果） */
  massGrams: number;
  /** 每材質區域 bake 的 Σ(massKg × specificHeatJPerKgC)。 */
  heatCapacityJPerC: number;
  /** 有上限材質導熱係數乘以真實暴露面積空氣導熱。 */
  ambientConductanceWPerC: number;
  /** 多材質 weakest non-null 過熱閾值；全 sub-mesh null 時為 null。 */
  thermalLimitC: number | null;
}
/** 物理世界內索引單一車輛的穩定 id。 */
export type VehicleId = string;
/** 物理世界內索引已載入場地的穩定 id。 */
export type TrackId = string;
/** 連接 collider 與 canonical 材質表的穩定 id。 */
export type MaterialId = string;
/** 一個 mount 相對父節點的位置與旋轉。 */
export interface MountTransform {
  /** canonical loadout slot（如 tire:FL）；chassis 使用 chassis。 */
  node: string;
  /** 16 元素 column-major rigid transform（公尺；禁止縮放／鏡射）。 */
  matrix: number[];
}

/** 載入物理世界所需的場地 bytes、路線、天候與 entity 描述。 */
export interface TrackSpec {
  trackId: TrackId;
  meshBytes: Uint8Array;
  /** admitted canonical GLB 烘焙的最窄可通行寬度；缺席或無效時不做賽前提示。 */
  narrowestPathM?: number;
  /** 已准入 TrackPhysicsManifest 的 digest；啟用天候 patch 時必填。 */
  manifestDigest?: string;
  /** 共識 seed context；啟用天候 patch 時必填。 */
  weatherSeed?: { readonly matchId: string; readonly roundIndex: number };
  /** 已准入具型別材質指派；`main` 是未列 mesh 節點的 fallback。 */
  materials?: readonly { meshNode: string; material: MaterialId }[];
  /** 場地設定（真 GLB 時代由 convert 自 extras 解析；box 近似期宣告制）；省略＝純幾何、無 route 追蹤 */
  config?: TrackConfig;
}

/** 場地圈數、邊界、重生與玩家容量的比賽設定。 */
export interface TrackConfig {
  /** open＝自由跑（無走廊）／fixed＝b-soft 走廊 */
  trackType: 'open' | 'fixed';
  lapMode: 'linear' | 'loop';
  /** RP1＝起點、RPn＝終點；陣列順序＝route 順序 */
  route: readonly RoutePoint[];
  /** 依序通過；world-axis-aligned trigger box（canon 尚未定義 rotation） */
  checkpoints?: readonly { positionM: Vec3; halfExtentsM: Vec3 }[];
  /** 掉出 fade in 落點與車頭朝向（無＝RP1／route 起點切線） */
  respawnPoints?: readonly TrackRespawnPoint[];
  killZones?: readonly { minM: Vec3; maxM: Vec3 }[];
  magnetSources?: readonly TrackMagnetSource[];
  weather?: TrackWeatherConfig;
  gravity?: { direction: Vec3; strengthMps2: number };
  /** 依穩定 entityIndex 排序的 canonical 場景 entity；僅無 entity 賽道缺少。 */
  entities?: TrackEntitySpec[];
}

/** 將場地表面曝露度量化到規則網格的烘焙資料。 */
export interface TrackWeatherExposureGrid {
  readonly resolution: number;
  readonly originM: readonly [number, number];
  readonly cellM: readonly [number, number];
  /** 與重力相反的單位向量；定義暴露表面平面法線。 */
  readonly up: Vec3;
  /** 沿 `up` 的 row-major 暴露頂面高度；null 表示沒有合格靜態 solid。 */
  readonly topM: readonly (number | null)[];
}

/** 一個場地天候區塊的形狀、強度與生命週期設定。 */
export interface TrackWeatherPatchConfig {
  readonly spawnRatePerMinuteX1000: number;
  readonly lifetimeFrames: number;
  readonly radiusM: number;
  readonly frictionModifier: number;
  readonly rollingModifier: number;
  readonly exposure: TrackWeatherExposureGrid;
}

/** 場地全域天候與局部 patch 的 deterministic 設定。 */
export interface TrackWeatherConfig {
  readonly type: 'normal' | 'rain' | 'snow';
  readonly temperatureC: number;
  /** 量化世界空間空氣速度，單位 m/s；零向量表示靜止空氣。 */
  readonly windVelocityMps: Vec3;
  /** 雨／雪時必填，一般天候禁止。 */
  readonly patch?: TrackWeatherPatchConfig;
}

/** 場地 entity 相對場地 root 的位置與旋轉。 */
export interface TrackEntityPose {
  positionM: Vec3;
  rotation: [number, number, number, number];
}

/** 場地 entity 的單一烘焙 collider proxy。 */
export interface TrackEntityColliderProxy {
  nodeName: string;
  material: MaterialId;
  /** entity／fragment 局部空間的凸代理點。 */
  pointsLocalM: Vec3[];
  /** collider local 六向投影面積；衝撞與 vehicle proxy 共用同式。 */
  contactAreasM2: DirectionalContactAreasM2;
}

/** 動態場地 entity 的質量與慣量摘要。 */
export interface TrackEntityMassProperties {
  massGrams: number;
  centerOfMassM: Vec3;
  principalInertiaKgM2: Vec3;
}

/** 運動場地 entity 的週期、幅度、速度與曲線。 */
export interface TrackEntityMotion {
  curve: MotionCurve;
  periodFrames: number;
  phaseOffsetFrames: number;
  translationAmplitudeM?: Vec3;
  rotationAxis?: Vec3;
  rotationAmplitudeDeg?: number;
  openDurationRatio?: number;
}

/** 場地 entity 可提供的磁源強度。 */
export interface TrackEntityMagnetSource {
  positionM: Vec3;
  strengthN: number;
  nPole: Vec3;
}

/** entity 破壞門檻與版本化純視覺碎片描述。 */
export interface TrackEntityDestructibleSpec {
  mass: TrackEntityMassProperties;
  visualFragments: PartVisualFragmentPlan;
}

/** 場地中一個可碰撞、運動、磁性或可破壞 entity。 */
export interface TrackEntitySpec {
  entityIndex: number;
  nodeName: string;
  entityType: EntityType;
  physics: 'default' | 'visual_only';
  initialPose: TrackEntityPose;
  visualNodes: string[];
  colliders: TrackEntityColliderProxy[];
  magnets: TrackEntityMagnetSource[];
  motion?: TrackEntityMotion;
  conveyor?: { velocityMps: number };
  destructible?: TrackEntityDestructibleSpec;
}

/** 場地提供的重生位置、旋轉與安全序位。 */
export interface TrackRespawnPoint {
  positionM: Vec3;
  /** RespawnPoint empty 的 world -Z；消費端正規化後使用 */
  forward: Vec3;
  /** RespawnPoint empty 的 world +Y；與 forward 組成完整落點座標框。 */
  up: Vec3;
}

/** 賽道中心線上的固定序位位置與通行寬度。 */
export interface RoutePoint {
  positionM: Vec3;
  /** 單位向量（該點切線方向） */
  forward: Vec3;
  /** 該點 authored surface normal（RoutePoint empty 的 world +Y）。 */
  up: Vec3;
  /** 車道全寬；b-soft 邊界＝spline 中心線 ± width/2 */
  widthM: number;
}

/** 場地靜態磁源（強度恆存；N 極＝宣告向量） */
export interface TrackMagnetSource {
  positionM: Vec3;
  strengthN: number;
  nPole: Vec3;
}

// ── Input 型別 ──

/** 描述單一物理幀的轉向、動力、煞車與技能輸入。 */
export interface PlayerInput {
  peerId: PeerId;
  frame: number;
  events: readonly InputEvent[];
}

/**
 * 玩家賽中唯一輸入＝技能觸發：迷你四驅車無轉向（滾輪貼牆自走）、橫向位移＝swerve 技能；
 * isHoldTick＝Hold 型按住期間每 dt 一 tick；強弱由該 slot 的 allocationPct 決定
 */
export interface SkillTriggerInput {
  type: 'skill-trigger';
  skillId: SkillId;
  isHoldTick: boolean;
}
/** 可進入物理步進的離散玩家事件；目前只有技能觸發。 */
export type InputEvent = SkillTriggerInput; // 目前唯一變體；保留 union 擴充位

/** 8 種 skill enum */
export type SkillId =
  'boost' | 'brake' | 'swerve_left' | 'swerve_right' | 'jump' | 'slam' | 'stabilize' | 'weapon';

/** chip 的 skill slot：種類＋輸出配置百分比（1–100 整數；整顆 chip 總和 ≤ 100） */
export interface SkillSlot {
  skill: SkillId;
  allocationPct: number;
}

/** 場地 entity 3 類 */
export type EntityType = 'decoration' | 'kinematic_move' | 'kinematic_conveyor';
/** kinematic_move 位移曲線 */
export type MotionCurve = 'sin' | 'step' | 'linear';

/** 武器分支（active weapon） */
export interface WeaponBranch {
  /** 主物件 mesh node（依 mechanism 解釋） */
  mainMeshNode: string;
  mechanism: 'magnet' | 'launch' | 'general';
  // magnet：無欄位（強度由 chip allocationPct 決定、N 極方向＝Axis empty +Z）
  // launch：無欄位（子彈＝mainMeshNode 子節點 mesh；落地行為由 bullet 材質決定）
  // general：actuators 有項＝general_actuated（每項一個驅動 pivot）、無＝general_push
  actuators?: WeaponActuator[]; // 數量上限＝MAX_WEAPON_DRIVEN_PIVOTS
}
/** runtime 已解析的武器致動器命令與當前相位。 */
export interface WeaponActuator {
  pivotNode: string;
  rotationAxis: [number, number, number];
  /** 1..360（360＝連旋、<360＝往返揮動） */
  maxAngleDeg: number;
  /** 預設 1；正規化權重（ωᵢ ∝ weight/Σ） */
  speedWeight?: number;
  /** 預設 0；相位偏移角度 0..360（與功率脫鉤、相對相位恆定） */
  phaseOffsetDeg?: number;
  motionCurve?: 'sin' | 'linear';
  /** payload A：剛體轉子 */
  meshNode?: string;
  /** payload B：Chain_Segment 節點名歸屬清單（鏈序依 GLB children） */
  chain?: string[];
}

// ── 輸出型別 ──

/** 描述決定論物理步完成後的車輛狀態、事件、傷害與呈現資料。 */
export interface StepOutput {
  frame: number;
  vehicleStates: ReadonlyMap<VehicleId, VehicleState>;
  collisions: readonly CollisionEvent[];
  /** 累計完賽集合（vehicleId 排序＝canonical、非名次）；首次出現的 frame＝完賽幀，名次由上層據此排 */
  finishedVehicles: readonly VehicleId[];
  /** 依 entityIndex 遞增排序的 canonical 賽道 entity 呈現／狀態。 */
  trackEntities?: readonly TrackEntityState[];
  /** 權威作用中 patch 描述；呈現層使用它們且絕不執行 RNG。 */
  weatherPatches?: readonly WeatherPatchDescriptor[];
}

/** step output 對外揭露的天候 patch 即時狀態。 */
export interface WeatherPatchDescriptor {
  readonly id: number;
  readonly type: 'rain' | 'snow';
  readonly pointM: Vec3;
  readonly normal: Vec3;
  readonly radiusM: number;
  readonly bornFrame: number;
  readonly expiresFrame: number;
  readonly frictionModifier: number;
  readonly rollingModifier: number;
}

/** 由 entity identity、breakFrame 與 descriptor 重建的純視覺碎片。 */
export interface TrackFragmentState {
  fragmentIndex: number;
  seed: number;
  seedM: readonly [number, number, number];
  volumeM3: number;
  ageMs: number;
  opacity: number;
}

/** 場地 entity 的即時姿態、速度與生命週期狀態。 */
export interface TrackEntityState {
  entityIndex: number;
  nodeName: string;
  position: Vec3;
  rotation: [number, number, number, number];
  fatigue: number;
  broken: boolean;
  breakFrame: number | null;
  fragments: readonly TrackFragmentState[];
}

/** 一輛車在指定 frame 的 deterministic 物理與玩法狀態。 */
export interface VehicleState {
  /** 世界座標（公尺）；整數量化屬 checksum／wire 層、不在此 */
  position: Vec3;
  /** 使用 quaternion。 */
  rotation: [number, number, number, number];
  velocity: Vec3;
  angularVelocity: Vec3;
  /** 呈現用有界作用中武器 body pose；節點名稱只來自 baked spec。 */
  weaponNodes?: readonly WeaponNodePose[];
  /** 每零件的疲勞、溫度與損壞狀態。 */
  parts: readonly PartState[];
  /** 0~100＝battery 剩餘／初始 × 100 */
  enduranceRemainingPct: number;
  /** 0~100＝目前線性可供輸出／configured output × 100。 */
  availableOutputPct: number;
  /** 目前可供輸出低於 motor auto input；實際是否失速仍由接觸物理決定。 */
  driveOutputLimited: boolean;
}

/** 武器可視節點在指定 frame 的世界姿態。 */
export interface WeaponNodePose {
  readonly nodeName: string;
  /** attached 為車輛根空間 body delta；fired 為絕對世界 body pose。 */
  readonly space: 'vehicle' | 'world';
  readonly position: Vec3;
  readonly rotation: [number, number, number, number];
  readonly fired: boolean;
}

/** fatigue／temperature／broken 為 sim state、跨 peer deterministic */
export interface PartState {
  partIndex: number;
  /** 0~1；衝撞／腐蝕／磨耗對稱累積（不可逆）；閾值 1.0、broken 後凍結 1.0 */
  fatigue: number;
  /** °C，per-part 即時（可逆） */
  temperature: number;
  /** 任一路徑達破壞：fatigue ≥ 1.0／一擊重傷／過熱超限 */
  broken: boolean;
  /** 首次破壞生效的權威 fixed frame；未破壞為 null。 */
  breakFrame: number | null;
}

/** 單一 frame 內兩個物理實體的量化碰撞摘要。 */
export interface CollisionEvent {
  a: VehicleId | TrackId;
  b: VehicleId | TrackId;
  /** 接觸點（公尺） */
  point: Vec3;
  /** 相對速率（m/s） */
  relativeSpeed: number;
}

/** 物理引擎序列化快照 */
export type SavedState = Uint8Array;

/** 防複製與 lineage 比對使用的幾何摘要。 */
export interface MeshFingerprint {
  /** 完整 SHA-256 */
  primary: string;
  features: {
    vertexCount: number;
    /** 量化整數 */
    volume: number;
    surfaceArea: number;
    aabb: [Vec3, Vec3];
    barycenter: Vec3;
  };
}
