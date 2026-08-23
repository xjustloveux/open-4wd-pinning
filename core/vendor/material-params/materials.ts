/**
 * materials — 全 31 種材質的程式端執行 source of truth（規格對照鍵＝id、PR review 強制同步）
 * 陣列順序即 canonical 順序（UI 預設排序、跨 peer 一致）；不存 name／desc（i18n bundle 對 id 取字）
 * 載入時執行結構不變式檢查、違反即 throw（malformed 資料不得靜默通過）
 */
import type { MaterialId, PartType } from '@open4wd/interfaces';

/** 零件類型（材質白名單例外的對象；單一來源＝interfaces） */
export type { PartType } from '@open4wd/interfaces';

/** 單一材質的物理、熱學、磁性、使用範圍與 UI 排序定義。 */
export interface MaterialDef {
  readonly id: MaterialId;

  // 物理欄位
  readonly density: number; // 單位 g/cm³
  readonly yield_strength: number | null; // MPa；null＝強度極低、數學上跳過 fatigue
  readonly ultimate_strength: number | null; // MPa；同上
  readonly friction: number; // 0–3
  readonly restitution: number; // 0–1
  readonly thermal_conductivity: number | null; // W/(m·K)；null＝不參與熱傳合成
  readonly specific_heat: number | null; // J/(kg·K)；null＝同上
  readonly thermal_limit: number | null; // °C；null＝無有意義熔點
  readonly rolling_resistance: number; // 基準 1.0；所有材質必填（fallback 防護）

  // 磁性身分（三選一強制互斥；磁源強度由建模 Root Extras magnet_source_strength_n 決定）
  readonly magnetism_role: 'passive' | 'source' | 'none';
  readonly magnetic_susceptibility: number | null; // 0–1；僅 passive 有值、其餘必為 null

  // Fluid 特性（runtime 行為標識，不參與檢核）
  readonly is_fluid?: boolean;
  readonly deploy_behavior?: 'grip_loss' | 'sticky' | 'freeze' | 'burn' | 'corrosive';
  readonly deploy_params?: Readonly<Record<string, number>>;

  // 硬規則（Stage 1 剃除違規指派／Stage 3 拒收殘留）
  readonly forbidden_scopes?: readonly ('vehicle' | 'environment')[];
  readonly allowed_part_types?: readonly PartType[];

  // UI 排序覆蓋（軟提示、不影響共識）
  readonly display_order?: { readonly vehicle?: number; readonly environment?: number };
}

const MATERIAL_LIST: readonly MaterialDef[] = [
  // ── vehicle-friendly（14；零件與場地皆可）──
  // prettier-ignore
  { id: 'abs', density: 1.05, yield_strength: 40, ultimate_strength: 50, friction: 0.4, restitution: 0.4, thermal_conductivity: 0.17, specific_heat: 1300, thermal_limit: 80, rolling_resistance: 0.95, magnetism_role: 'none', magnetic_susceptibility: null },
  // prettier-ignore
  { id: 'pc', density: 1.2, yield_strength: 60, ultimate_strength: 70, friction: 0.42, restitution: 0.5, thermal_conductivity: 0.2, specific_heat: 1170, thermal_limit: 130, rolling_resistance: 0.95, magnetism_role: 'none', magnetic_susceptibility: null },
  // prettier-ignore
  { id: 'pe', density: 0.95, yield_strength: 25, ultimate_strength: 30, friction: 0.05, restitution: 0.45, thermal_conductivity: 0.42, specific_heat: 2300, thermal_limit: 100, rolling_resistance: 0.85, magnetism_role: 'none', magnetic_susceptibility: null },
  // prettier-ignore
  { id: 'wood', density: 0.7, yield_strength: 30, ultimate_strength: 50, friction: 0.55, restitution: 0.3, thermal_conductivity: 0.15, specific_heat: 1700, thermal_limit: 200, rolling_resistance: 1.0, magnetism_role: 'none', magnetic_susceptibility: null },
  // prettier-ignore
  { id: 'carbon', density: 1.55, yield_strength: 500, ultimate_strength: 600, friction: 0.45, restitution: 0.3, thermal_conductivity: 7, specific_heat: 850, thermal_limit: 1000, rolling_resistance: 0.9, magnetism_role: 'none', magnetic_susceptibility: null },
  // prettier-ignore
  { id: 'glass_fiber', density: 2.0, yield_strength: 200, ultimate_strength: 400, friction: 0.5, restitution: 0.25, thermal_conductivity: 0.4, specific_heat: 800, thermal_limit: 800, rolling_resistance: 0.9, magnetism_role: 'none', magnetic_susceptibility: null },
  // prettier-ignore
  { id: 'silicone', density: 1.05, yield_strength: 4, ultimate_strength: 20, friction: 0.95, restitution: 0.75, thermal_conductivity: 0.2, specific_heat: 1300, thermal_limit: 200, rolling_resistance: 1.1, magnetism_role: 'none', magnetic_susceptibility: null },
  // prettier-ignore
  { id: 'rubber', density: 1.1, yield_strength: 5, ultimate_strength: 25, friction: 1.2, restitution: 0.85, thermal_conductivity: 0.16, specific_heat: 1500, thermal_limit: 150, rolling_resistance: 1.2, magnetism_role: 'none', magnetic_susceptibility: null },
  // prettier-ignore
  { id: 'ceramic', density: 3.5, yield_strength: 100, ultimate_strength: 200, friction: 0.65, restitution: 0.1, thermal_conductivity: 30, specific_heat: 900, thermal_limit: 1500, rolling_resistance: 0.85, magnetism_role: 'none', magnetic_susceptibility: null },
  // prettier-ignore
  { id: 'magnesium', density: 1.8, yield_strength: 130, ultimate_strength: 220, friction: 0.5, restitution: 0.2, thermal_conductivity: 156, specific_heat: 1023, thermal_limit: 350, rolling_resistance: 0.9, magnetism_role: 'none', magnetic_susceptibility: null },
  // prettier-ignore
  { id: 'aluminum', density: 2.7, yield_strength: 90, ultimate_strength: 120, friction: 0.5, restitution: 0.2, thermal_conductivity: 237, specific_heat: 900, thermal_limit: 400, rolling_resistance: 0.9, magnetism_role: 'none', magnetic_susceptibility: null },
  // prettier-ignore
  { id: 'titanium', density: 4.5, yield_strength: 750, ultimate_strength: 880, friction: 0.55, restitution: 0.18, thermal_conductivity: 22, specific_heat: 522, thermal_limit: 1000, rolling_resistance: 0.9, magnetism_role: 'none', magnetic_susceptibility: null },
  // prettier-ignore
  { id: 'copper', density: 8.0, yield_strength: 70, ultimate_strength: 220, friction: 0.45, restitution: 0.1, thermal_conductivity: 401, specific_heat: 385, thermal_limit: 500, rolling_resistance: 0.85, magnetism_role: 'none', magnetic_susceptibility: null },
  // prettier-ignore
  { id: 'steel', density: 7.85, yield_strength: 250, ultimate_strength: 400, friction: 0.7, restitution: 0.15, thermal_conductivity: 50, specific_heat: 460, thermal_limit: 800, rolling_resistance: 0.95, magnetism_role: 'passive', magnetic_susceptibility: 1.0 },

  // ── environment-only（12；地表＋場地特殊材質）──
  // prettier-ignore
  { id: 'asphalt', density: 2.4, yield_strength: 4, ultimate_strength: 6, friction: 0.85, restitution: 0.2, thermal_conductivity: 0.75, specific_heat: 920, thermal_limit: null, rolling_resistance: 1.0, magnetism_role: 'none', magnetic_susceptibility: null, forbidden_scopes: ['vehicle'] },
  // prettier-ignore
  { id: 'concrete', density: 2.4, yield_strength: 25, ultimate_strength: 35, friction: 0.75, restitution: 0.15, thermal_conductivity: 1.4, specific_heat: 880, thermal_limit: null, rolling_resistance: 1.0, magnetism_role: 'none', magnetic_susceptibility: null, forbidden_scopes: ['vehicle'] },
  // prettier-ignore
  { id: 'dirt', density: 1.5, yield_strength: null, ultimate_strength: null, friction: 0.7, restitution: 0.05, thermal_conductivity: 0.5, specific_heat: 800, thermal_limit: null, rolling_resistance: 1.3, magnetism_role: 'none', magnetic_susceptibility: null, forbidden_scopes: ['vehicle'] },
  // prettier-ignore
  { id: 'grass', density: 0.4, yield_strength: null, ultimate_strength: null, friction: 0.65, restitution: 0.1, thermal_conductivity: 0.1, specific_heat: 1500, thermal_limit: null, rolling_resistance: 1.2, magnetism_role: 'none', magnetic_susceptibility: null, forbidden_scopes: ['vehicle'] },
  // prettier-ignore
  { id: 'gravel', density: 1.8, yield_strength: null, ultimate_strength: null, friction: 0.7, restitution: 0.1, thermal_conductivity: 0.3, specific_heat: 800, thermal_limit: null, rolling_resistance: 1.4, magnetism_role: 'none', magnetic_susceptibility: null, forbidden_scopes: ['vehicle'] },
  // prettier-ignore
  { id: 'sand', density: 1.6, yield_strength: null, ultimate_strength: null, friction: 0.6, restitution: 0.05, thermal_conductivity: 0.3, specific_heat: 830, thermal_limit: null, rolling_resistance: 1.6, magnetism_role: 'none', magnetic_susceptibility: null, forbidden_scopes: ['vehicle'] },
  // prettier-ignore
  { id: 'mud', density: 1.7, yield_strength: null, ultimate_strength: null, friction: 0.55, restitution: 0.05, thermal_conductivity: 0.6, specific_heat: 1500, thermal_limit: null, rolling_resistance: 1.6, magnetism_role: 'none', magnetic_susceptibility: null, forbidden_scopes: ['vehicle'] },
  // prettier-ignore
  { id: 'snow', density: 0.3, yield_strength: null, ultimate_strength: null, friction: 0.3, restitution: 0.1, thermal_conductivity: 0.1, specific_heat: 2090, thermal_limit: null, rolling_resistance: 1.8, magnetism_role: 'none', magnetic_susceptibility: null, forbidden_scopes: ['vehicle'] },
  // prettier-ignore
  { id: 'ice_sheet', density: 0.92, yield_strength: null, ultimate_strength: null, friction: 0.1, restitution: 0.5, thermal_conductivity: 2.2, specific_heat: 2100, thermal_limit: null, rolling_resistance: 0.8, magnetism_role: 'none', magnetic_susceptibility: null, forbidden_scopes: ['vehicle'] },
  // prettier-ignore
  { id: 'moss', density: 0.5, yield_strength: null, ultimate_strength: null, friction: 0.4, restitution: 0.1, thermal_conductivity: 0.1, specific_heat: 1500, thermal_limit: null, rolling_resistance: 1.3, magnetism_role: 'none', magnetic_susceptibility: null, forbidden_scopes: ['vehicle'] },
  // prettier-ignore
  { id: 'water_surface', density: 1.0, yield_strength: null, ultimate_strength: null, friction: 0.3, restitution: 0.0, thermal_conductivity: 0.6, specific_heat: 4180, thermal_limit: null, rolling_resistance: 1.5, magnetism_role: 'none', magnetic_susceptibility: null, forbidden_scopes: ['vehicle'] },
  // 物理欄位鏡像 steel（磁化鋼地板）；thermal_limit 依環境慣例＝null、不在鏡像之列，且改 steel 不自動同步
  // prettier-ignore
  { id: 'magnet_floor', density: 7.85, yield_strength: 250, ultimate_strength: 400, friction: 0.7, restitution: 0.15, thermal_conductivity: 50, specific_heat: 460, thermal_limit: null, rolling_resistance: 1.0, magnetism_role: 'source', magnetic_susceptibility: null, forbidden_scopes: ['vehicle'] },

  // ── fluid（5；weapon 白名單＋場地可用；sensor mode、friction／restitution 僅 fallback，density 仍計質量）──
  // prettier-ignore
  { id: 'water', density: 1.0, yield_strength: null, ultimate_strength: null, friction: 0.1, restitution: 0.1, thermal_conductivity: null, specific_heat: null, thermal_limit: null, rolling_resistance: 1.0, magnetism_role: 'none', magnetic_susceptibility: null, is_fluid: true, deploy_behavior: 'grip_loss', deploy_params: { grip_modifier: 0.5 }, forbidden_scopes: ['vehicle'], allowed_part_types: ['weapon'] },
  // prettier-ignore
  { id: 'oil', density: 0.9, yield_strength: null, ultimate_strength: null, friction: 0.05, restitution: 0.05, thermal_conductivity: null, specific_heat: null, thermal_limit: null, rolling_resistance: 1.0, magnetism_role: 'none', magnetic_susceptibility: null, is_fluid: true, deploy_behavior: 'sticky', deploy_params: { grip_modifier: 0.3, velocity_decay_per_sec: 0.7 }, forbidden_scopes: ['vehicle'], allowed_part_types: ['weapon'] },
  // prettier-ignore
  { id: 'freezing_fluid', density: 0.8, yield_strength: null, ultimate_strength: null, friction: 0.05, restitution: 0.05, thermal_conductivity: null, specific_heat: null, thermal_limit: null, rolling_resistance: 1.0, magnetism_role: 'none', magnetic_susceptibility: null, is_fluid: true, deploy_behavior: 'freeze', deploy_params: { temperature_delta_per_sec: -20 }, forbidden_scopes: ['vehicle'], allowed_part_types: ['weapon'] },
  // prettier-ignore
  { id: 'lava', density: 2.5, yield_strength: null, ultimate_strength: null, friction: 0.2, restitution: 0.1, thermal_conductivity: null, specific_heat: null, thermal_limit: null, rolling_resistance: 1.0, magnetism_role: 'none', magnetic_susceptibility: null, is_fluid: true, deploy_behavior: 'burn', deploy_params: { temperature_delta_per_sec: 30 }, forbidden_scopes: ['vehicle'], allowed_part_types: ['weapon'] },
  // fatigue 由耐受度公式決定（K_ACID／ultimate），deploy_params 空物件
  // prettier-ignore
  { id: 'acid', density: 1.2, yield_strength: null, ultimate_strength: null, friction: 0.05, restitution: 0.05, thermal_conductivity: null, specific_heat: null, thermal_limit: null, rolling_resistance: 1.0, magnetism_role: 'none', magnetic_susceptibility: null, is_fluid: true, deploy_behavior: 'corrosive', deploy_params: {}, forbidden_scopes: ['vehicle'], allowed_part_types: ['weapon'] },
];

/** 通過載入期不變式驗證的 canonical 材質名錄。 */
export const MATERIALS: readonly MaterialDef[] = Object.freeze(MATERIAL_LIST);

/** 依穩定材質 id 索引 canonical 定義。 */
export const MATERIAL_BY_ID: ReadonlyMap<MaterialId, MaterialDef> = new Map(
  MATERIALS.map((def) => [def.id, def]),
);

/** 結構不變式（載入即檢、違反即 throw——fail-fast 防 malformed 資料靜默通過） */
export function assertMaterialInvariants(materials: readonly MaterialDef[]): void {
  const seen = new Set<string>();
  for (const def of materials) {
    if (seen.has(def.id)) throw new Error(`material ${def.id}: id 重複`);
    seen.add(def.id);

    if (def.magnetism_role === 'passive') {
      if (
        typeof def.magnetic_susceptibility !== 'number' ||
        def.magnetic_susceptibility < 0 ||
        def.magnetic_susceptibility > 1
      )
        throw new Error(`material ${def.id}: passive 需 0–1 磁化率`);
    } else if (def.magnetic_susceptibility !== null) {
      throw new Error(`material ${def.id}: 非 passive 的磁化率必為 null`);
    }

    if (def.is_fluid) {
      if (!def.deploy_behavior) throw new Error(`material ${def.id}: fluid 需 deploy_behavior`);
      if (!def.forbidden_scopes?.includes('vehicle'))
        throw new Error(`material ${def.id}: fluid 必為 vehicle-forbidden`);
    }

    if (!(def.density > 0)) throw new Error(`material ${def.id}: density 需 > 0`);
    if (def.friction < 0 || def.friction > 3)
      throw new Error(`material ${def.id}: friction 需 0–3`);
    if (def.restitution < 0 || def.restitution > 1)
      throw new Error(`material ${def.id}: restitution 需 0–1`);
    if (!(def.rolling_resistance > 0))
      throw new Error(`material ${def.id}: rolling_resistance 需 > 0`);
  }
}

assertMaterialInvariants(MATERIALS);
