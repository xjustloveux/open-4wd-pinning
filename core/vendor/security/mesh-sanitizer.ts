/**
 * 主執行緒側 sanitize 呼叫 — 每請求一次性 Worker；超時即 terminate（時間上限的實際執行機制）、
 * buffer 以 transferable 傳遞零拷貝；記憶體風險由輸入大小天花板＋terminate 兜底
 */
import { Protocol } from '@open4wd/system-constants';
import type { SanitizeRequest, SanitizeResult } from './sanitize-core';
import { APP_SECURITY_LOG, type LocalSecurityLog } from './security-log';

/** 在一次性 Worker 中執行有時間上限的 GLB sanitize。 */
export class MeshSanitizer {
  constructor(
    /** 保存安全事件記錄器，用來回報拒絕或修正不可信網格的原因。 */ private readonly securityLog: LocalSecurityLog = APP_SECURITY_LOG,
  ) {}

  /** meshBuffer 以 transferable 移轉——呼叫後原 buffer 即失效（零拷貝） */
  sanitize(request: SanitizeRequest): Promise<SanitizeResult> {
    const worker = new Worker(new URL('./sanitize.worker', import.meta.url), { type: 'module' });
    return new Promise((resolve) => {
      const done = (result: SanitizeResult): void => {
        clearTimeout(timer);
        worker.terminate();
        if (!result.ok)
          this.securityLog.log({
            type: 'sanitize-fail',
            timestamp: Date.now(),
            details: { reason: result.reason },
          });
        resolve(result);
      };
      const timer = setTimeout(
        () => done({ ok: false, reason: 'parse-error', details: 'timeout' }),
        Protocol.security.SANITIZE_TIMEOUT_MS,
      );
      worker.addEventListener('message', (event: MessageEvent<SanitizeResult>) => done(event.data));
      worker.addEventListener('error', () =>
        done({ ok: false, reason: 'parse-error', details: 'worker error' }),
      );
      worker.postMessage(request, [request.meshBuffer]); // transferable、零拷貝
    });
  }
}
