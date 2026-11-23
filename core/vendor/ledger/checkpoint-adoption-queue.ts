/** 遠端 checkpoint announcement 的獨立有界驗證佇列；不得占用 ledger fold queue。 */
export const CHECKPOINT_ADOPTION_MAX_PENDING = 64;
export const CHECKPOINT_ADOPTION_MAX_PENDING_BYTES = 256 * 1024;
export const CHECKPOINT_ADOPTION_MAX_MESSAGE_BYTES = 8 * 1024;
export const CHECKPOINT_ADOPTION_MAX_CONCURRENCY = 2;
export const CHECKPOINT_ADOPTION_MAX_RETRIES = 1;
export const CHECKPOINT_ADOPTION_NEGATIVE_CACHE_MAX = 256;

/** 遠端 checkpoint 驗證後的終態或一次性重試裁決。 */
export type CheckpointAdoptionVerdict = 'accepted' | 'rejected' | 'permanent-invalid' | 'retry';

interface Pending<T> {
  key: string;
  value: T;
  bytes: number;
  attempt: number;
}

/** 與 fold queue 隔離、具 byte/count/concurrency 上限的 checkpoint 驗證佇列。 */
export class CheckpointAdoptionQueue<T> {
  /** 對單一 announcement 執行完整 adoption 驗證的 handler。 */
  readonly #handler: (value: T, signal: AbortSignal) => Promise<CheckpointAdoptionVerdict>;
  /** stop 時取消所有 active handlers 的共用 controller。 */
  readonly #abortController = new AbortController();
  /** 尚未進入 handler 的 FIFO announcements。 */
  readonly #pending: Pending<T>[] = [];
  /** Active 或 pending keys，用來抑制同時重複驗證。 */
  readonly #keys = new Set<string>();
  /** 有界保存永久無效 keys，避免重複消耗驗證資源。 */
  readonly #negative = new Map<string, true>();
  /** Queue 完全 idle 時需要解除的 drain waiters。 */
  readonly #drainWaiters = new Set<() => void>();
  /** Pending FIFO 已保留的總 message bytes。 */
  #pendingBytes = 0;
  /** 目前正在執行的 handler 數。 */
  #active = 0;
  /** Stop 後阻止 enqueue 與 retry。 */
  #stopped = false;

  constructor(handler: (value: T, signal: AbortSignal) => Promise<CheckpointAdoptionVerdict>) {
    this.#handler = handler;
  }

  /** 在項目數與位元組預算允許時排入 checkpoint 採用工作，回傳是否成功接納。 */
  enqueue(key: string, value: T, bytes: number): boolean {
    if (
      this.#stopped ||
      this.#keys.has(key) ||
      this.#negative.has(key) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > CHECKPOINT_ADOPTION_MAX_MESSAGE_BYTES ||
      this.#pending.length + this.#active >= CHECKPOINT_ADOPTION_MAX_PENDING ||
      this.#pendingBytes + bytes > CHECKPOINT_ADOPTION_MAX_PENDING_BYTES
    )
      return false;
    this.#keys.add(key);
    this.#pending.push({ key, value, bytes, attempt: 0 });
    this.#pendingBytes += bytes;
    this.#pump();
    return true;
  }

  /** durable scan 專用：容量滿時等待 drain 後續掃，不得把 overflow 當成已處理。 */
  async enqueueWithBackpressure(key: string, value: T, bytes: number): Promise<boolean> {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > CHECKPOINT_ADOPTION_MAX_MESSAGE_BYTES)
      return false;
    while (!this.#stopped) {
      if (this.#negative.has(key)) return false;
      if (this.#keys.has(key)) return true;
      if (this.enqueue(key, value, bytes)) return true;
      await this.drain();
    }
    return false;
  }

  /** 等待目前已排入的 checkpoint 採用工作全部完成。 */
  async drain(): Promise<void> {
    if (this.#pending.length === 0 && this.#active === 0) return;
    await new Promise<void>((resolve) => this.#drainWaiters.add(resolve));
  }

  /** 停止接收新的 checkpoint 工作，並中止尚未開始的背景排程。 */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#abortController.abort();
    for (const item of this.#pending) this.#keys.delete(item.key);
    this.#pending.length = 0;
    this.#pendingBytes = 0;
    await this.drain();
  }

  /** 以 insertion-order LRU 保存永久無效 key。 */
  #rememberInvalid(key: string): void {
    this.#negative.delete(key);
    this.#negative.set(key, true);
    while (this.#negative.size > CHECKPOINT_ADOPTION_NEGATIVE_CACHE_MAX) {
      const oldest = this.#negative.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#negative.delete(oldest);
    }
  }

  /** 在 concurrency 與 pending budget 內啟動下一批 handlers。 */
  #pump(): void {
    while (
      !this.#stopped &&
      this.#active < CHECKPOINT_ADOPTION_MAX_CONCURRENCY &&
      this.#pending.length > 0
    ) {
      const item = this.#pending.shift()!;
      this.#pendingBytes -= item.bytes;
      this.#active++;
      void this.#run(item);
    }
    this.#resolveDrainIfIdle();
  }

  /** 執行單筆已排程工作，並在完成後釋放其併發與容量配額。 */
  async #run(item: Pending<T>): Promise<void> {
    let verdict: CheckpointAdoptionVerdict;
    try {
      verdict = await Promise.race([
        this.#handler(item.value, this.#abortController.signal),
        new Promise<CheckpointAdoptionVerdict>((resolve) => {
          if (this.#abortController.signal.aborted) resolve('rejected');
          else
            this.#abortController.signal.addEventListener('abort', () => resolve('rejected'), {
              once: true,
            });
        }),
      ]);
    } catch {
      verdict = 'retry';
    }
    this.#active--;
    if (
      verdict === 'retry' &&
      !this.#stopped &&
      item.attempt < CHECKPOINT_ADOPTION_MAX_RETRIES &&
      this.#pending.length + this.#active < CHECKPOINT_ADOPTION_MAX_PENDING &&
      this.#pendingBytes + item.bytes <= CHECKPOINT_ADOPTION_MAX_PENDING_BYTES
    ) {
      this.#pending.push({ ...item, attempt: item.attempt + 1 });
      this.#pendingBytes += item.bytes;
    } else {
      this.#keys.delete(item.key);
      if (verdict === 'permanent-invalid') this.#rememberInvalid(item.key);
    }
    this.#pump();
  }

  /** Queue 完全 idle 時解除並清空所有 drain waiters。 */
  #resolveDrainIfIdle(): void {
    if (this.#pending.length !== 0 || this.#active !== 0) return;
    for (const resolve of this.#drainWaiters) resolve();
    this.#drainWaiters.clear();
  }
}
