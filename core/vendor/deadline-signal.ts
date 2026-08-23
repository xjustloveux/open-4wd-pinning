/** 可明確檢查來源並清理 listener 的呼叫端／期限取消 signal。 */
export interface DeadlineSignal {
  readonly signal: AbortSignal;
  didTimeout(): boolean;
  dispose(): void;
}

/** 結合選填呼叫端取消與期限，同時保留第一個原因。 */
export function createDeadlineSignal(
  timeoutMs: number,
  caller?: AbortSignal,
  timeoutReason?: unknown,
): DeadlineSignal {
  const controller = new AbortController();
  const timeout = AbortSignal.timeout(timeoutMs);
  let source: 'caller' | 'timeout' | null = null;
  let disposed = false;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    caller?.removeEventListener('abort', abortFromCaller);
    timeout.removeEventListener('abort', abortFromTimeout);
  };
  const abort = (nextSource: 'caller' | 'timeout', reason: unknown): void => {
    if (source !== null) return;
    source = nextSource;
    controller.abort(reason);
    dispose();
  };
  const abortFromCaller = (): void => abort('caller', caller?.reason);
  const abortFromTimeout = (): void => abort('timeout', timeoutReason ?? timeout.reason);

  if (caller?.aborted === true) abortFromCaller();
  else {
    caller?.addEventListener('abort', abortFromCaller, { once: true });
    timeout.addEventListener('abort', abortFromTimeout, { once: true });
  }

  return {
    signal: controller.signal,
    didTimeout: () => source === 'timeout',
    dispose,
  };
}
