/**
 * ui/asset-policy — 資產政策清單（純客戶端：僅上傳時驗證、零賽中足跡、不擋配對）
 * 廢止＝絕版品模型：既有上鏈資產照常載入與比賽、只擋新上鏈；
 * 清單變更＝client minor（本路徑地板為 patch、廢止 PR 依「清單資料」分類手動 minor）
 */

/** 已廢止材質 id 集合（動態增長；Stage 2 編輯器不可選、Stage 3 拒收新上鏈） */
export const DEPRECATED_MATERIAL_IDS: readonly string[] = Object.freeze([]);

/** 單一廢止判定；測試可注入非空清單，避免 production 空清單掩蓋未接線。 */
export function isMaterialDeprecated(
  id: string,
  source: readonly string[] = DEPRECATED_MATERIAL_IDS,
): boolean {
  return source.includes(id);
}

/** 無 marker 場地首次匯入的 client-only 尺寸 guidance；不進 protocol 共識。 */
export const TRACK_IMPORT_TARGET_M = 150;
export const TRACK_IMPORT_COMFORT_M = Object.freeze([120, 180]) as readonly [number, number];

/** 無 marker 零件首次匯入的 client-only 最長邊 guidance；不進 protocol 共識。 */
export const PART_IMPORT_TARGET_LONGEST_EDGE_M = Object.freeze({
  chassis: 0.13,
  body: 0.13,
  tire: 0.032,
  motor: 0.024,
  battery: 0.06,
  roller: 0.011,
  chip: 0.03,
  weapon: 0.06,
});

/** 自動減面預留 10% headroom，最終硬限制仍由 protocol validator 決定。 */
export const PART_IMPORT_GEOMETRY_TARGET = 90_000;
