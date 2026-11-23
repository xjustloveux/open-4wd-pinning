/**
 * pin／unpin 請求的簽章驗證與重放防護。
 *
 * 驗證序：envelope 結構 → payload 的 type 域（pin／unpin 各自欄位形）→ ±30s 時戳容忍窗 →
 * nonce 唯讀初篩（NonceCache.has，擋明顯重放）→ Ed25519 簽章 → 簽章驗證通過後才收錄 nonce
 * （NonceCache.add）。先驗證、後收錄的順序刻意如此：若在驗章前就把 nonce 寫入快取，未驗證輸入
 * 就能無限灌大快取，且攻擊者能搶先用受害者的 (signer, nonce) 配亂簽章佔位，害受害者自己稍後
 * 送出的合法同 nonce 訊息被誤判重放而拒收。簽章訊息＝sha256(dagCbor({ nonce, payload, signer,
 * timestamp }))，直接呼叫 vendored 驗章函式（其內部即用同一顆訊息組裝函式重建待驗訊息）——本檔
 * 不自行重組訊息 bytes，避免與簽署端出現位元組不一致的風險。
 *
 * `body` 是已結構化解碼過的值（`nonce`／`signature` 已是 Uint8Array）；HTTP wire 層的位元組
 * 編解碼（例如十六進位字串轉 bytes）由呼叫端在交給本函式之前完成，不在此模組範圍內。
 */
import type { PeerId, PinRequestCategory, Signature } from '../core';
import { PIN_REQUEST_CATEGORIES, Protocol, verifySignedPayload } from '../core';

/** ms；±30s 容忍窗，衍生自協定常數（不另立字面量） */
const TOLERANCE_MS = Protocol.security.P2P_MESSAGE_TIMESTAMP_TOLERANCE_SEC * 1000;

/** ms；nonce 快取 TTL——理由見 NonceCache 類別註解 */
const NONCE_CACHE_TTL_MS = TOLERANCE_MS * 2;

/** 定義准入內容 DAG 的簽署請求內容。 */
export interface PinPayload {
  readonly type: 'pinning-pin';
  readonly cid: string;
  readonly category: PinRequestCategory;
  readonly sizeHintBytes: number;
}

/** 定義移除內容 DAG 的簽署請求內容。 */
export interface UnpinPayload {
  readonly type: 'pinning-unpin';
  readonly cid: string;
}

/** 列舉 Pinning 授權邊界接受的簽署操作。 */
export type PinRequestPayload = PinPayload | UnpinPayload;

/** 回傳已驗證簽署者與內容，或刻意不透明的簽章失敗。 */
export type VerifyResult =
  | { readonly ok: true; readonly signer: string; readonly payload: PinRequestPayload }
  | { readonly ok: false; readonly code: 'SIG_INVALID' };

/**
 * nonce 重放快取：記錄 (signer, nonce) 配對，過 TTL 自動剪枝；容量滿載時 fail-closed。
 *
 * 以 signer 與 nonce 一起當 key——不同 signer 各自獨立計數，同一組 nonce bytes 被兩個不同
 * 身分使用不視為重放（重放的定義是「同一身分重送同一則已驗證過的訊息」，不是「nonce 值本身
 * 全域唯一」）。
 *
 * TTL 取 2 倍容忍窗、而非 1 倍：本類別沒有獨立牆鐘來源，查詢／收錄唯一能取得的時間依據是呼叫端
 * 傳入、且已通過 ±30s 檢查的訊息時戳——拿它當「目前時間」的替代值，本身就帶最多一個容忍窗寬度的
 * 誤差。若剪枝只留一倍容忍窗寬度，可能在合法重放判定窗口還沒完全過去前就把記錄提前清掉；多留
 * 一倍，確保任何落在合法時戳窗內的重放都還查得到、不會因為剪枝時機而漏防。
 *
 * 查詢（has）與收錄（add）故意拆成兩個方法、不合併成單一「查了就記」的方法：呼叫端必須先以
 * has() 做便宜的重放初篩，但只能在該訊息的簽章驗證通過「之後」才呼叫 add() 真正收錄。若收錄
 * 動作綁在查詢當下（未驗證輸入即寫入），會有兩個後果——一是任何人送一堆隨機 (signer, nonce)
 * 就能無限灌大快取（未驗證輸入造成的記憶體放大，且無容量硬頂就無法擋）；二是攻擊者可搶先用
 * 受害者的 (signer, nonce) 配亂簽章送一筆，佔位後受害者自己稍後送出的合法同 nonce 訊息就會
 * 被誤判重放而拒收（targeted replay-DoS）。has／add 分離讓「佔用快取名額」這件事只發生在
 * 訊息通過完整驗證之後。
 *
 * 容量硬頂（maxEntries，預設協定常數）滿載時新項目直接拒收（fail-closed）、不逐出任何既有
 * 項目——寧可讓超量的新請求失敗，也不犧牲既有有效項目的 replay 保護。
 */
export class NonceCache {
  /** 保存每組已驗證簽署者與 nonce 的到期時間。 */
  readonly #entries = new Map<string, number>();
  /** 限制有效重放紀錄數，避免不受信任流量無界擴張記憶體。 */
  readonly #maxEntries: number;

  /**
   * @param maxEntries 未過期項目數的硬上限；省略則取協定常數。到達上限後 add() fail-closed。
   * @throws maxEntries 不是正整數時拋出 RangeError。
   */
  constructor(maxEntries: number = Protocol.security.P2P_NONCE_SET_MAX_ENTRIES) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive integer');
    }
    this.#maxEntries = maxEntries;
  }

  /**
   * 唯讀查詢 (signer, nonce) 是否仍在快取內（觸發 TTL 剪枝，但不寫入任何記錄）。
   *
   * 呼叫端應在簽章驗證「之前」呼叫本方法做便宜的重放初篩——查到 true 即可提早拒收，省下一次
   * Ed25519 驗證運算；查到 false 只代表尚未見過這對 (signer, nonce)，不代表訊息本身合法，仍
   * 必須完成型別與簽章的完整驗證。
   *
   * @param signer 簽署者識別字串。
   * @param nonce 訊息 nonce bytes。
   * @param now 剪枝的時間基準——使用呼叫端已通過 ±30s 檢查的訊息時戳。
   * @returns 這對 (signer, nonce) 目前仍在快取內（先前收錄過且未過期）為 true。
   */
  has(signer: string, nonce: Uint8Array, now: number): boolean {
    this.#prune(now);
    return this.#entries.has(signer + ':' + toHex(nonce));
  }

  /**
   * 收錄一筆 (signer, nonce)。呼叫端必須只在該訊息完整通過簽章驗證「之後」才呼叫本方法——
   * 提早呼叫（驗證前）會讓未驗證輸入佔用快取容量，理由見類別註解。
   *
   * @param signer 簽署者識別字串。
   * @param nonce 訊息 nonce bytes。
   * @param timestamp 該訊息自身的時戳（ms epoch）——同時作為剪枝的時間基準。
   * @returns 成功收錄（含本來就已存在）為 true；容量已滿且為新項目則 false（fail-closed，
   *   不逐出既有項目）。
   */
  add(signer: string, nonce: Uint8Array, timestamp: number): boolean {
    this.#prune(timestamp);
    const key = signer + ':' + toHex(nonce);
    if (this.#entries.has(key)) return true;
    if (this.#entries.size >= this.#maxEntries) return false;
    this.#entries.set(key, timestamp);
    return true;
  }

  /** 移除已不可能落在允許時間窗內的紀錄。 */
  #prune(referenceNow: number): void {
    const cutoff = referenceNow - NONCE_CACHE_TTL_MS;
    for (const [key, ts] of this.#entries) {
      if (ts < cutoff) this.#entries.delete(key);
    }
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hasExactKeys(value: object, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((k) => allowed.includes(k));
}

interface RawEnvelope {
  readonly payload: unknown;
  readonly timestamp: unknown;
  readonly nonce: unknown;
  readonly signer: unknown;
  readonly signature: unknown;
}

interface ShapedEnvelope {
  payload: unknown;
  timestamp: number;
  nonce: Uint8Array;
  signer: string;
  signature: Uint8Array;
}

/** envelope 結構檢查——5 鍵齊全、對應型別正確；payload 內容留給 isPinRequestPayload 檢查 */
function hasEnvelopeShape(body: unknown): body is ShapedEnvelope {
  if (typeof body !== 'object' || body === null) return false;
  const value = body as RawEnvelope;
  return (
    hasExactKeys(value, ['payload', 'timestamp', 'nonce', 'signer', 'signature']) &&
    typeof value.signer === 'string' &&
    value.signer.length > 0 &&
    value.signer.length <= Protocol.security.P2P_MESSAGE_SIGNER_MAX_CHARS &&
    Number.isSafeInteger(value.timestamp) &&
    value.nonce instanceof Uint8Array &&
    value.nonce.byteLength === Protocol.security.P2P_MESSAGE_NONCE_BYTES &&
    value.signature instanceof Uint8Array &&
    value.signature.byteLength === Protocol.security.ED25519_SIGNATURE_BYTES
  );
}

interface RawPinFields {
  readonly type: unknown;
  readonly cid: unknown;
  readonly category: unknown;
  readonly sizeHintBytes: unknown;
}

const PIN_REQUEST_CATEGORY_SET = new Set<string>(PIN_REQUEST_CATEGORIES);

/** payload 的 type 域檢查——必須恰為 PinPayload 或 UnpinPayload 的欄位形，不容多餘欄位 */
function isPinRequestPayload(payload: unknown): payload is PinRequestPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const value = payload as RawPinFields;
  if (value.type === 'pinning-pin') {
    return (
      hasExactKeys(value, ['type', 'cid', 'category', 'sizeHintBytes']) &&
      typeof value.cid === 'string' &&
      value.cid.length > 0 &&
      typeof value.category === 'string' &&
      PIN_REQUEST_CATEGORY_SET.has(value.category) &&
      Number.isSafeInteger(value.sizeHintBytes) &&
      (value.sizeHintBytes as number) > 0
    );
  }
  if (value.type === 'pinning-unpin') {
    return (
      hasExactKeys(value, ['type', 'cid']) && typeof value.cid === 'string' && value.cid.length > 0
    );
  }
  return false;
}

/**
 * 驗證一筆 pin／unpin 請求：結構、payload 型別域、時戳窗、重放初篩、簽章全部通過才回 ok；
 * 只有簽章驗證通過的請求才會被收錄進 nonce 快取（時序理由見 NonceCache 類別註解）。
 *
 * @param body 未信任輸入（已結構化解碼，非 wire bytes）。
 * @param now 驗證當下時間（ms epoch）。
 * @param nonces 共用的重放快取；驗證通過的請求會記錄其 (signer, nonce)；快取容量已滿時視同
 *   驗證失敗（fail-closed）。
 */
export function verifyPinRequest(body: unknown, now: number, nonces: NonceCache): VerifyResult {
  if (!hasEnvelopeShape(body)) return { ok: false, code: 'SIG_INVALID' };
  const { payload, timestamp, nonce, signer, signature } = body;

  if (!isPinRequestPayload(payload)) return { ok: false, code: 'SIG_INVALID' };
  if (Math.abs(now - timestamp) > TOLERANCE_MS) return { ok: false, code: 'SIG_INVALID' };
  if (nonces.has(signer, nonce, timestamp)) return { ok: false, code: 'SIG_INVALID' };

  const verified = verifySignedPayload<PinRequestPayload>({
    payload,
    timestamp,
    nonce,
    signer: signer as PeerId,
    signature: signature as Signature,
  });
  if (!verified) return { ok: false, code: 'SIG_INVALID' };

  if (!nonces.add(signer, nonce, timestamp)) return { ok: false, code: 'SIG_INVALID' };

  return { ok: true, signer, payload };
}
