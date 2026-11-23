import { Protocol } from '@open4wd/system-constants';
import { admissionWorkDigest, hasLeadingZeroBits } from './ledger-entry-admission';
import type { AdmissionWorkerRequest, AdmissionWorkerResponse } from './ledger-admission-miner';

/** Worker 每批同步計算的 nonce hashes 數，批間讓出 cancel 訊息。 */
export const ADMISSION_HASHES_PER_BATCH = 4096;

/** 用於在 CPU-bound 准入批次間 yield 的訊息 task scheduler。 */
export interface AdmissionBatchScheduler {
  schedule(task: () => void): void;
  close(): void;
}

/** 建立由 MessageChannel 支持的 FIFO scheduler，不使用巢狀零延遲 timer。 */
export function createAdmissionBatchScheduler(
  channel: MessageChannel = new MessageChannel(),
): AdmissionBatchScheduler {
  const tasks: (() => void)[] = [];
  let closed = false;
  channel.port1.onmessage = (): void => {
    if (closed) return;
    tasks.shift()?.();
  };
  return {
    schedule: (task) => {
      if (closed) return;
      tasks.push(task);
      channel.port2.postMessage(undefined);
    },
    close: () => {
      if (closed) return;
      closed = true;
      tasks.length = 0;
      channel.port1.close();
      channel.port2.close();
    },
  };
}

/** 無符號 big-endian 遞增；false 表示最大 nonce 已耗用。 */
export function incrementAdmissionNonce(nonce: Uint8Array): boolean {
  if (nonce.byteLength !== Protocol.ledger.LEDGER_ADMISSION_NONCE_BYTES)
    throw new RangeError('invalid Admission nonce length');
  for (let index = nonce.byteLength - 1; index >= 0; index--) {
    if (nonce[index] !== 0xff) {
      nonce[index] = nonce[index]! + 1;
      nonce.fill(0, index + 1);
      return true;
    }
  }
  return false;
}

/** 單批 nonce 搜尋找到結果或下一個搜尋起點。 */
export type AdmissionBatchResult =
  | { readonly kind: 'done'; readonly nonce: Uint8Array; readonly attempts: number }
  | { readonly kind: 'continue'; readonly attempts: number }
  | { readonly kind: 'error'; readonly code: 'nonce-exhausted'; readonly attempts: number };

/** 從指定 nonce 起執行固定數量、可決定性續跑的 work 搜尋。 */
export function searchAdmissionNonceBatch(
  baseDigest: Uint8Array,
  requiredBits: number,
  nonce: Uint8Array,
  batchSize = ADMISSION_HASHES_PER_BATCH,
): AdmissionBatchResult {
  if (
    baseDigest.byteLength !== 32 ||
    !Number.isSafeInteger(requiredBits) ||
    requiredBits < 0 ||
    requiredBits > 256 ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > ADMISSION_HASHES_PER_BATCH
  )
    throw new RangeError('invalid Admission Worker request');
  for (let attempts = 1; attempts <= batchSize; attempts++) {
    if (hasLeadingZeroBits(admissionWorkDigest(baseDigest, nonce), requiredBits))
      return { kind: 'done', nonce: Uint8Array.from(nonce), attempts };
    if (!incrementAdmissionNonce(nonce))
      return { kind: 'error', code: 'nonce-exhausted', attempts };
  }
  return { kind: 'continue', attempts: batchSize };
}

interface WorkerScopeLike {
  readonly document?: unknown;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<AdmissionWorkerRequest>) => void,
  ): void;
  postMessage(message: AdmissionWorkerResponse, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScopeLike;
if (
  scope.document === undefined &&
  typeof scope.addEventListener === 'function' &&
  typeof scope.postMessage === 'function'
) {
  const batchScheduler = createAdmissionBatchScheduler();
  let cancelled = false;
  let running = false;
  scope.addEventListener('message', (event) => {
    const request = event.data;
    if (request.kind === 'cancel') {
      cancelled = true;
      return;
    }
    if (running) {
      scope.postMessage({ kind: 'error', code: 'worker-busy' });
      return;
    }
    running = true;
    cancelled = false;
    const baseDigest = Uint8Array.from(request.baseDigest);
    const nonce = Uint8Array.from(request.startNonce);
    let attempts = 0;
    const runBatch = (): void => {
      if (cancelled) {
        running = false;
        return;
      }
      let result: AdmissionBatchResult;
      try {
        result = searchAdmissionNonceBatch(baseDigest, request.requiredBits, nonce);
      } catch {
        running = false;
        scope.postMessage({ kind: 'error', code: 'invalid-request' });
        return;
      }
      attempts += result.attempts;
      if (result.kind === 'done') {
        running = false;
        const completed = result.nonce;
        scope.postMessage({ kind: 'done', nonce: completed, attempts }, [completed.buffer]);
      } else if (result.kind === 'error') {
        running = false;
        scope.postMessage({ kind: 'error', code: result.code });
      } else {
        batchScheduler.schedule(runBatch);
      }
    };
    runBatch();
  });
}
