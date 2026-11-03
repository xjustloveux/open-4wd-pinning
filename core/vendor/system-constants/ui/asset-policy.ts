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

/**
 * 自動減面每輪的外形誤差上限（網格半徑的比例）。達不到面數目標時寧可停在上一輪並回報，
 * 不以犧牲外形換取面數。
 */
export const PART_IMPORT_SIMPLIFY_ERROR_MAX = 0.005;

/**
 * 場地 region 分類（Stage 2 編輯器提示，不進 protocol 或 admission）：三角法線 |ny| 低於此值
 * 視為豎直（牆面）三角。0.5＝與水平面夾角大於 60°。
 */
export const TRACK_REGION_WALL_NORMAL_Y_MAX = 0.5;
/** 豎直三角占比不低於此值的 region 分類為牆。 */
export const TRACK_REGION_WALL_FRACTION_MIN = 0.9;
/** 豎直三角占比不高於此值的 region 分類為地；介於兩者之間為混合。 */
export const TRACK_REGION_GROUND_WALL_FRACTION_MAX = 0.1;
/**
 * 八車成本等級的下界：每顆 collider 平均三角數（region 三角數 ÷ 預估 piece 數）達此值為「中」、
 * 未達為「低」。依據：v15632 cpuprofile 剖析顯示八車賽中 CCD 成本隨每顆 collider 的三角數成長；
 * formal-v3-cost-001038 實測四場地由每個節點單顆改為 8 m 地面分塊（每顆平均 12–90 三角）後，
 * 八車 heavy 120 幀 step P95 由 256–2659 ms 降到 57–132 ms。2000／20000 兩個分級點是
 * 使用者裁決的提示刻度（決策見 D-20261021-01），非由實測擬合；只影響編輯器提示，不擋送出。
 */
export const TRACK_REGION_COST_MEDIUM_MIN_TRIANGLES_PER_PIECE = 2000;
/** 八車成本等級的上界：每顆 collider 平均三角數超過此值為「高」（依據同上）。 */
export const TRACK_REGION_COST_HIGH_ABOVE_TRIANGLES_PER_PIECE = 20_000;
