/**
 * builtin 合併名錄 — 27 筆（8 類零件 × 3 變體＋3 場地）＋結構不變式
 * 變體編號慣例：01＝speed、02＝heavy、03＝control（場地：01＝practice、02＝speed、03＝combat）
 */
import type { PartType } from '../material-params';
import type { BuiltinAssetEntry, BuiltinId, BuiltinType, TrackArchetype } from './builtin-ids';
import { BUILTIN_PARTS, type BuiltinPartDef } from './parts';
import { BUILTIN_TRACKS, type BuiltinTrackDef } from './tracks';

/** 公版名錄中的零件或場地定義。 */
export type BuiltinDef = BuiltinPartDef | BuiltinTrackDef;

/** 經固定順序合併的完整公版資產名錄。 */
export const BUILTIN_ASSETS: readonly BuiltinDef[] = Object.freeze([
  ...BUILTIN_PARTS,
  ...BUILTIN_TRACKS,
]);

/** 依永久 builtin id 索引公版資產定義。 */
export const BUILTIN_BY_ID: ReadonlyMap<BuiltinId, BuiltinDef> = new Map(
  BUILTIN_ASSETS.map((entry) => [entry.id, entry]),
);

const PART_TYPES: readonly PartType[] = [
  'chassis',
  'body',
  'tire',
  'motor',
  'battery',
  'roller',
  'chip',
  'weapon',
];
const TRACK_ARCHETYPE_BY_SUFFIX: Readonly<Record<string, TrackArchetype>> = {
  '01': 'practice',
  '02': 'speed',
  '03': 'combat',
};

/** 結構不變式（載入即檢、違反即 throw）：格式／type 前綴一致／唯一／8 類各 3＋場地 3 */
export function assertBuiltinInvariants(entries: readonly BuiltinAssetEntry[]): void {
  const seen = new Set<string>();
  const countByType = new Map<BuiltinType, number>();
  for (const entry of entries) {
    const match = /^builtin:([a-z]+)-(\d{2})$/.exec(entry.id);
    if (!match) throw new Error(`builtin ${entry.id}: id 格式不符`);
    if (match[1] !== entry.type) throw new Error(`builtin ${entry.id}: id 前綴與 type 不一致`);
    if (seen.has(entry.id)) throw new Error(`builtin ${entry.id}: id 重複`);
    seen.add(entry.id);
    countByType.set(entry.type, (countByType.get(entry.type) ?? 0) + 1);

    if (entry.type === 'track') {
      if (TRACK_ARCHETYPE_BY_SUFFIX[match[2]!] !== entry.archetype)
        throw new Error(`builtin ${entry.id}: 場地 archetype 對映錯誤`);
    } else if (!['speed', 'heavy', 'control'].includes(entry.archetype)) {
      throw new Error(`builtin ${entry.id}: 零件 archetype 不合法`);
    }
  }
  for (const type of PART_TYPES)
    if (countByType.get(type) !== 3) throw new Error(`builtin 類 ${type}: 需恰 3 變體`);
  if (countByType.get('track') !== 3) throw new Error('builtin 場地: 需恰 3 個');
}

assertBuiltinInvariants(BUILTIN_ASSETS);
