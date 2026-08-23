import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { pinningStatsUrl, validatePinningStats } from './smoke-lib';

describe('pinning smoke contract', () => {
  it('keeps the root README as a reproducible pre-launch public entrypoint', () => {
    const readme = readFileSync('README.md', 'utf8');
    for (const required of [
      '開發中',
      '主遊戲尚未正式公開',
      'pnpm install --frozen-lockfile',
      '[MIT](LICENSE)',
      'https://github.com/xjustloveux/open-4wd/security/policy',
    ]) {
      expect(readme).toContain(required);
    }
    expect(readme).not.toContain('程式參數表.md');
  });

  it('uses only the operator-fork deployment model in public deployment guidance', () => {
    const deploymentText = [
      'deploy/monitoring/README.md',
      'deploy/k8s/overlays/sizing-example/kustomization.yaml',
    ]
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    expect(deploymentText).not.toMatch(/部署 repo|deployment repo/iu);
    expect(deploymentText).toContain('營運者 fork');
  });

  it('leaves Alertmanager receiver selection to each operator', () => {
    const monitoring = ['deploy/monitoring/README.md', 'deploy/monitoring/alertmanager.yml']
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    expect(monitoring).not.toMatch(/Discord|private-discord|discord_configs/iu);
    expect(monitoring).toContain('operator-selected');
    expect(monitoring).toMatch(/營運者.*自行選擇.*receiver/u);
  });

  it('local liveness requires HTTP stats with a non-empty node_id only', () => {
    expect(validatePinningStats({ node_id: 'peer-1', ipfs_cluster_peers: 0 }, false)).toBeNull();
    expect(validatePinningStats({ node_id: '' }, false)).toBe('stats-node-id-invalid');
    expect(validatePinningStats(null, false)).toBe('stats-body-invalid');
  });

  it('strict deployment readiness additionally requires cluster peers and positive Kubo space', () => {
    expect(
      validatePinningStats(
        { node_id: 'peer-1', ipfs_cluster_peers: 1, available_space_bytes: 1 },
        true,
      ),
    ).toBeNull();
    expect(
      validatePinningStats(
        { node_id: 'peer-1', ipfs_cluster_peers: 0, available_space_bytes: 1 },
        true,
      ),
    ).toBe('stats-cluster-not-ready');
    expect(
      validatePinningStats(
        { node_id: 'peer-1', ipfs_cluster_peers: '1', available_space_bytes: 1 },
        true,
      ),
    ).toBe('stats-cluster-not-ready');
    expect(
      validatePinningStats(
        { node_id: 'peer-1', ipfs_cluster_peers: 1, available_space_bytes: 0 },
        true,
      ),
    ).toBe('stats-storage-full');
    expect(validatePinningStats({ node_id: 'peer-1', ipfs_cluster_peers: 1 }, true)).toBe(
      'stats-storage-full',
    );
  });

  it('accepts only a bare http(s) base origin', () => {
    expect(pinningStatsUrl('http://127.0.0.1:8000/')).toBe('http://127.0.0.1:8000/stats');
    for (const value of [
      'ws://127.0.0.1:8000',
      'https://user:pass@pin.open4wd.org',
      'https://pin.open4wd.org/api',
      'https://pin.open4wd.org?token=x',
    ])
      expect(() => pinningStatsUrl(value)).toThrow('pinning base URL');
  });
});
