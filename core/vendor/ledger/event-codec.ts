/**
 * 事件解碼層（log 值 → LedgerEvent）：①shape 閘——BaseEvent 四欄型別檢查、非
 * plain object 拒收（下游 fold／驗章的前置防線，malformed 條目在此止步）；
 * ②⭐bigint 歸一——dag-cbor 對安全範圍內的 bigint 編碼為一般 CBOR 整數、解碼回
 * number（超範圍才回 bigint）＝金額欄位過 log 往返會**靜默變型**，已知貨幣欄位
 * 一律歸一回 bigint（簽章 digest 不受影響：bigint 5n 與 number 5 編碼同 bytes）。
 */
import type { LedgerEvent } from '@open4wd/interfaces';

/** 已知貨幣欄位的 bigint 歸一（新事件型別若含金額，於此登記） */
function normalizeAmounts(event: Record<string, unknown>): void {
  if (event['type'] === 'ugc-maintenance' && typeof event['burnAmount'] === 'number')
    event['burnAmount'] = BigInt(event['burnAmount']);
  if (
    (event['type'] === 'slot-purchase' || event['type'] === 'ugc-sponsor-burn') &&
    typeof event['amount'] === 'number'
  )
    event['amount'] = BigInt(event['amount']);
}

function isUint8Array(value: unknown): value is Uint8Array {
  // 跨 realm（jsdom×cborg Buffer 快路徑）下 instanceof 不可靠——以結構判定
  return (
    value instanceof Uint8Array ||
    (typeof value === 'object' &&
      value !== null &&
      ArrayBuffer.isView(value) &&
      !(value instanceof DataView))
  );
}

/**
 * log 條目值 → LedgerEvent；shape 不符回 null（呼叫端跳過該條目）。
 * 僅驗 BaseEvent 共同底座——事件型別專屬深層 schema 隨各業務模組收件細則。
 */
export function decodeLedgerEvent(value: unknown): LedgerEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['type'] !== 'string' || record['type'].length === 0) return null;
  if (typeof record['timestamp'] !== 'number' || !Number.isFinite(record['timestamp'])) return null;
  if (typeof record['peerId'] !== 'string' || record['peerId'].length === 0) return null;
  if (!isUint8Array(record['signature'])) return null;
  normalizeAmounts(record);
  return record as unknown as LedgerEvent;
}
