/**
 * loadout 結構檢核（box 期可判子集）——車間［檢查］與賽前 loadout 提交共用
 * 單一實作（防「車間放行、賽前拒收」漂移）。零文案：findings 只回 code＋
 * params、UI 對映 i18n validation.*。mount 幾何對齊檢核待零件 GLB 定稿
 * （UGC extras 讀取）後納入。
 */
import { BUILTIN_PARTS, type BuiltinPartDef } from './parts';
import { isBuiltin } from './builtin-ids';
import { loadoutSlots, type VehicleLoadout } from './loadout';

/** 車輛組裝結構驗證的無文案 finding。 */
export interface LoadoutFinding {
  code: string;
  params?: Readonly<Record<string, string | number>>;
}

const BUILTIN_PART_BY_ID: ReadonlyMap<string, BuiltinPartDef> = new Map(
  BUILTIN_PARTS.map((part) => [part.id, part]),
);

/** 結構檢核：回 findings（空＝通過）。UGC ref 的型別／武器參數無從驗（GLB 期補） */
export function checkLoadoutStructure(loadout: VehicleLoadout): LoadoutFinding[] {
  const findings: LoadoutFinding[] = [];

  if (loadout.weapon !== undefined && loadout.chip === undefined)
    findings.push({ code: 'loadout-weapon-requires-chip' });

  // builtin ref 必須存在名錄且型別對位（打錯欄防）；UGC（CID）無從驗＝跳過
  for (const { type: slot, ref } of loadoutSlots(loadout)) {
    if (typeof ref !== 'string' || ref.length === 0) {
      findings.push({ code: 'loadout-missing-part', params: { slot } });
      continue;
    }
    if (!isBuiltin(ref)) continue;
    const def = BUILTIN_PART_BY_ID.get(ref);
    if (def === undefined) findings.push({ code: 'loadout-unknown-builtin', params: { ref } });
    else if (def.type !== slot)
      findings.push({
        code: 'loadout-part-type-mismatch',
        params: { ref, slot, actual: def.type },
      });
  }

  // passive 分配值：域 0–100；武器 passive 與否需 GLB extras 方知（同 UGC）＝
  // 有武器即不擋、無武器＝target 缺（passive-only 語意於 GLB 載入層補驗）
  const split = loadout.passiveWeightSplitPct;
  if (split !== undefined) {
    if (!Number.isInteger(split) || split < 0 || split > 100)
      findings.push({ code: 'loadout-passive-split-range', params: { value: split } });
    if (loadout.weapon === undefined) findings.push({ code: 'loadout-passive-split-target' });
  }
  return findings;
}

/** 賽前提交埠形 adapter（首個 finding code 作 reason） */
export function validateVehicleStructure(loadout: VehicleLoadout): {
  ok: boolean;
  reason?: string;
} {
  const findings = checkLoadoutStructure(loadout);
  return findings.length === 0 ? { ok: true } : { ok: false, reason: findings[0]!.code };
}
