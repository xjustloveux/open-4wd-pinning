import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = (path: string): Promise<string> => readFile(new URL(path, import.meta.url), 'utf8');

describe('provider-neutral deployment policy', () => {
  it('ships a minimal production-only image under a deterministic non-root identity', async () => {
    const [dockerfile, dockerignore, packageText, lockfile] = await Promise.all([
      read('./docker/Dockerfile'),
      read('../.dockerignore'),
      read('../package.json'),
      read('../pnpm-lock.yaml'),
    ]);
    const packageJson = JSON.parse(packageText) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const rootImporter = lockfile.slice(lockfile.indexOf('  .:'), lockfile.indexOf('\npackages:'));
    const dependencyBlock = rootImporter.slice(
      rootImporter.indexOf('    dependencies:'),
      rootImporter.indexOf('    devDependencies:'),
    );
    const developmentBlock = rootImporter.slice(rootImporter.indexOf('    devDependencies:'));

    expect(dockerfile).toContain('pnpm install --frozen-lockfile --prod');
    expect(dockerfile).not.toContain('--prod=false');
    expect(dockerfile).not.toContain('COPY . .');
    expect(dockerfile).toContain('open4wd');
    expect(dockerfile).toContain('10001');
    expect(dockerfile).toContain('USER 10001:10001');
    for (const operatorScript of [
      'scripts/ledger-genesis.ts',
      'scripts/ledger-genesis-config.ts',
      'scripts/ledger-genesis-receipt.ts',
      'scripts/dmca-export.ts',
    ]) {
      expect(dockerfile).toContain(operatorScript);
    }
    expect(dockerignore).toContain('**/*.spec.ts');
    expect(dockerignore).toContain('**/*.test.ts');
    expect(packageJson.dependencies['tsx']).toBe('4.23.1');
    expect(packageJson.devDependencies['tsx']).toBeUndefined();
    expect(dependencyBlock).toMatch(/^\s{6}tsx:\s*$/m);
    expect(developmentBlock).not.toMatch(/^\s{6}tsx:\s*$/m);
  });

  it('starts the same entry as `pnpm start` without going through pnpm or corepack', async () => {
    const [dockerfile, packageText] = await Promise.all([
      read('./docker/Dockerfile'),
      read('../package.json'),
    ]);
    const packageJson = JSON.parse(packageText) as { scripts: Record<string, string> };
    // start script 形如 `tsx <entry>`；CMD 必須直接以 node 執行 tsx 的 cli 並指向同一入口：
    // corepack 的 pnpm 快取是 per-user，uid 10001 沒有 home 目錄，經 pnpm 起手會 EACCES 崩潰。
    const entry = (packageJson.scripts['start'] ?? '').replace(/^tsx\s+/u, '');
    expect(entry).not.toBe('');
    const cmd = dockerfile.match(/^CMD (\[.*\])$/mu)?.[1] ?? '[]';
    const argv = JSON.parse(cmd) as string[];
    expect(argv.slice(0, 3)).toEqual(['node', 'node_modules/tsx/dist/cli.mjs', entry]);
    expect(argv.some((part) => /pnpm|corepack/u.test(part))).toBe(false);
  });

  it('hardens the app container while preserving its writable PVC identity', async () => {
    const deployment = await read('./k8s/deployment.yaml');
    const appContainer = deployment.slice(
      deployment.indexOf('        - name: app'),
      deployment.indexOf('        - name: kubo'),
    );

    expect(deployment).toMatch(
      /securityContext:\s+fsGroup: 10001\s+fsGroupChangePolicy: OnRootMismatch/,
    );
    expect(appContainer).toMatch(/runAsNonRoot: true/);
    expect(appContainer).toMatch(/runAsUser: 10001/);
    expect(appContainer).toMatch(/runAsGroup: 10001/);
    expect(appContainer).toMatch(/allowPrivilegeEscalation: false/);
    expect(appContainer).toMatch(/capabilities:\s+drop:\s+- ALL/);
    expect(appContainer).toMatch(/seccompProfile:\s+type: RuntimeDefault/);
  });

  it('keeps base templates resource-neutral and ships opt-in sizing examples', async () => {
    const [compose, deployment, composeExample, kustomization, resourcePatch] = await Promise.all([
      read('./docker/docker-compose.yml'),
      read('./k8s/deployment.yaml'),
      read('./docker/compose.resources.example.yml'),
      read('./k8s/overlays/sizing-example/kustomization.yaml'),
      read('./k8s/overlays/sizing-example/resources.patch.yaml'),
    ]);

    expect(compose).not.toMatch(/^\s+(?:cpus|mem_limit):/m);
    expect(deployment).not.toMatch(/^\s+resources:/m);
    expect(composeExample).toContain('EXAMPLE ONLY');
    expect(kustomization).toContain('resources.patch.yaml');
    expect(resourcePatch).toContain('EXAMPLE ONLY');
  });

  it('defaults Kubo to explicit peering without public routing in Compose and Kubernetes', async () => {
    const [compose, composeInit, deployment] = await Promise.all([
      read('./docker/docker-compose.yml'),
      read('./docker/kubo-init.d/10-peering.sh'),
      read('./k8s/deployment.yaml'),
    ]);

    expect(compose).toContain('KUBO_ROUTING_TYPE=none');
    expect(deployment).toMatch(/name: KUBO_ROUTING_TYPE\s+value: none/);
    for (const init of [composeInit, deployment]) {
      expect(init).toContain('ipfs config Routing.Type "$KUBO_ROUTING_TYPE"');
      expect(init).toContain('ipfs bootstrap rm --all');
      expect(init).toContain('ipfs config --bool Gateway.NoFetch true');
      expect(init).toContain('ipfs config --json Swarm.ConnMgr.LowWater 16');
      expect(init).toContain('ipfs config --json Swarm.ConnMgr.HighWater 32');
    }
  });

  it('does not expose a generic Kubo gateway and keeps app Bitswap storage ledger-only', async () => {
    const [compose, ingress, service, stores] = await Promise.all([
      read('./docker/docker-compose.yml'),
      read('./k8s/ingress.yaml'),
      read('./k8s/service.yaml'),
      read('../node/stores.ts'),
    ]);

    expect(compose).not.toContain("'8080:8080'");
    expect(ingress).not.toMatch(/path:\s*\/ipfs/);
    expect(service).not.toMatch(/name:\s*gateway/);
    expect(stores).toContain("join(dataDir, 'ledger-blocks')");
    expect(stores).not.toContain("join(dataDir, 'blocks')");
  });

  it('sets the same overridable Kubo StorageMax in Compose and Kubernetes init paths', async () => {
    const [compose, composeInit, deployment] = await Promise.all([
      read('./docker/docker-compose.yml'),
      read('./docker/kubo-init.d/10-peering.sh'),
      read('./k8s/deployment.yaml'),
    ]);

    expect(compose).toContain('KUBO_STORAGE_MAX=${KUBO_STORAGE_MAX:-80GB}');
    expect(deployment).toMatch(/name: KUBO_STORAGE_MAX\s+value: 80GB/);
    for (const init of [composeInit, deployment]) {
      expect(init).toContain('KUBO_STORAGE_MAX="${KUBO_STORAGE_MAX:-80GB}"');
      expect(init).toContain('ipfs config Datastore.StorageMax "$KUBO_STORAGE_MAX"');
    }
  });

  it('documents measurement and the public-routing policy bypass tradeoff', async () => {
    const sizing = await read('./sizing/README.md');
    expect(sizing).toMatch(/docker compose stats/i);
    expect(sizing).toMatch(/kubectl top pod/i);
    expect(sizing).toContain('root-scoped');
    expect(sizing).toContain('public DHT');
  });

  it('ships sustained capacity alerts with minimum scrape samples', async () => {
    const alerts = await read('./monitoring/alerts.yml');
    for (const alert of ['Open4wdPinningKuboStorageHigh', 'Open4wdPinningGlobalQuotaHigh']) {
      expect(alerts).toContain(`alert: ${alert}`);
    }
    expect(alerts.match(/count_over_time/g)).toHaveLength(4);
    expect(alerts.match(/for: 10m/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
