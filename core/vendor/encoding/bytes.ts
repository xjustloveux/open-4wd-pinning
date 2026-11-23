/** 使用小寫且補零的十六進位格式，產生穩定的 wire 與摘要識別碼。 */
export function lowercaseHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 將 Uint8Array view 複製成恰好只含其可見位元組的 ArrayBuffer。 */
export function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}
