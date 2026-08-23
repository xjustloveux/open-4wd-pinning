import { describe, expect, it } from 'vitest';
import { createNoopMetrics, createPrometheusMetrics } from './metrics';

describe('pinning metrics port', () => {
  it('Prometheus registry 只接受封閉低基數維度並輸出 counter/histogram', () => {
    const metrics = createPrometheusMetrics();
    metrics.recordApi('pin', '2xx', 25);
    metrics.recordApi('pin', '5xx', 100);
    metrics.recordDmcaSweep('success', 12);
    metrics.recordDmcaDelivery('delivered');
    metrics.recordDmcaDelivery('retrying');
    metrics.recordCluster('pin', 'error', 40);
    metrics.setCapacity({
      repoSizeBytes: 60,
      storageMaxBytes: 100,
      quotaGlobalUsedBytes: 40,
      quotaGlobalLimitBytes: 80,
    });
    const text = metrics.render();

    expect(text).toContain('open4wd_pinning_api_requests_total{route="pin",status_class="2xx"} 1');
    expect(text).toContain('open4wd_pinning_dmca_sweeps_total{outcome="success"} 1');
    expect(text).toContain('open4wd_pinning_dmca_counter_deliveries_total{outcome="delivered"} 1');
    expect(text).toContain('open4wd_pinning_dmca_counter_deliveries_total{outcome="retrying"} 1');
    expect(text).toContain(
      'open4wd_pinning_cluster_operations_total{operation="pin",outcome="error"} 1',
    );
    expect(text).toContain('open4wd_pinning_repo_size_bytes 60');
    expect(text).toContain('open4wd_pinning_storage_max_bytes 100');
    expect(text).toContain('open4wd_pinning_quota_global_used_bytes 40');
    expect(text).toContain('open4wd_pinning_quota_global_limit_bytes 80');
    expect(text).not.toContain('peer');
    expect(text).not.toContain('cid');
  });

  it('no-op adapter 與 production port 同介面，停用時零配置成本', () => {
    const metrics = createNoopMetrics();
    expect(() => {
      metrics.recordApi('stats', '2xx', 1);
      metrics.recordDmcaSweep('error', 1);
      metrics.recordDmcaDelivery('retrying');
      metrics.recordCluster('unpin', 'success', 1);
      metrics.setCapacity({
        repoSizeBytes: 1,
        storageMaxBytes: 2,
        quotaGlobalUsedBytes: 1,
        quotaGlobalLimitBytes: 2,
      });
    }).not.toThrow();
    expect(metrics.render()).toBe('');
  });
});
