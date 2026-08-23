import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PINNED_PACKAGES } from './vendor-contract';
import { runVendorCheck } from './vendor-check-runner';

afterEach(() => {
  vi.restoreAllMocks();
});

async function selfContainedFixture(ownVersion = '1.2.3') {
  const repoRoot = join(tmpdir(), `open4wd-pinning-contract-${randomUUID()}`);
  const vendorRoot = join(repoRoot, 'core', 'vendor');
  await mkdir(join(vendorRoot, 'ledger'), { recursive: true });
  await mkdir(join(repoRoot, 'scripts'), { recursive: true });
  const bytes = Buffer.from('vendored bytes');
  const semanticPackages = Object.fromEntries(PINNED_PACKAGES.map((name) => [name, '^1.2.3']));
  await writeFile(
    join(repoRoot, 'scripts', 'vendor-list.json'),
    JSON.stringify({
      upstreamRoot: 'missing-main/src',
      targetRoot: 'core/vendor',
      files: ['ledger/example.ts'],
    }),
  );
  await writeFile(
    join(vendorRoot, 'MANIFEST.json'),
    JSON.stringify({
      schemaVersion: 1,
      upstreamRepo: 'xjustloveux/open-4wd',
      semanticPackages,
      files: [
        {
          path: 'ledger/example.ts',
          upstream: 'src/ledger/example.ts',
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    }),
  );
  await writeFile(join(vendorRoot, 'ledger', 'example.ts'), bytes);
  await writeFile(
    join(repoRoot, 'package.json'),
    JSON.stringify({
      dependencies: Object.fromEntries(PINNED_PACKAGES.map((name) => [name, ownVersion])),
    }),
  );
  return repoRoot;
}

describe('pinning vendor checker remote diagnostics', () => {
  it('CI local-only validates package versions from MANIFEST without a main checkout', async () => {
    const repoRoot = await selfContainedFixture();

    await expect(
      runVendorCheck({ argv: ['--local-only'], env: { CI: 'true' }, repoRoot }),
    ).resolves.toBe(0);
  });

  it('CI local-only still fails when an installed semantic package differs from MANIFEST', async () => {
    const repoRoot = await selfContainedFixture('9.9.9');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      runVendorCheck({ argv: ['--local-only'], env: { CI: 'true' }, repoRoot }),
    ).resolves.toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('套件同版斷言失敗');
  });
  it('CI reports HTTP status and URL without reading or printing the response body', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const text = vi.fn(async () => 'PRIVATE_RESPONSE_BODY');
    const fetchFn = vi.fn(
      async () =>
        ({ ok: false, status: 429, statusText: 'Too Many Requests', text }) as unknown as Response,
    );

    await expect(
      runVendorCheck({ argv: [], fetchFn: fetchFn as typeof fetch, env: { CI: 'true' } }),
    ).resolves.toBe(1);

    const output = error.mock.calls.flat().join('\n');
    expect(output).toContain('HTTP 429');
    expect(output).toContain('raw.githubusercontent.com');
    expect(output).not.toContain('PRIVATE_RESPONSE_BODY');
    expect(text).not.toHaveBeenCalled();
  });

  it('non-CI reports safe network code without leaking raw exception messages', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchFn = vi.fn(async () => {
      throw Object.assign(new TypeError('timeout SECRET_AUTHORIZATION'), { code: 'ETIMEDOUT' });
    });

    await expect(
      runVendorCheck({ argv: [], fetchFn: fetchFn as typeof fetch, env: { CI: 'false' } }),
    ).resolves.toBe(0);

    const output = warn.mock.calls.flat().join('\n');
    expect(output).toContain('ETIMEDOUT');
    expect(output).not.toContain('SECRET_AUTHORIZATION');
  });

  it('local-only mode performs zero upstream requests while retaining local checks', async () => {
    const repoRoot = await selfContainedFixture();
    const fetchFn = vi.fn();

    await expect(
      runVendorCheck({
        argv: ['--local-only'],
        fetchFn: fetchFn as typeof fetch,
        env: {},
        repoRoot,
      }),
    ).resolves.toBe(0);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('local-only compares every file with a sibling upstream when present', async () => {
    const repoRoot = await selfContainedFixture();
    const upstream = join(repoRoot, 'missing-main', 'src', 'ledger');
    await mkdir(upstream, { recursive: true });
    await writeFile(join(upstream, 'example.ts'), 'different upstream bytes');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      runVendorCheck({ argv: ['--local-only'], env: { CI: 'true' }, repoRoot }),
    ).resolves.toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('本機 upstream 漂移');
  });
});
