/**
 * B 軸資產 schema 版本邏輯核——loadout 閘（unusable 拒）／降版目標（per-type
 * 最低非破壞相容類最高版、略過 yanked）／動態最低支援版推導（不同創作者跨牆數
 * ≥ 門檻、單調 ratchet）／開賽前驗證（提示一＝降版、提示二＝schema 差異）。
 * ⭐破壞牆表與 yank 清單＝client 隨 major 出貨的共識輸入（A 軸硬閘保同 major
 * 同表＝決定性）；動態 min 對 room pinned 檢查點的 DerivedState 算。
 * v1 紀元現況：無破壞牆、全資產 schema v1——本檔為可測邏輯核，
 * AssetVersionUpgradeEvent 收件六條與 reducer 隨首道破壞牆（遷移描述子 CI）落地。
 */
import { Protocol } from '@open4wd/system-constants';
import type { AssetTypeKey, AssetVersionDerivedState } from '../ledger/derived-state';

/** per-type 破壞牆版本序列（遞增；牆 V＝「< V 與 ≥ V 不相容」）；v1 紀元＝全空 */
export type BreakingWalls = ReadonlyMap<AssetTypeKey, readonly number[]>;
/** 壞版標記（不能當新建／降版目標）；client 清單、不進 DerivedState */
export type YankedVersions = ReadonlyMap<AssetTypeKey, ReadonlySet<number>>;

/** 尚未定義破壞牆時使用的空集合。 */
export const EMPTY_WALLS: BreakingWalls = new Map();
/** 尚未撤回任何版本時使用的空集合。 */
export const EMPTY_YANKED: YankedVersions = new Map();

/** 驗證房間釘選 checkpoint 未來自未來且帳齡不超過 protocol 上限。 */
export function isPinnedCheckpointFresh(timestamp: number, now: number): boolean {
  if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(now) || timestamp > now)
    return false;
  return now - timestamp <= Protocol.ledger.ROOM_PINNED_CHECKPOINT_MAX_AGE_HOURS * 60 * 60 * 1000;
}

/** ref → B 軸 schema 版本（builtin:*／local:* 不經 B 軸＝null；未知 UGC＝null 由呼叫端裁） */
export type AssetVersionResolver = (ref: string) => number | null;

/** 版本所屬相容類＝其上最近一道牆之上的區段索引（同區段＝非破壞互通） */
function compatClassOf(version: number, walls: readonly number[]): number {
  let index = 0;
  for (const wall of walls) if (version >= wall) index++;
  return index;
}

/**
 * 降版目標（per-type）：全場該 type 版本中「最低相容類」內的最高**非 yanked**版；
 * min 落在 yanked＝往下取最近非 yanked 鄰版（防全 type 無版可用死角）。
 * 全同相容類＝null（無需降版）。
 */
export function downgradeTargetFor(
  versions: readonly number[],
  walls: readonly number[],
  yanked: ReadonlySet<number> = new Set(),
): number | null {
  if (versions.length === 0) return null;
  const classes = versions.map((version) => compatClassOf(version, walls));
  const lowest = Math.min(...classes);
  if (classes.every((cls) => cls === lowest)) return null;
  const candidates = versions
    .filter((_, index) => classes[index] === lowest)
    .filter((version) => !yanked.has(version));
  if (candidates.length > 0) return Math.max(...candidates);
  // 最低相容類全 yanked：往下走最近非 yanked 版（線性掃描、版本為小整數域）
  let probe = Math.min(...versions.filter((_, index) => classes[index] === lowest)) - 1;
  while (probe >= 1) {
    if (!yanked.has(probe)) return probe;
    probe--;
  }
  return null;
}

/**
 * 動態最低支援版推導（純函式）：對每道牆 V——「從 < V 升到 ≥ V」的不同創作者
 * 數 ≥ DEPRECATED_TO_UNUSABLE_THRESHOLD → min 抬到 V；取滿足的最高 V；與既有
 * min 取 max（單調 ratchet）。crossings＝(creator, fromVersion, toVersion) 上鏈
 * 後繼邊集（AssetVersionUpgradeEvent 衍生；v1 紀元恆空）。
 */
export function deriveMinSupported(
  crossings: readonly { creator: string; fromVersion: number; toVersion: number }[],
  walls: readonly number[],
  currentMin: number,
): number {
  let min = currentMin;
  for (const wall of walls) {
    const creators = new Set(
      crossings
        .filter((edge) => edge.fromVersion < wall && edge.toVersion >= wall)
        .map((edge) => edge.creator),
    );
    if (creators.size >= Protocol.ugc.DEPRECATED_TO_UNUSABLE_THRESHOLD && wall > min) min = wall;
  }
  return min;
}

/** matchmaking LoadoutValidationDeps.validateAssetVersions 埠形 */
export type AssetVersionGate = (
  refs: readonly string[],
  pinnedCheckpointCid: string,
) => { ok: boolean; reason?: string };

/**
 * loadout 閘工廠：版本 < 動態 min＝unusable 拒（進房擋下）；builtin/local／
 * 未知版本（真 GLB 未載）放行——B 軸只擋「確定 unusable」、載入層降版另行套用。
 * minByType 對 room pinned 檢查點的 state 取（呼叫端以 deriveStateAt 供給）。
 */
export function makeAssetVersionGate(
  minByTypeOf: (pinnedCheckpointCid: string) => AssetVersionDerivedState['minSupportedByType'],
  versionOf: AssetVersionResolver,
  typeOf: (ref: string) => AssetTypeKey | null,
): AssetVersionGate {
  return (refs, pinnedCheckpointCid) => {
    const minByType = minByTypeOf(pinnedCheckpointCid);
    for (const ref of refs) {
      if (ref.startsWith('builtin:') || ref.startsWith('local:')) continue;
      const version = versionOf(ref);
      const type = typeOf(ref);
      if (version === null || type === null) continue;
      const min = minByType.get(type) ?? 1;
      if (version < min) return { ok: false, reason: `asset-version-unusable:${ref}` };
    }
    return { ok: true };
  };
}

/** 開賽前資產版本檢查結果，區分硬性拒絕與可提示的降版／漂移。 */
export interface PreRaceVersionReport {
  ok: boolean;
  /** 提示一：需降版的 type → 目標版（真的改變物理、強提示） */
  downgradeByType: ReadonlyMap<AssetTypeKey, number>;
  /** 提示二：混非破壞舊版的 type（老資產吃新欄位預設、軟提示） */
  schemaDriftTypes: readonly AssetTypeKey[];
  /** unusable refs（開賽擋下） */
  unusable: readonly string[];
}

/**
 * 開賽前驗證（preRaceVersionCheck 擴充）：對 pinned 檢查點的動態 min 驗
 * 全 loadout 資產＋算 per-type 降版目標＋出兩種提示。
 */
export function preRaceVersionCheck(
  refs: readonly string[],
  minByType: AssetVersionDerivedState['minSupportedByType'],
  versionOf: AssetVersionResolver,
  typeOf: (ref: string) => AssetTypeKey | null,
  walls: BreakingWalls = EMPTY_WALLS,
  yanked: YankedVersions = EMPTY_YANKED,
): PreRaceVersionReport {
  const versionsByType = new Map<AssetTypeKey, number[]>();
  const unusable: string[] = [];
  for (const ref of refs) {
    if (ref.startsWith('builtin:') || ref.startsWith('local:')) continue;
    const version = versionOf(ref);
    const type = typeOf(ref);
    if (version === null || type === null) continue;
    if (version < (minByType.get(type) ?? 1)) {
      unusable.push(ref);
      continue;
    }
    const list = versionsByType.get(type) ?? [];
    list.push(version);
    versionsByType.set(type, list);
  }
  const downgradeByType = new Map<AssetTypeKey, number>();
  const schemaDriftTypes: AssetTypeKey[] = [];
  for (const [type, versions] of versionsByType) {
    const typeWalls = walls.get(type) ?? [];
    const target = downgradeTargetFor(versions, typeWalls, yanked.get(type) ?? new Set());
    if (target !== null) downgradeByType.set(type, target);
    else if (new Set(versions).size > 1) schemaDriftTypes.push(type);
  }
  return { ok: unusable.length === 0, downgradeByType, schemaDriftTypes, unusable };
}
