/**
 * builtin ID 型別 — 公版資產命名空間基座
 * ID 一旦發布即永久保留：移除只允許標 deprecated 隱藏、不可重指新內容（會破壞舊存檔）
 */
import type { CID } from '@open4wd/interfaces';
import type { PartType } from '../material-params';

/** 公版名錄可登錄的零件或場地種類。 */
export type BuiltinType = PartType | 'track';
/** 公版零件的三種玩法取向。 */
export type PartArchetype = 'speed' | 'heavy' | 'control';
/** 公版場地的三種玩法取向。 */
export type TrackArchetype = 'practice' | 'speed' | 'combat';

/** 永久保留於 builtin 命名空間的資產識別碼。 */
export type BuiltinId = `builtin:${string}`;
/** 具場地前綴的公版場地識別碼。 */
export type BuiltinTrackId = `builtin:track-${string}`;
/** 僅存在目前裝置的資產引用。 */
export type LocalAssetRef = `local:${string}`;

/** loadout 零件引用：鏈上 CID、公版 ID 或本機資產 ID */
export type PartRef = CID | BuiltinId | LocalAssetRef;
/** 可供本機測試選用的鏈上、公版或本機場地引用。 */
export type TrackRef = CID | BuiltinTrackId | LocalAssetRef;
/** 可供正式賽事選用、不含本機資產的場地引用。 */
export type FormalTrackRef = CID | BuiltinTrackId;

/** 判定零件引用是否位於公版命名空間。 */
export const isBuiltin = (ref: PartRef): ref is BuiltinId => ref.startsWith('builtin:');

/** 公版資產名錄共用的穩定身分與生命週期欄位。 */
export interface BuiltinAssetEntry {
  readonly id: BuiltinId;
  readonly type: BuiltinType;
  readonly archetype: PartArchetype | TrackArchetype;
  /** true＝編輯器隱藏但 ID 與檔案永久保留 */
  readonly deprecated: boolean;
}
