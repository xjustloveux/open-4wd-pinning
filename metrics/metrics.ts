/** 列舉請求指標使用的有界 API 路由標籤。 */
export type ApiMetricRoute =
  'provider' | 'stats' | 'pin' | 'unpin' | 'ugc_read' | 'dmca' | 'not_found';
/** 將 HTTP 回應收斂為穩定低基數狀態標籤。 */
export type HttpStatusClass = '2xx' | '4xx' | '5xx';
/** 將觀測到的操作分類為成功或失敗。 */
export type MetricOutcome = 'success' | 'error';
/** 分類已受理反通知向申訴人的投遞嘗試。 */
export type DmcaDeliveryOutcome = 'delivered' | 'retrying';
/** 列舉被觀測的 IPFS Cluster 操作。 */
export type ClusterMetricOperation = 'get' | 'pin' | 'unpin' | 'list' | 'peers';

/** 記錄匯出至 Prometheus 的目前儲存與配額儀表值。 */
export interface CapacityMetrics {
  readonly repoSizeBytes: number;
  readonly storageMaxBytes: number;
  readonly quotaGlobalUsedBytes: number;
  readonly quotaGlobalLimitBytes: number;
}

/** 記錄有界服務指標並產生 Prometheus 公開格式。 */
export interface PinningMetrics {
  recordApi(route: ApiMetricRoute, statusClass: HttpStatusClass, durationMs: number): void;
  recordDmcaSweep(outcome: MetricOutcome, durationMs: number): void;
  recordDmcaDelivery(outcome: DmcaDeliveryOutcome): void;
  recordCluster(
    operation: ClusterMetricOperation,
    outcome: MetricOutcome,
    durationMs: number,
  ): void;
  setCapacity(value: CapacityMetrics): void;
  render(): string;
}

interface Aggregate {
  count: number;
  durationSeconds: number;
}

function add(map: Map<string, Aggregate>, key: string, durationMs: number): void {
  const value = map.get(key) ?? { count: 0, durationSeconds: 0 };
  value.count += 1;
  value.durationSeconds += Math.max(durationMs, 0) / 1000;
  map.set(key, value);
}

const format = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');

/** 為單一服務行程建立記憶體內 Prometheus 指標收集器。 */
export function createPrometheusMetrics(): PinningMetrics {
  const api = new Map<string, Aggregate>();
  const sweeps = new Map<string, Aggregate>();
  const deliveries = new Map<DmcaDeliveryOutcome, number>();
  const cluster = new Map<string, Aggregate>();
  let capacity: CapacityMetrics | undefined;
  return {
    recordApi(route, statusClass, durationMs) {
      add(api, `${route}|${statusClass}`, durationMs);
    },
    recordDmcaSweep(outcome, durationMs) {
      add(sweeps, outcome, durationMs);
    },
    recordDmcaDelivery(outcome) {
      deliveries.set(outcome, (deliveries.get(outcome) ?? 0) + 1);
    },
    recordCluster(operation, outcome, durationMs) {
      add(cluster, `${operation}|${outcome}`, durationMs);
    },
    setCapacity(value) {
      for (const number of Object.values(value)) {
        if (!Number.isFinite(number) || number < 0)
          throw new RangeError('capacity metrics must be finite non-negative numbers');
      }
      capacity = { ...value };
    },
    render() {
      const lines = [
        '# HELP open4wd_pinning_api_requests_total Management API requests.',
        '# TYPE open4wd_pinning_api_requests_total counter',
      ];
      for (const [key, value] of api) {
        const [route, statusClass] = key.split('|');
        const labels = `{route="${route}",status_class="${statusClass}"}`;
        lines.push(`open4wd_pinning_api_requests_total${labels} ${value.count}`);
        lines.push(
          `open4wd_pinning_api_request_duration_seconds_sum${labels} ${format(value.durationSeconds)}`,
        );
        lines.push(`open4wd_pinning_api_request_duration_seconds_count${labels} ${value.count}`);
      }
      lines.push(
        '# HELP open4wd_pinning_dmca_sweeps_total DMCA scheduled sweep runs.',
        '# TYPE open4wd_pinning_dmca_sweeps_total counter',
      );
      for (const [outcome, value] of sweeps) {
        const labels = `{outcome="${outcome}"}`;
        lines.push(`open4wd_pinning_dmca_sweeps_total${labels} ${value.count}`);
        lines.push(
          `open4wd_pinning_dmca_sweep_duration_seconds_sum${labels} ${format(value.durationSeconds)}`,
        );
        lines.push(`open4wd_pinning_dmca_sweep_duration_seconds_count${labels} ${value.count}`);
      }
      lines.push(
        '# HELP open4wd_pinning_dmca_counter_deliveries_total Accepted counter-notice claimant delivery attempts.',
        '# TYPE open4wd_pinning_dmca_counter_deliveries_total counter',
      );
      for (const [outcome, count] of deliveries) {
        lines.push(`open4wd_pinning_dmca_counter_deliveries_total{outcome="${outcome}"} ${count}`);
      }
      lines.push(
        '# HELP open4wd_pinning_cluster_operations_total App-observed cluster operations.',
        '# TYPE open4wd_pinning_cluster_operations_total counter',
      );
      for (const [key, value] of cluster) {
        const [operation, outcome] = key.split('|');
        const labels = `{operation="${operation}",outcome="${outcome}"}`;
        lines.push(`open4wd_pinning_cluster_operations_total${labels} ${value.count}`);
        lines.push(
          `open4wd_pinning_cluster_operation_duration_seconds_sum${labels} ${format(value.durationSeconds)}`,
        );
        lines.push(
          `open4wd_pinning_cluster_operation_duration_seconds_count${labels} ${value.count}`,
        );
      }
      lines.push(
        '# HELP open4wd_pinning_repo_size_bytes Kubo repository size.',
        '# TYPE open4wd_pinning_repo_size_bytes gauge',
        '# HELP open4wd_pinning_storage_max_bytes Kubo configured StorageMax.',
        '# TYPE open4wd_pinning_storage_max_bytes gauge',
        '# HELP open4wd_pinning_quota_global_used_bytes Unique referenced block quota usage.',
        '# TYPE open4wd_pinning_quota_global_used_bytes gauge',
        '# HELP open4wd_pinning_quota_global_limit_bytes Configured global quota limit.',
        '# TYPE open4wd_pinning_quota_global_limit_bytes gauge',
      );
      if (capacity !== undefined) {
        lines.push(
          `open4wd_pinning_repo_size_bytes ${format(capacity.repoSizeBytes)}`,
          `open4wd_pinning_storage_max_bytes ${format(capacity.storageMaxBytes)}`,
          `open4wd_pinning_quota_global_used_bytes ${format(capacity.quotaGlobalUsedBytes)}`,
          `open4wd_pinning_quota_global_limit_bytes ${format(capacity.quotaGlobalLimitBytes)}`,
        );
      }
      return `${lines.join('\n')}\n`;
    },
  };
}

/** 建立刻意捨棄所有觀測值的指標連接埠。 */
export function createNoopMetrics(): PinningMetrics {
  return {
    recordApi: () => undefined,
    recordDmcaSweep: () => undefined,
    recordDmcaDelivery: () => undefined,
    recordCluster: () => undefined,
    setCapacity: () => undefined,
    render: () => '',
  };
}
