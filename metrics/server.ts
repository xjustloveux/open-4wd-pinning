import { createServer } from 'node:http';
import type { PinningMetrics } from './metrics';

/** 設定不與管理 API 共用埠的專用指標監聽器。 */
export interface MetricsServerConfig {
  readonly host: string;
  readonly port: number;
}

/** 提供指標監聽器的就緒狀態與平順關閉操作。 */
export interface RunningMetricsServer {
  readonly ready: Promise<number>;
  close(): Promise<void>;
}

/** 啟動專用 HTTP 端點，於選用儀表收集後輸出指標。 */
export function startMetricsServer(
  config: MetricsServerConfig,
  metrics: PinningMetrics,
  collectBeforeRender?: () => Promise<void>,
): RunningMetricsServer {
  const server = createServer((req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    req.socket.on('error', () => {});
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
      return;
    }
    void (async () => {
      try {
        await collectBeforeRender?.();
        res.writeHead(200, {
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(metrics.render());
      } catch {
        res.writeHead(503, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end('metrics collection unavailable\n');
      }
    })();
  });
  const ready = new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : config.port);
    });
  });
  return {
    ready,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
