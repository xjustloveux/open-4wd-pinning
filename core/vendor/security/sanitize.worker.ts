/**
 * Sanitize Worker 進入點 — 隔離 context（無 DOM、不得 fetch）；收 GLB → sanitizeMesh → 回傳結果
 */
import { sanitizeMesh, type SanitizeRequest, type SanitizeResult } from './sanitize-core';

interface WorkerScope {
  addEventListener(type: 'message', handler: (event: MessageEvent<SanitizeRequest>) => void): void;
  postMessage(message: SanitizeResult, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.addEventListener('message', (event) => {
  const result = sanitizeMesh(event.data);
  scope.postMessage(result, result.ok ? [result.sanitized] : []);
});
