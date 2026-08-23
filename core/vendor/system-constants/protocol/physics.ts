/**
 * protocol/physics — 物理引擎常數（跨 peer 共識必須一致）
 */
import type { X1000 } from '../brands';

/** 固定步進、量化、求解器與賽事資源上限的物理共識常數群。 */
export const GRAVITY_X1000 = -9810 as X1000; // 重力加速度 -9.81 m/s²
export const FIXED_FRAMERATE_HZ = 60;
export const MAX_SUBSTEPS = 4;
/** 所有 gameplay dynamic body 固定啟用 hard CCD；不得依速度逐幀切換。 */
export const PHYSICS_HARD_CCD_ENABLED = true;
/** hard CCD 的每固定幀最大 TOI 子步數；初始校準值。 */
export const PHYSICS_CCD_MAX_SUBSTEPS = 2;
/** soft CCD 預測距離；0 明確停用 predictive constraints。 */
export const PHYSICS_SOFT_CCD_PREDICTION_M = 0;
/** projectile 完整 convex shape 越過 LaunchExit 平面後的額外離膛間隙。 */
export const PROJECTILE_EXIT_CLEARANCE_M = 0.001;
export const SOLVER_VELOCITY_ITERATIONS = 8;
export const INTEGER_SCALE = 1000; // 1mm 精度
export const MAX_RIGID_BODIES_PER_RACE = 512;
/** 以法向 impulse 為基礎的滾動阻力比例；初始 playtest 校準。 */
export const K_ROLLING_RESISTANCE = 0.0001;
/** 共識溫度保護範圍；所有執行期熱積分都限制於此範圍。 */
export const MIN_TEMPERATURE_C = -273.15;
export const MAX_TEMPERATURE_C = 5_000;
/** 環境對流基準乘以暴露面積與受限實體導熱係數。 */
export const K_THERMAL_AMBIENT_W_PER_M2_C = 80;
export const THERMAL_CONDUCTIVITY_FACTOR_CAP_W_PER_M_C = 50;
/** 烘焙材質熱感率、面積與法向 impulse 使用的接觸導熱校準。 */
export const K_THERMAL_CONTACT = 0.00002;
/** 測得輪胎／滾輪切向耗散中保留為零件熱量的比例。 */
export const K_THERMAL_SLIP = 1;
/** 達熱上限時的額外輪胎疲勞乘數（1 + 此值 × r²）。 */
export const K_TIRE_THERMAL_WEAR_MAX = 2;
/** 將輪胎材質區域體積 × 極限強度縮放為焦耳磨耗容量。 */
export const K_TIRE_WEAR_CAPACITY = 1;
/** 滑移耗散對輪胎的損害高於一般滾動耗散。 */
export const K_TIRE_SLIP_WEAR_MULTIPLIER = 4;
/** 低於共識毫米精度的接觸運動在磨耗計算中視為靜止。 */
export const MIN_TIRE_WEAR_SPEED_MPS = 0.001;
/** 0.5 × 代表空氣密度 × 彙總阻力係數。 */
export const K_AERO_DRAG = 0.6;
/** 將烘焙的無因次升力係數轉為相對水平阻力的力。 */
export const K_AERO_LIFT = 1;
/** 空氣動力不得讓車輛加速度超過此重力倍數。 */
export const K_AERO_MAX_WEIGHT_MULTIPLIER = 2;

// ── K 常數族（物理／武器係數；跨 peer 共識、歸 protocol 層）──
// 已有初估值者如下；全族待 playtest 校準
/** 定義酸性液體體積轉換為持續腐蝕傷害的係數。 */
export const K_ACID = 2.5; // 初估
/** 定義馬達每立方公尺可承受輸入功率的基準係數。 */
export const K_MOTOR_INPUT_W_M3 = 80_000_000; // W/m³，初估（行為等同原 80 W/cm³）
/** 定義電池每立方公尺可提供輸出功率的基準係數。 */
export const K_BATTERY_OUTPUT_W_M3 = 80_000_000; // W/m³，初估
/** 合成遊戲性能量密度；最終公開資產調整此常數，而非公式。 */
export const K_BATTERY_ENERGY_MJ_M3 = 90_000_000_000_000; // 單位 mJ/m³（90 GJ/m³）
export const K_STRESS_BURST_FACTOR = 1.5; // 初估
export const K_IMPACT_DEPTH_M = 0.001; // 初估；衝撞等效變形深度（stress 量綱閉合用）
/** 接觸法線分量的共識量化尺度（每單位刻度數）。 */
export const IMPACT_NORMAL_QUANTIZATION_PER_UNIT = 1_000_000;
/** 衝撞有效接觸面積的數值安全下限（m²）。 */
export const IMPACT_CONTACT_AREA_MIN_M2 = 0.00000001;
/** 接觸點位置／速度／有效質量中間量的共識量化尺度。 */
export const IMPACT_KINEMATICS_QUANTIZATION_PER_UNIT = 1_000_000;
/** collision-start 後重建已被 solver 分離之接觸點的最大相對位移 frame 裕量。 */
export const IMPACT_CONTACT_QUERY_MARGIN_FRAMES = 2;
/** manifold 法線與 pre-solver 相對速度近乎正交時，改採相對速度方向的門檻（m/s）。 */
export const IMPACT_NORMAL_MIN_CLOSING_MPS = 0.000001;
/** solver 切向耗散轉成 fatigue 能量的比例。 */
export const K_SHEAR_DAMAGE_TRANSFER = 0.1;
/** 排除靜止接觸與 solver 微抖的最小切向 slip（m/s）。 */
export const SHEAR_DAMAGE_MIN_SLIP_MPS = 0.1;
/** chassis admission 與損毀重算共用的 Rapier 數值安全下限。 */
export const CHASSIS_SOLVER_SAFETY_LIMITS = Object.freeze({
  massMinGrams: 1,
  principalInertiaMinKgM2: 1e-9,
});
export const K_PASSIVE_EFFECT_MAX_PCT = 30; // 初估；被動武器加持三因子公式的封頂係數
export const K_CHIP_SKILL_WASTE_HEAT = 0.001; // 電池成本 J → 晶片熱量 J
export const K_BATTERY_SKILL_WASTE_HEAT = 0.02; // 電池成本 J → 電池熱量 J
export const K_BATTERY_PASSIVE = 0.15; // 實際供能 W → battery heat W 的比例
export const K_MOTOR_HEAT = 0.2; // motor 實際輸入 W → heat W 的比例
export const K_TORQUE_FROM_W = 0.0002; // 公版最弱 speed 車可由靜止爬 7.38% 起跑坡
export const K_SPEED_FROM_W = 0.015; // 初估；m/s/W（speed 配置極速 ≈8.4 m/s）
export const K_BOOST = 0.00065; // 初估；N·s／effect J（滿威力 ≈+3 m/s）
export const K_BRAKE = 0.00065; // 初估
export const K_JUMP = 0.00065; // 初估（≈0.3m 跳高）
export const K_SLAM = 0.00065; // 初估
export const K_SWERVE = 0.0008; // 初估；Hold 持續側移 ≈1.5 m/s²
export const K_STABILIZE = 0.5; // 初估；Hold 角阻尼 ≈+3
export const K_MAGNET_FORCE = 0.03; // 初估；真實接觸摩擦下的持續場強係數
export const K_MAGNET_PERMEABILITY_M2 = 0.0008; // 初估；真實接觸摩擦下的 1/r² 尺度吸收（r＝m）
export const K_REACTION = 0.002; // 初估；真實接觸摩擦模型下的 Hold 後座校準
export const K_WEAPON_ROTOR_SPEED = 0.1; // 初估；滿配單轉子 ≈33 rad/s
/** fluid projectile 由體積換算地面覆蓋時的等效鋪展厚度（m，初估）。 */
export const FLUID_PROJECTILE_SPREAD_THICKNESS_M = 0.002;
/** fluid projectile 體積換面積的無因次鋪展係數（初估）。 */
export const FLUID_PROJECTILE_SPREAD_COEFFICIENT = 1;
/** 單枚 fluid projectile deploy zone 最小覆蓋面積（m²，初估）。 */
export const FLUID_PROJECTILE_AREA_MIN_M2 = 0.0001;
/** 單枚 fluid projectile deploy zone 最大覆蓋面積（m²，初估）。 */
export const FLUID_PROJECTILE_AREA_MAX_M2 = 0.25;
/** 圓形 deploy sensor 的總厚度（m，初估）。 */
export const FLUID_PROJECTILE_SENSOR_THICKNESS_M = 0.002;
/** 事件電池成本是 protocol 擁有的等效持續時間，絕非 UGC 欄位。 */
export const BOOST_COST_EQUIVALENT_FRAMES = 3_600;
export const BRAKE_COST_EQUIVALENT_FRAMES = 1_800;
export const JUMP_COST_EQUIVALENT_FRAMES = 3_600;
export const SLAM_COST_EQUIVALENT_FRAMES = 3_600;
