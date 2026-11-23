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
    // 限制同時 fork 數為 8：預設約為核心數減一（32 核即約 31 個），各 fork 同時載入 libp2p／helia 等重模組，
    // 資源壓力下 fork 會被系統結束而出現 Worker exited unexpectedly（001116，連跑 5 次崩 2 次）
    maxWorkers: 8,
    // 整合／e2e 測試各自獨立設定檔管理（pnpm test:integration／pnpm e2e），不進本套件
    exclude: [
      ...configDefaults.exclude,
      '**/*.integration.spec.ts',
      '**/*.e2e.spec.ts',
      'scripts/comment-hook-runner.test.mjs',
      'scripts/eslint-comment-quality.test.mjs',
      'scripts/image-build-inputs.test.mjs',
      'scripts/issue-maintenance.test.mjs',
      'scripts/prepare-graphify-release.test.mjs',
      'scripts/run-graphify-release.test.mjs',
    ],
  },
});
