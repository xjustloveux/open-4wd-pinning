import { access, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const source = (path: string): Promise<string> => readFile(new URL(path, root), 'utf8');

describe('pinning maintainability contracts', () => {
  it('keeps deploy TypeScript inside the main typecheck', async () => {
    const config = JSON.parse(await source('tsconfig.json')) as { exclude?: string[] };
    expect(config.exclude ?? []).not.toContain('deploy');
  });

  it('provides node and DMCA barrels for external consumers', async () => {
    await expect(access(new URL('node/index.ts', root))).resolves.toBeUndefined();
    const [dmcaExport, config, main, genesis] = await Promise.all([
      source('scripts/dmca-export.ts'),
      source('config/load.ts'),
      source('app/main.ts'),
      source('scripts/ledger-genesis.ts'),
    ]);
    expect(dmcaExport).not.toMatch(/from ['"]\.\.\/dmca\//u);
    expect(config).not.toMatch(/from ['"]\.\.\/api\//u);
    expect(main).not.toMatch(/from ['"]\.\.\/node\//u);
    expect(genesis).not.toMatch(/from ['"]\.\.\/node\//u);
  });

  it('defines the notice payload guard once and shares it', async () => {
    const [service, store, types] = await Promise.all([
      source('dmca/service.ts'),
      source('dmca/store.ts'),
      source('dmca/types.ts'),
    ]);
    expect([service, store, types].join('\n').match(/function isNoticePayload/g)).toHaveLength(1);
  });

  it('workflow tests resolve files from import.meta.url instead of process CWD', async () => {
    const workflowSpec = await source('scripts/workflow.spec.ts');
    expect(workflowSpec).toContain('new URL(');
    expect(workflowSpec).not.toContain("readFile('.github/");
  });

  it('pins the Docker base image to a complete registry digest', async () => {
    const dockerfile = await source('deploy/docker/Dockerfile');
    expect(dockerfile).toMatch(/^FROM node:24-alpine@sha256:[0-9a-f]{64}$/mu);
  });
});
