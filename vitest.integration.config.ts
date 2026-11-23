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
    // 打真 kubo／cluster 等外部服務，獨立於單元測試套件（pnpm test:integration）；比照
    // vitest.e2e.config.ts 的 `e2e/**/*.e2e.spec.ts` 風格——資料夾＋副檔名雙重收斂，
    // 避免不小心把其他目錄下同樣以 .integration.spec.ts 結尾的檔案一併掃進來。
    include: ['integration/**/*.integration.spec.ts'],
    // 起真 docker compose 服務（healthcheck 輪詢＋kubo/cluster 冷啟動）比單元測試慢一截，
    // 20s 的單元測試預設值對這裡太緊；docker 不在時 describe.skipIf 直接跳過、用不到這個值，
    // 只有服務真的起得來時才會吃到完整鏈路的等待時間。
    testTimeout: 60_000,
    // beforeAll／afterAll 各自跑一次 `docker compose up -d --wait`／`down --volumes`——
    // 比任何單一 it() 案例都重，給比 testTimeout 更寬的上限（spec 檔對這兩個 hook 另外
    // 傳了明確的逐一 timeout，這裡是它們共用的樓地板值，其餘 hook 若有也適用同一預設）。
    hookTimeout: 120_000,
    environment: 'node',
  },
});
