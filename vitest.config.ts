import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@open4wd/interfaces': source('./core/vendor/interfaces/index.ts'),
      '@open4wd/system-constants': source('./core/vendor/system-constants/index.ts'),
    },
  },
  test: {
    // 整合／e2e 測試各自獨立設定檔管理（pnpm test:integration／pnpm e2e），不進本套件
    exclude: [
      ...configDefaults.exclude,
      '**/*.integration.spec.ts',
      '**/*.e2e.spec.ts',
      'scripts/comment-hook-runner.test.mjs',
      'scripts/eslint-comment-quality.test.mjs',
      'scripts/prepare-graphify-release.test.mjs',
      'scripts/run-graphify-release.test.mjs',
    ],
  },
});
