import assert from 'node:assert/strict';
import test from 'node:test';

import { Linter } from 'eslint';
import rule from './eslint-comment-quality.mjs';

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
