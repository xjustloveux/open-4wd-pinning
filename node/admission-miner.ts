/**
 * Node 端 admission proof-of-work 挖礦器——直接重用瀏覽器 worker 所呼叫的批次
 * 搜尋純函式（同一顆 nonce 遞增＋leading-zero-bits 判定），在主執行緒分批同步
 * 執行；批次之間讓出事件迴圈一次，使 AbortSignal 能於挖礦中途生效。
 */
import type { AdmissionMiner } from '../core';
import { Protocol, searchAdmissionNonceBatch } from '../core';
import { randomBytes } from 'node:crypto';

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 以有界批次挖掘准入證明，並在批次間允許取消。 */
export class InlineAdmissionMiner implements AdmissionMiner {
  /** 搜尋有效 nonce，直到完成或收到取消訊號。 */
  async mine(
    input: Parameters<AdmissionMiner['mine']>[0],
    signal: AbortSignal,
  ): ReturnType<AdmissionMiner['mine']> {
    if (signal.aborted) throw new Error('admission mining aborted');
    const nonce = Uint8Array.from(randomBytes(Protocol.ledger.LEDGER_ADMISSION_NONCE_BYTES));
    for (;;) {
      if (signal.aborted) throw new Error('admission mining aborted');
      const result = searchAdmissionNonceBatch(input.baseDigest, input.requiredBits, nonce);
      if (result.kind === 'done') return result.nonce;
      if (result.kind === 'error') throw new Error(`admission mining failed: ${result.code}`);
      await yieldToEventLoop();
    }
  }
}
