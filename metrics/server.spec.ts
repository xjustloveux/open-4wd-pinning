import { describe, expect, it } from 'vitest';
import { createPrometheusMetrics } from './metrics';
import { startMetricsServer } from './server';

describe('private metrics listener', () => {
  it('獨立 listener 只提供 /metrics 與健康狀態，不掛進公開管理 API', async () => {
    const metrics = createPrometheusMetrics();
    metrics.recordApi('stats', '2xx', 5);
    let collections = 0;
    const server = startMetricsServer({ host: '127.0.0.1', port: 0 }, metrics, async () => {
      collections += 1;
      metrics.setCapacity({
        repoSizeBytes: 60,
        storageMaxBytes: 100,
        quotaGlobalUsedBytes: 40,
        quotaGlobalLimitBytes: 80,
      });
    });
    const port = await server.ready;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('open4wd_pinning_api_requests_total');
      expect(collections).toBe(1);
      expect((await fetch(`http://127.0.0.1:${port}/stats`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('pull-time 容量採集失敗時回 503，不輸出可能過時的 gauges', async () => {
    const metrics = createPrometheusMetrics();
    const server = startMetricsServer({ host: '127.0.0.1', port: 0 }, metrics, async () => {
      throw new Error('kubo unavailable');
    });
    const port = await server.ready;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(response.status).toBe(503);
    } finally {
      await server.close();
    }
  });
});
