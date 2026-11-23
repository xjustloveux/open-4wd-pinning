import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ESLint, Linter } from 'eslint';
import rule from './eslint-comment-quality.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const lint = (code) =>
  new Linter().verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
        plugins: { open4wd: { rules: { 'comment-quality': rule } } },
        rules: { 'open4wd/comment-quality': 'error' },
      },
    ],
    { filename: 'core/service.ts' },
  );

test('ESLint reports a missing exported member TSDoc', () => {
  assert.equal(
    lint('/** Service. */\nexport class Service { run() {} }\n')[0]?.ruleId,
    'open4wd/comment-quality',
  );
});

test('Template ESLint accepts English and Traditional Chinese TSDoc', () => {
  assert.deepEqual(lint('/** Service. */\nexport class Service { /** Runs. */ run() {} }\n'), []);
  assert.deepEqual(lint('/** 服務。 */\nexport class Service { /** 執行。 */ run() {} }\n'), []);
});

test('Repo lint excludes only the approved third-party release bundle', async () => {
  const vendorDirectory = join(ROOT, 'scripts', 'vendor');
  const inventory = (await readdir(vendorDirectory)).sort();
  assert.deepEqual(inventory, ['LICENSE-vis-network-MIT.txt', 'vis-network.min.js']);

  const eslint = new ESLint({ cwd: ROOT });
  for (const name of inventory.filter((entry) => entry.endsWith('.js'))) {
    assert.equal(await eslint.isPathIgnored(join(vendorDirectory, name)), true, name);
  }
});
