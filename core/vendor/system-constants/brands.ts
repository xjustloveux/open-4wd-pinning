/**
 * Brand 型別 — 以編譯期名義型別區分 canonical SI 單位與量化識別符。
 */

// 版本欄位
export type ProtocolVersion = string & { __brand: 'ProtocolVersion' }; // 例如 "1.0.0"
/** 版本、量綱與加密字串使用的不可混用品牌型別群。 */
export type NetworkVersion = string & { __brand: 'NetworkVersion' };
/** 可獨立升版的 client shell 版本。 */
export type ClientVersion = string & { __brand: 'ClientVersion' };
/** 鏈上經濟設定快照的單調 epoch。 */
export type EconomyConfigEpoch = number & { __brand: 'EconomyConfigEpoch' };

// 量化單位
/** 以型別品牌標記公尺長度，防止與其他裸 number 單位混用。 */
export type Meter = number & { __brand: 'Meter' }; // 公尺（GLB/editor/runtime canonical world）
/** 以平方公尺表示的面積。 */
export type SquareMeter = number & { __brand: 'SquareMeter' };
/** 以立方公尺表示的體積。 */
export type CubicMeter = number & { __brand: 'CubicMeter' };
/** 以克表示且不可與一般 number 混用的質量。 */
export type Gram = number & { __brand: 'Gram' }; // 克
/** 乘上一千後保存的共識整數。 */
export type X1000 = number & { __brand: 'X1000' }; // ×1000 量化（如 GRAVITY_X1000）
/** 乘上一百後保存的共識整數。 */
export type X100 = number & { __brand: 'X100' }; // ×100 量化（如 ratingX100）
/** 經濟系統最小且不可分割的 bigint 單位。 */
export type MinorUnits = bigint & { __brand: 'MinorUnits' }; // 經濟最小單位（1 幣 = 100 minor）

// 識別符
/** 以型別品牌標記由公鑰衍生的節點識別字串。 */
export type PeerId = string & { __brand: 'PeerId' };
/** 內容尋址資料的不可混用識別碼。 */
export type CID = string & { __brand: 'CID' };
/** 已由簽章實作驗證格式的簽章 bytes。 */
export type Signature = Uint8Array & { __brand: 'Signature' };

// 一致性級別（protocol＝共識必須一致／network＝協商取小／ui＝純客戶端／economy-config＝鏈上治理）
/** 列舉資料讀取可要求的本機、已同步或已驗證一致性等級。 */
export type ConsistencyLevel = 'protocol' | 'network' | 'ui' | 'economy-config';

// 建構工具
/** 將已確認以公尺表示的數值標記為 Meter，不進行單位換算。 */
export const meters = (n: number): Meter => n as Meter;
/** 將已確認以平方公尺表示的數值標記為面積品牌型別。 */
export const squareMeters = (n: number): SquareMeter => n as SquareMeter;
/** 將已確認以立方公尺表示的數值標記為體積品牌型別。 */
export const cubicMeters = (n: number): CubicMeter => n as CubicMeter;
/** 將已確認以公克表示的數值標記為質量品牌型別。 */
export const grams = (n: number): Gram => n as Gram;
/** 將整數標記為千分比定點數，避免共識路徑使用浮點比例。 */
export const x1000 = (n: number): X1000 => n as X1000;
/** 將整數標記為百分之一單位定點數，避免金額或數值精度漂移。 */
export const x100 = (n: number): X100 => n as X100;
/** 將整數標記為貨幣最小單位，禁止與一般計數值混用。 */
export const minorUnits = (n: bigint): MinorUnits => n as MinorUnits;
/** 將整數標記為線路協議版本，供相容性與握手檢查。 */
export const protocolVersion = (s: string): ProtocolVersion => s as ProtocolVersion;
/** 將字串標記為客戶端版本識別，供最低版本政策比較。 */
export const clientVersion = (s: string): ClientVersion => s as ClientVersion;
/** 將整數標記為經濟設定世代，避免跨世代事件混算。 */
export const economyConfigEpoch = (n: number): EconomyConfigEpoch => n as EconomyConfigEpoch;
/** 將已驗證的字串標記為節點識別，不負責驗證公鑰格式。 */
export const peerId = (s: string): PeerId => s as PeerId;
/** 將已驗證的字串標記為內容識別碼，不重新編碼或正規化。 */
export const cid = (s: string): CID => s as CID;
/** 將位元資料標記為簽章內容，供驗章 API 限制輸入型別。 */
export const signature = (b: Uint8Array): Signature => b as Signature;
