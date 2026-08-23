/**
 * VehicleLoadout — 整車組合引用（零件一律以鏈上 CID 或公版 builtin ID 引用）
 */
import { isBuiltin, type BuiltinId, type PartRef } from './builtin-ids';
import type { PartType } from '@open4wd/interfaces';

/** 輪胎與導輪在 chassis 上的 canonical 位置順序。 */
export const TIRE_POSITIONS = ['FL', 'FR', 'RL', 'RR'] as const;
export const ROLLER_POSITIONS = ['FL', 'FR', 'CL', 'CR', 'RL', 'RR'] as const;

/** 四顆輪胎可使用的位置 id。 */
export type TirePosition = (typeof TIRE_POSITIONS)[number];
/** 六顆可選導輪可使用的位置 id。 */
export type RollerPosition = (typeof ROLLER_POSITIONS)[number];

/** 一輛車的必要與可選零件引用集合。 */
export interface VehicleLoadout {
  chassis: PartRef;
  body: PartRef;
  motor: PartRef;
  battery: PartRef;
  /** 四個 canonical 位置恰各一顆，可使用不同零件 */
  tires: Readonly<Record<TirePosition, PartRef>>;
  /** 六個位置各自可選；未安裝的位置省略 */
  rollers: Readonly<Partial<Record<RollerPosition, PartRef>>>;
  chip?: PartRef;
  weapon?: PartRef;
  /** 僅 passive 武器可帶（0–100、預設 50）：被動加持的減重↔抗性分配 */
  passiveWeightSplitPct?: number;
}

/** 展平後帶位置、零件種類與資產引用的 loadout 槽位。 */
export interface LoadoutSlotRef {
  slot: string;
  type: PartType;
  ref: PartRef;
}

/** loadout 位置化展開；順序固定，供驗證、顯示組裝與引用收集共用。 */
export function loadoutSlots(loadout: VehicleLoadout): readonly LoadoutSlotRef[] {
  const slots: LoadoutSlotRef[] = [
    { slot: 'chassis', type: 'chassis', ref: loadout.chassis },
    { slot: 'body', type: 'body', ref: loadout.body },
    { slot: 'motor', type: 'motor', ref: loadout.motor },
    { slot: 'battery', type: 'battery', ref: loadout.battery },
    ...TIRE_POSITIONS.map((position) => ({
      slot: `tire:${position}`,
      type: 'tire' as const,
      ref: loadout.tires[position],
    })),
  ];
  for (const position of ROLLER_POSITIONS) {
    const ref = loadout.rollers[position];
    if (ref !== undefined) slots.push({ slot: `roller:${position}`, type: 'roller', ref });
  }
  if (loadout.chip !== undefined) slots.push({ slot: 'chip', type: 'chip', ref: loadout.chip });
  if (loadout.weapon !== undefined)
    slots.push({ slot: 'weapon', type: 'weapon', ref: loadout.weapon });
  return slots;
}

/** loadout 內全部零件引用（含可選 weapon；順序固定＝欄位序） */
export function loadoutRefs(loadout: VehicleLoadout): readonly PartRef[] {
  return loadoutSlots(loadout).map(({ ref }) => ref);
}

/** loadout 內引用到的公版 ID（economy 跳過鑄幣／fork 拒收等過濾用） */
export function builtinRefsIn(loadout: VehicleLoadout): readonly BuiltinId[] {
  return loadoutRefs(loadout).filter((ref): ref is BuiltinId => isBuiltin(ref));
}
