import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PINNED_PACKAGES } from './vendor-contract';
import { syncVendor } from './vendor-sync-runner';

async function fixture(omitPackage?: string) {
  const root = join(tmpdir(), `open4wd-pinning-sync-${randomUUID()}`);
  const repoRoot = join(root, 'pinning');
  const upstreamRoot = join(root, 'main', 'src');
  const vendorRoot = join(repoRoot, 'core', 'vendor');
  await mkdir(join(upstreamRoot, 'ledger'), { recursive: true });
  await mkdir(join(vendorRoot, 'ledger'), { recursive: true });
  await mkdir(join(repoRoot, 'scripts'), { recursive: true });
  const packages = Object.fromEntries(
    PINNED_PACKAGES.filter((name) => name !== omitPackage).map((name) => [name, '^1.2.3']),
  );
  await writeFile(join(root, 'main', 'package.json'), JSON.stringify({ dependencies: packages }));
  await writeFile(join(upstreamRoot, 'ledger', 'example.ts'), 'new source');
  await writeFile(join(vendorRoot, 'ledger', 'example.ts'), 'old target');
  await writeFile(
    join(vendorRoot, 'MANIFEST.json'),
    JSON.stringify({
      files: [{ path: 'ledger/example.ts', upstream: 'src/ledger/example.ts', sha256: 'old' }],
    }),
  );
  await writeFile(
    join(repoRoot, 'scripts', 'vendor-list.json'),
    JSON.stringify({
      upstreamRoot: '../main/src',
      targetRoot: 'core/vendor',
      files: ['ledger/example.ts'],
    }),
  );
  return { repoRoot, upstreamRoot, vendorRoot };
}

describe('pinning vendor sync semantic package contract', () => {
  it('writes the upstream package declarations used by the same sync', async () => {
    const paths = await fixture();

    await syncVendor(paths);

    const manifest = JSON.parse(await readFile(join(paths.vendorRoot, 'MANIFEST.json'), 'utf8'));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.upstreamRepo).toBe('xjustloveux/open-4wd');
    expect(manifest.semanticPackages).toEqual(
      Object.fromEntries(PINNED_PACKAGES.map((name) => [name, '^1.2.3'])),
    );
  });

  it('rejects a missing semantic package before changing targets or MANIFEST', async () => {
    const paths = await fixture(PINNED_PACKAGES[0]);
    const beforeTarget = await readFile(join(paths.vendorRoot, 'ledger', 'example.ts'));
    const beforeManifest = await readFile(join(paths.vendorRoot, 'MANIFEST.json'));

    await expect(syncVendor(paths)).rejects.toThrow(PINNED_PACKAGES[0]);
    expect(await readFile(join(paths.vendorRoot, 'ledger', 'example.ts'))).toEqual(beforeTarget);
    expect(await readFile(join(paths.vendorRoot, 'MANIFEST.json'))).toEqual(beforeManifest);
  });

  it('rejects an import type outside the source list before changing targets or MANIFEST', async () => {
    const paths = await fixture();
    const beforeTarget = await readFile(join(paths.vendorRoot, 'ledger', 'example.ts'));
    const beforeManifest = await readFile(join(paths.vendorRoot, 'MANIFEST.json'));
    await writeFile(
      join(paths.upstreamRoot, 'ledger', 'example.ts'),
      "type Missing = import('./missing').Missing;\nexport const value: Missing | null = null;\n",
    );

    await expect(syncVendor(paths)).rejects.toThrow('import 閉包不完整');
    expect(await readFile(join(paths.vendorRoot, 'ledger', 'example.ts'))).toEqual(beforeTarget);
    expect(await readFile(join(paths.vendorRoot, 'MANIFEST.json'))).toEqual(beforeManifest);
  });
});
