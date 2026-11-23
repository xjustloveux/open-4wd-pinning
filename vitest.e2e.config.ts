import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@open4wd/interfaces': source('./core/vendor/interfaces/index.ts'),
      '@open4wd/system-constants': source('./core/vendor/system-constants/index.ts'),
    },
  },
  test: {
    // 多節點 in-process e2e，獨立於單元測試套件（pnpm e2e）
    include: ['e2e/**/*.e2e.spec.ts'],
    testTimeout: 60_000,
    environment: 'node',
  },
});
