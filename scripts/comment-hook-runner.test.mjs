import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runStagedCommentGate } from './comment-hook-runner.mjs';
import { configureCommentHooks } from './setup-comment-hooks.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hookNames = ['pre-commit', 'pre-push'];
const ownershipMarker = '# Open4WD 管理的本機註解品質 hook。';
const hookTemplate = (name) => readFileSync(join(projectRoot, '.githooks', name), 'utf8');
const isWindows = globalThis.process.platform === 'win32';

const git = (root, ...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const repository = () => {
  const root = mkdtempSync(join(tmpdir(), 'open4wd-template-hooks-'));
  git(root, 'init', '--quiet');
  mkdirSync(join(root, 'core'), { recursive: true });
  mkdirSync(join(root, '.githooks'), { recursive: true });
  for (const name of hookNames) {
    writeFileSync(join(root, '.githooks', name), hookTemplate(name));
  }
  return root;
};

test('staged gate reads index blobs and ignores unstaged bytes', () => {
  const root = repository();
  const file = join(root, 'core', 'service.ts');
  writeFileSync(file, 'export function run(): void {}\n');
  git(root, 'add', 'core/service.ts');
  writeFileSync(file, '/** Runs the service. */\nexport function run(): void {}\n');
  assert.equal(runStagedCommentGate({ root, profile: 'maintainer', write: () => undefined }), 1);

  git(root, 'add', 'core/service.ts');
  writeFileSync(file, 'export function run(): void {}\n');
  assert.equal(runStagedCommentGate({ root, profile: 'contributor', write: () => undefined }), 0);
});

test('both profiles accept English and Traditional Chinese comments', () => {
  for (const [index, comment] of ['Runs the service.', '執行服務流程。'].entries()) {
    const root = repository();
    writeFileSync(
      join(root, 'core', `service-${index}.ts`),
      `/** ${comment} */\nexport const VALUE = 1;\n`,
    );
    git(root, 'add', `core/service-${index}.ts`);
    assert.equal(runStagedCommentGate({ root, profile: 'maintainer', write: () => undefined }), 0);
    assert.equal(runStagedCommentGate({ root, profile: 'contributor', write: () => undefined }), 0);
  }
});

test('setup materializes executable local hooks and is idempotent', () => {
  const root = repository();
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return git(root, ...args);
  };

  configureCommentHooks({ root, action: 'setup', profile: 'maintainer', runGit: run });
  configureCommentHooks({ root, action: 'setup', profile: 'maintainer', runGit: run });
  assert.throws(() => git(root, 'config', '--local', '--get', 'core.hooksPath'));
  assert.equal(
    git(root, 'config', '--local', '--get', 'open4wd.commentProfile').trim(),
    'maintainer',
  );
  assert.ok(calls.every((args) => args.includes('--local') || args[0] !== 'config'));

  for (const name of hookNames) {
    const hook = join(root, '.git', 'hooks', name);
    assert.equal(readFileSync(hook, 'utf8'), hookTemplate(name));
    if (!isWindows) assert.notEqual(statSync(hook).mode & 0o111, 0);
  }
});

test('setup migrates the legacy owned hooks path', () => {
  const root = repository();
  git(root, 'config', '--local', 'core.hooksPath', '.githooks');

  configureCommentHooks({ root, action: 'setup', profile: 'contributor' });

  assert.throws(() => git(root, 'config', '--local', '--get', 'core.hooksPath'));
  assert.ok(hookNames.every((name) => existsSync(join(root, '.git', 'hooks', name))));
});

test('setup upgrades an older marked Open4WD hook', () => {
  const root = repository();
  const hook = join(root, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, `#!/bin/sh\n${ownershipMarker}\nexit 0\n`);

  configureCommentHooks({ root, action: 'setup', profile: 'maintainer' });

  assert.equal(readFileSync(hook, 'utf8'), hookTemplate('pre-commit'));
});

test('disable removes only marked Open4WD hooks', () => {
  const root = repository();
  configureCommentHooks({ root, action: 'setup', profile: 'maintainer' });
  configureCommentHooks({ root, action: 'disable' });

  assert.ok(hookNames.every((name) => !existsSync(join(root, '.git', 'hooks', name))));
  assert.throws(() => git(root, 'config', '--local', '--get', 'open4wd.commentProfile'));

  configureCommentHooks({ root, action: 'setup', profile: 'maintainer' });
  const modified = join(root, '.git', 'hooks', 'pre-commit');
  writeFileSync(modified, '#!/bin/sh\nexit 0\n');
  assert.throws(() => configureCommentHooks({ root, action: 'disable' }), /pre-commit/u);
  assert.equal(readFileSync(modified, 'utf8'), '#!/bin/sh\nexit 0\n');
  assert.ok(existsSync(join(root, '.git', 'hooks', 'pre-push')));
});

test('setup refuses custom paths and existing non-sample hooks', () => {
  const custom = repository();
  git(custom, 'config', '--local', 'core.hooksPath', 'custom-hooks');
  assert.throws(
    () => configureCommentHooks({ root: custom, action: 'setup', profile: 'maintainer' }),
    /custom-hooks/u,
  );

  const occupied = repository();
  const hook = join(occupied, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 0\n');
  chmodSync(hook, 0o755);
  assert.throws(
    () => configureCommentHooks({ root: occupied, action: 'setup', profile: 'contributor' }),
    /pre-commit/u,
  );
});
