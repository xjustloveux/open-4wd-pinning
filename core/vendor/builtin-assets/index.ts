/**
 * builtin-assets — 公版資產：builtin:* 命名空間、ID 名錄、loadout 引用型別。
 * ⭐物理值不在此：公版＝UGC-in-GLB，烘焙進各公版 GLB extras、只差不上鏈。
 */
export {
  isBuiltin,
  type BuiltinAssetEntry,
  type BuiltinId,
  type BuiltinTrackId,
  type BuiltinType,
  type LocalAssetRef,
  type FormalTrackRef,
  type PartArchetype,
  type PartRef,
  type TrackArchetype,
  type TrackRef,
} from './builtin-ids';
export { BUILTIN_PARTS, type BuiltinPartDef } from './parts';
export { BUILTIN_TRACKS, type BuiltinTrackDef } from './tracks';
export {
  BUILTIN_ASSETS,
  BUILTIN_BY_ID,
  assertBuiltinInvariants,
  type BuiltinDef,
} from './registry';
export {
  ROLLER_POSITIONS,
  TIRE_POSITIONS,
  builtinRefsIn,
  loadoutRefs,
  loadoutSlots,
  type LoadoutSlotRef,
  type RollerPosition,
  type TirePosition,
  type VehicleLoadout,
} from './loadout';
export {
  checkLoadoutStructure,
  validateVehicleStructure,
  type LoadoutFinding,
} from './loadout-structure';
