/**
 * 公版零件名錄——builtin:* 命名空間下 24 零件的 id／type／archetype 登錄。
 * ⭐物理值不在此：公版與 UGC 相同，於編輯器 author、烘焙進各公版 GLB root
 * extras（載入層讀烘焙值）；結構／參數不變式＝編輯器上傳驗證（同 UGC）。
 * 差異僅發佈管道：公版隨 client 出貨、不上鏈。
 */
import type { PartType } from '../material-params';
import type { BuiltinAssetEntry, PartArchetype } from './builtin-ids';

/** 公版零件名錄中帶有零件類型與玩法取向的項目。 */
export interface BuiltinPartDef extends BuiltinAssetEntry {
  readonly type: PartType;
  readonly archetype: PartArchetype;
}

const part = (
  id: `builtin:${string}`,
  type: PartType,
  archetype: PartArchetype,
): BuiltinPartDef => ({ id, type, archetype, deprecated: false });

/** 隨 client 出貨且 id 永久保留的公版零件名錄。 */
export const BUILTIN_PARTS: readonly BuiltinPartDef[] = Object.freeze([
  // chassis：speed 輕量低 mass／heavy 重型／control 平衡
  part('builtin:chassis-01', 'chassis', 'speed'),
  part('builtin:chassis-02', 'chassis', 'heavy'),
  part('builtin:chassis-03', 'chassis', 'control'),
  // body：speed 流線低 drag／heavy 重裝甲／control 通用
  part('builtin:body-01', 'body', 'speed'),
  part('builtin:body-02', 'body', 'heavy'),
  part('builtin:body-03', 'body', 'control'),
  // tire：speed 光面軟胎／heavy 越野硬胎／control 通用
  part('builtin:tire-01', 'tire', 'speed'),
  part('builtin:tire-02', 'tire', 'heavy'),
  part('builtin:tire-03', 'tire', 'control'),
  // motor：speed 偏速／heavy 偏扭矩／control 均衡
  part('builtin:motor-01', 'motor', 'speed'),
  part('builtin:motor-02', 'motor', 'heavy'),
  part('builtin:motor-03', 'motor', 'control'),
  // battery：speed 高輸出／heavy 大容量／control 平衡
  part('builtin:battery-01', 'battery', 'speed'),
  part('builtin:battery-02', 'battery', 'heavy'),
  part('builtin:battery-03', 'battery', 'control'),
  // roller：speed 小低摩擦／heavy 大中摩擦／control 中
  part('builtin:roller-01', 'roller', 'speed'),
  part('builtin:roller-02', 'roller', 'heavy'),
  part('builtin:roller-03', 'roller', 'control'),
  // chip：speed／heavy 3 槽、control 4 槽（槽配置烘進各公版 GLB）
  part('builtin:chip-01', 'chip', 'speed'),
  part('builtin:chip-02', 'chip', 'heavy'),
  part('builtin:chip-03', 'chip', 'control'),
  // weapon：speed 被動撞角／heavy 單轉子連旋／control 釘刺發射
  part('builtin:weapon-01', 'weapon', 'speed'),
  part('builtin:weapon-02', 'weapon', 'heavy'),
  part('builtin:weapon-03', 'weapon', 'control'),
]);
