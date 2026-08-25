import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function loadClassifier() {
  try {
    return await import('./image-build-inputs.mjs');
  } catch (error) {
    assert.fail(`image input classifier must be importable: ${String(error)}`);
  }
}

test('documentation and generated graph changes do not publish a new app image', async () => {
  const { classifyImageInputPaths } = await loadClassifier();
  assert.equal(
    classifyImageInputPaths([
      'README.md',
      'docs/badges/license-mit.svg',
      'graphify-out/manifest.json',
      'scripts/workflow.spec.ts',
    ]),
    false,
  );
});

test('every Docker build instruction and copied runtime source publishes a new app image', async () => {
  const { classifyImageInputPaths } = await loadClassifier();
  const imageInputs = [
    '.dockerignore',
    '.github/workflows/cicd.yml',
    'deploy/docker/Dockerfile',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'api/index.ts',
    'app/main.ts',
    'auth/index.ts',
    'config/index.ts',
    'core/index.ts',
    'dmca/index.ts',
    'metrics/index.ts',
    'node/index.ts',
    'pinning/index.ts',
    'subscriber/index.ts',
    'scripts/ledger-genesis.ts',
    'scripts/ledger-genesis-config.ts',
    'scripts/ledger-genesis-receipt.ts',
    'scripts/dmca-export.ts',
  ];

  for (const path of imageInputs) {
    assert.equal(classifyImageInputPaths([path]), true, path);
  }
});

test('Docker-ignored files inside copied directories do not publish a new app image', async () => {
  const { classifyImageInputPaths } = await loadClassifier();
  const ignoredInputs = [
    'app/example.spec.ts',
    'app/example.test.ts',
    'config/config.yaml',
    'app/node_modules/dependency/index.js',
    'app/dist/main.js',
    'app/coverage/coverage.json',
    'app/.env',
    'app/private.pem',
    'app/cache.tsbuildinfo',
    'app/debug.log',
  ];

  for (const path of ignoredInputs) {
    assert.equal(classifyImageInputPaths([path]), false, path);
  }
});

test('git diff classification is fail-safe and sees the removed side of a rename', async () => {
  const { determineImageInputsChanged } = await loadClassifier();
  const root = mkdtempSync(join(tmpdir(), 'open4wd-pinning-image-inputs-'));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

  try {
    git('init');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Open4WD test');
    mkdirSync(join(root, 'app'));
    writeFileSync(join(root, 'README.md'), 'first\n', 'utf8');
    writeFileSync(join(root, 'app', 'main.ts'), 'export {};\n', 'utf8');
    git('add', '.');
    git('commit', '-m', 'initial');
    const initial = git('rev-parse', 'HEAD');

    writeFileSync(join(root, 'README.md'), 'second\n', 'utf8');
    git('add', 'README.md');
    git('commit', '-m', 'docs');
    const docsOnly = git('rev-parse', 'HEAD');
    assert.equal(
      determineImageInputsChanged({ beforeSha: initial, afterSha: docsOnly, repoRoot: root }),
      false,
    );

    mkdirSync(join(root, 'docs'));
    renameSync(join(root, 'app', 'main.ts'), join(root, 'docs', 'main.ts'));
    git('add', '-A');
    git('commit', '-m', 'move runtime source out of image');
    const moved = git('rev-parse', 'HEAD');
    assert.equal(
      determineImageInputsChanged({ beforeSha: docsOnly, afterSha: moved, repoRoot: root }),
      true,
    );

    assert.equal(
      determineImageInputsChanged({ beforeSha: 'not-a-sha', afterSha: moved, repoRoot: root }),
      true,
    );
    assert.equal(
      determineImageInputsChanged({
        beforeSha: 'f'.repeat(40),
        afterSha: moved,
        repoRoot: root,
      }),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
