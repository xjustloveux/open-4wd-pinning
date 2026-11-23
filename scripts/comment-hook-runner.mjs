import { spawnSync } from 'node:child_process';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { inspectCommentQuality, runCommentQuality } from './comment-quality.ts';

const PROFILES = new Set(['maintainer', 'contributor']);
const PRODUCT_ROOTS = new Set([
  'api',
  'app',
  'auth',
  'config',
  'core',
  'dmca',
  'metrics',
  'node',
  'pinning',
  'subscriber',
]);

const gitText = (root, args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout;
};

const validateProfile = (profile) => {
  if (!PROFILES.has(profile)) throw new Error('profile must be maintainer or contributor');
};

const isTarget = (path) => {
  const normalized = path.replace(/\\/gu, '/');
  const segments = normalized.split('/');
  return (
    PRODUCT_ROOTS.has(segments[0]) &&
    extname(normalized) === '.ts' &&
    !segments.some((segment) => segment === 'vendor' || segment === 'generated') &&
    !normalized.endsWith('.d.ts') &&
    !normalized.endsWith('.spec.ts') &&
    !normalized.endsWith('.test-support.ts')
  );
};

/** 以語言中立規則檢查 Git index；兩種 profile 的 Template 行為完全相同。 */
export function runStagedCommentGate({
  root,
  profile,
  write = (line) => globalThis.console.error(line),
}) {
  validateProfile(profile);
  const paths = gitText(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    .split('\0')
    .filter(Boolean);
  let count = 0;
  for (const path of paths) {
    if (!isTarget(path)) continue;
    const text = gitText(root, ['show', `:${path}`]);
    for (const finding of inspectCommentQuality(text, path)) {
      count += 1;
      write(
        `${finding.rule}: ${path}:${finding.line}${finding.detail ? ` — ${finding.detail}` : ''}`,
      );
    }
  }
  return count === 0 ? 0 : 1;
}

/** 執行完整、語言中立的 Template 註解品質掃描。 */
export function runFullCommentGate({ root, profile }) {
  validateProfile(profile);
  const findings = runCommentQuality(root);
  for (const finding of findings) {
    globalThis.console.error(
      `${finding.rule}: ${finding.file}:${finding.line}${finding.detail ? ` — ${finding.detail}` : ''}`,
    );
  }
  globalThis.console.log(`comment-quality: ${findings.length} finding(s)`);
  return findings.length === 0 ? 0 : 1;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const invokedPath =
  globalThis.process.argv[1] === undefined ? '' : pathToFileURL(globalThis.process.argv[1]).href;
if (import.meta.url === invokedPath) {
  try {
    const profile = gitText(root, ['config', '--local', '--get', 'open4wd.commentProfile']).trim();
    globalThis.process.exitCode =
      globalThis.process.argv[2] === 'staged'
        ? runStagedCommentGate({ root, profile })
        : globalThis.process.argv[2] === 'full'
          ? runFullCommentGate({ root, profile })
          : 1;
  } catch (error) {
    globalThis.console.error(error instanceof Error ? error.message : String(error));
    globalThis.process.exitCode = 1;
  }
}
