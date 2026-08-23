/**
 * 材質使用規則 — 場景檢核（Stage 1 剃除／Stage 3 拒收共用判定）與編輯器 canonical 排序
 */
import type { MaterialDef, PartType } from './materials';
import { UI } from '@open4wd/system-constants';
import { MATERIALS } from './materials';

/** 材質允許規則所判定的資產使用範圍。 */
export type MaterialScope = 'vehicle' | 'environment';

/** 分類：無 vehicle 禁用＝零件與場地皆可；vehicle 禁用再依 is_fluid 分 fluid／environment-only */
export type MaterialClass = 'vehicle-friendly' | 'environment-only' | 'fluid';

/** 將材質硬規則投影成編輯器可呈現的分類。 */
export function materialClass(def: MaterialDef): MaterialClass {
  if (!def.forbidden_scopes?.includes('vehicle')) return 'vehicle-friendly';
  return def.is_fluid ? 'fluid' : 'environment-only';
}

/** 場景檢核：禁用 scope 內僅 vehicle 有零件類型白名單例外（is_fluid 不參與檢核） */
export function isMaterialAllowed(
  def: MaterialDef,
  scope: MaterialScope,
  partType?: PartType,
): boolean {
  if (!def.forbidden_scopes?.includes(scope)) return true;
  return (
    scope === 'vehicle' &&
    partType !== undefined &&
    (def.allowed_part_types?.includes(partType) ?? false)
  );
}

/**
 * 編輯器材質清單：過濾＋canonical 排序
 * 預設＝表格陣列序（跨 peer／跨語系一致）；display_order.<scope> 覆蓋（小到大）；禁 locale-aware 排序
 */
export function materialsForScope(
  scope: MaterialScope,
  partType?: PartType,
  source: readonly MaterialDef[] = MATERIALS,
  deprecatedMaterialIds: readonly string[] = UI.assetPolicy.DEPRECATED_MATERIAL_IDS,
): readonly MaterialDef[] {
  return source
    .map((def, index) => ({ def, index }))
    .filter(
      ({ def }) =>
        isMaterialAllowed(def, scope, partType) &&
        !UI.assetPolicy.isMaterialDeprecated(def.id, deprecatedMaterialIds),
    )
    .sort((a, b) => sortKey(a, scope) - sortKey(b, scope) || a.index - b.index)
    .map(({ def }) => def);
}

const sortKey = (entry: { def: MaterialDef; index: number }, scope: MaterialScope): number =>
  entry.def.display_order?.[scope] ?? entry.index;
