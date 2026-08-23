export function pinningStatsUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError('invalid pinning base URL');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.hostname.length === 0 ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    throw new TypeError('invalid pinning base URL');
  return `${parsed.origin}/stats`;
}

export function validatePinningStats(body: unknown, strict: boolean): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'stats-body-invalid';
  const stats = body as Record<string, unknown>;
  if (typeof stats['node_id'] !== 'string' || stats['node_id'].trim().length === 0)
    return 'stats-node-id-invalid';
  if (
    strict &&
    (!Number.isSafeInteger(stats['ipfs_cluster_peers']) ||
      (stats['ipfs_cluster_peers'] as number) < 1)
  )
    return 'stats-cluster-not-ready';
  if (
    strict &&
    (typeof stats['available_space_bytes'] !== 'number' ||
      !Number.isFinite(stats['available_space_bytes']) ||
      (stats['available_space_bytes'] as number) <= 0)
  )
    return 'stats-storage-full';
  return null;
}
