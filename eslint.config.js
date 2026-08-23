// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import commentQualityRule from './scripts/eslint-comment-quality.mjs';

// core/vendor/** 為逐字 vendored 檔（禁止手改，見 MANIFEST.json 的 hash 檢查），
// 故排除在本 repo 的 lint 規則之外；vendored 檔本身的風格由上游負責。
export default tseslint.config(
  { ignores: ['core/vendor/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  tseslint.configs.stylistic,
  prettier,
  {
    files: [
      'api/**/*.ts',
      'app/**/*.ts',
      'auth/**/*.ts',
      'config/**/*.ts',
      'core/**/*.ts',
      'dmca/**/*.ts',
      'metrics/**/*.ts',
      'node/**/*.ts',
      'pinning/**/*.ts',
      'subscriber/**/*.ts',
    ],
    ignores: [
      '**/*.spec.ts',
      '**/*.d.ts',
      '**/vendor/**',
      '**/generated/**',
      '**/*.test-support.ts',
    ],
    plugins: { open4wd: { rules: { 'comment-quality': commentQualityRule } } },
    rules: { 'open4wd/comment-quality': 'error' },
  },
);
