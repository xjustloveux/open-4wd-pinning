import { Protocol } from '@open4wd/system-constants';
import { admissionWorkDigest, hasLeadingZeroBits } from './ledger-entry-admission';

/** 搜尋 PoW nonce 所需的 base digest 與 leading-zero bits。 */
export interface AdmissionMineInput {
  readonly baseDigest: Uint8Array;
  readonly requiredBits: number;
}

/** 可取消地搜尋符合 admission work 門檻 nonce 的介面。 */
export interface AdmissionMiner {
  mine(input: AdmissionMineInput, signal: AbortSignal): Promise<Uint8Array>;
}

/** Browser admission miner 使用的最小 Worker surface。 */
export interface AdmissionWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: 'message' | 'error', listener: EventListener): void;
  removeEventListener(type: 'message' | 'error', listener: EventListener): void;
}

/** 主執行緒送入 admission worker 的 mine 或 cancel 訊息。 */
export type AdmissionWorkerRequest =
  | {
      readonly kind: 'mine';
      readonly baseDigest: Uint8Array;
      readonly requiredBits: number;
      readonly startNonce: Uint8Array;
    }
  | { readonly kind: 'cancel' };

/** Admission worker 回傳成功 nonce 或穩定錯誤碼。 */
export type AdmissionWorkerResponse =
  | { readonly kind: 'done'; readonly nonce: Uint8Array; readonly attempts?: number }
  | { readonly kind: 'error'; readonly code: string };

/** 呼叫端 AbortSignal 主動取消 admission work。 */
export class LedgerAdmissionWorkAbortedError extends Error {
  constructor() {
    super('Admission work aborted');
    this.name = 'LedgerAdmissionWorkAbortedError';
  }
}

/** Admission work 超過本機資源時間上限。 */
export class LedgerAdmissionWorkTimeoutError extends Error {
  constructor() {
    super('Admission work timed out');
    this.name = 'LedgerAdmissionWorkTimeoutError';
  }
}

interface BrowserAdmissionMinerOptions {
  readonly createWorker?: () => AdmissionWorkerLike | null;
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly timeoutMs?: number;
}

function createBrowserWorker(): AdmissionWorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  return new Worker(new URL('./ledger-admission.worker', import.meta.url), {
    type: 'module',
  });
}

function browserRandomBytes(length: number): Uint8Array {
  if (globalThis.crypto?.getRandomValues === undefined)
    throw new Error('Admission random source unavailable');
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

function assertMineInput(input: AdmissionMineInput): void {
  if (
    !(input.baseDigest instanceof Uint8Array) ||
    input.baseDigest.byteLength !== 32 ||
    !Number.isSafeInteger(input.requiredBits) ||
    input.requiredBits < 0 ||
    input.requiredBits > 256
  )
    throw new RangeError('invalid Admission mining input');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 在一次性 Worker 中執行 admission work並處理取消、逾時與 fallback。 */
export class BrowserAdmissionMiner implements AdmissionMiner {
  /** 每次 mine 建立隔離 Worker 的 factory。 */
  readonly #createWorker: () => AdmissionWorkerLike | null;
  /** 產生搜尋起始 nonce 的安全亂數來源。 */
  readonly #randomBytes: (length: number) => Uint8Array;
  /** 單次 admission work 的本機逾時。 */
  readonly #timeoutMs: number;

  constructor(options: BrowserAdmissionMinerOptions = {}) {
    this.#createWorker = options.createWorker ?? createBrowserWorker;
    this.#randomBytes = options.randomBytes ?? browserRandomBytes;
    this.#timeoutMs = options.timeoutMs ?? Protocol.ledger.LEDGER_ADMISSION_WORK_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1)
      throw new RangeError('invalid Admission work timeout');
  }

  /** 依輸入與中止訊號計算 admission 工作量證明，成功時回傳符合難度的 nonce。 */
  mine(input: AdmissionMineInput, signal: AbortSignal): Promise<Uint8Array> {
    try {
      assertMineInput(input);
    } catch (cause) {
      return Promise.reject(cause);
    }
    if (signal.aborted) return Promise.reject(new LedgerAdmissionWorkAbortedError());

    let worker: AdmissionWorkerLike | null;
    try {
      worker = this.#createWorker();
    } catch {
      worker = null;
    }
    if (worker === null) return Promise.reject(new Error('Admission Worker unavailable'));

    let startNonce: Uint8Array;
    try {
      startNonce = this.#randomBytes(Protocol.ledger.LEDGER_ADMISSION_NONCE_BYTES);
      if (
        !(startNonce instanceof Uint8Array) ||
        startNonce.byteLength !== Protocol.ledger.LEDGER_ADMISSION_NONCE_BYTES
      )
        throw new Error('invalid random nonce');
    } catch (cause) {
      worker.terminate();
      return Promise.reject(
        cause instanceof Error ? cause : new Error('Admission random source unavailable'),
      );
    }

    const baseDigest = Uint8Array.from(input.baseDigest);
    startNonce = Uint8Array.from(startNonce);
    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      const finish = (result: { ok: true; nonce: Uint8Array } | { ok: false; error: Error }) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        worker.terminate();
        if (result.ok) resolve(result.nonce);
        else reject(result.error);
      };
      const onAbort = (): void =>
        finish({ ok: false, error: new LedgerAdmissionWorkAbortedError() });
      const onError = (): void =>
        finish({ ok: false, error: new Error('Admission Worker crashed') });
      const onMessage = (rawEvent: Event): void => {
        const event = rawEvent as MessageEvent<unknown>;
        const message = event.data;
        if (!isRecord(message) || (message['kind'] !== 'done' && message['kind'] !== 'error')) {
          finish({ ok: false, error: new Error('invalid Admission Worker result') });
          return;
        }
        if (message['kind'] === 'error') {
          const code = typeof message['code'] === 'string' ? message['code'] : 'unknown';
          finish({ ok: false, error: new Error(`Admission Worker failed: ${code}`) });
          return;
        }
        const nonce = message['nonce'];
        if (
          !(nonce instanceof Uint8Array) ||
          nonce.byteLength !== Protocol.ledger.LEDGER_ADMISSION_NONCE_BYTES ||
          !hasLeadingZeroBits(admissionWorkDigest(input.baseDigest, nonce), input.requiredBits)
        ) {
          finish({ ok: false, error: new Error('invalid Admission Worker result') });
          return;
        }
        finish({ ok: true, nonce: Uint8Array.from(nonce) });
      };
      const timeout = globalThis.setTimeout(
        () => finish({ ok: false, error: new LedgerAdmissionWorkTimeoutError() }),
        this.#timeoutMs,
      );
      signal.addEventListener('abort', onAbort, { once: true });
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      const request: AdmissionWorkerRequest = {
        kind: 'mine',
        baseDigest,
        requiredBits: input.requiredBits,
        startNonce,
      };
      try {
        worker.postMessage(request, [baseDigest.buffer, startNonce.buffer]);
      } catch {
        finish({ ok: false, error: new Error('Admission Worker unavailable') });
      }
    });
  }
}
