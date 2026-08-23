/**
 * 公版場地名錄——builtin:track-* 的 id／archetype 登錄。
 * ⭐物理／路線結構不在此：公版場地＝UGC-in-GLB，track/weather/physics 區塊
 * 烘焙進各公版 GLB extras（載入層讀）、結構驗證＝編輯器上傳流程（同 UGC）。
 * 差異僅發佈管道：公版隨 client 出貨、不上鏈。
 */
import type { BuiltinAssetEntry, BuiltinTrackId, TrackArchetype } from './builtin-ids';

/** 公版場地名錄中帶有固定場地 id 與玩法取向的項目。 */
export interface BuiltinTrackDef extends BuiltinAssetEntry {
  readonly id: BuiltinTrackId;
  readonly type: 'track';
  readonly archetype: TrackArchetype;
}

/** 隨 client 出貨且 id 永久保留的公版場地名錄。 */
export const BUILTIN_TRACKS: readonly BuiltinTrackDef[] = Object.freeze([
  // practice：橢圓／直線、3–5 checkpoint
  { id: 'builtin:track-01', type: 'track', archetype: 'practice', deprecated: false },
  // speed：中長競速、6–10 checkpoint
  { id: 'builtin:track-02', type: 'track', archetype: 'speed', deprecated: false },
  // combat：多障礙、5–8 checkpoint
  { id: 'builtin:track-03', type: 'track', archetype: 'combat', deprecated: false },
]);
