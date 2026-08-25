import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const exactImageInputs = new Set([
  '.dockerignore',
  '.github/workflows/cicd.yml',
  'deploy/docker/Dockerfile',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'scripts/ledger-genesis.ts',
  'scripts/ledger-genesis-config.ts',
  'scripts/ledger-genesis-receipt.ts',
  'scripts/dmca-export.ts',
]);

const copiedDirectoryPrefixes = [
  'api/',
  'app/',
  'auth/',
  'config/',
  'core/',
  'dmca/',
  'metrics/',
  'node/',
  'pinning/',
  'subscriber/',
];

const ignoredDirectoryNames = new Set([
  'node_modules',
  '.git',
  '.github',
  '.superpowers',
  '.agents',
  '.claude',
  'docs',
  'integration',
  'e2e',
  'deploy',
  'graphify-out',
  'data',
  'dist',
  'coverage',
  '.idea',
  '.vscode',
]);

function normalizePath(path) {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function isDockerIgnored(path) {
  const segments = path.split('/');
  const basename = segments.at(-1) ?? '';

  if (segments.some((segment) => ignoredDirectoryNames.has(segment))) return true;
  if (path === 'config/config.yaml') return true;
  if (/\.(?:spec|test)\.ts$/u.test(basename)) return true;
  if (basename === '.env' || basename.startsWith('.env.')) return true;
  if (/^dmca-export-.*\.bin$/u.test(basename)) return true;
  if (/\.(?:pem|key|p12|pfx|tsbuildinfo|log)$/u.test(basename)) return true;
  return ['kubeconfig', '.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(basename);
}

export function classifyImageInputPaths(paths) {
  return paths.some((candidate) => {
    const path = normalizePath(candidate);
    if (exactImageInputs.has(path)) return true;
    if (isDockerIgnored(path)) return false;
    return copiedDirectoryPrefixes.some((prefix) => path.startsWith(prefix));
  });
}

function isCommitSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/iu.test(value) && !/^0+$/u.test(value);
}

export function determineImageInputsChanged({ beforeSha, afterSha, repoRoot }) {
  if (!isCommitSha(beforeSha) || !isCommitSha(afterSha)) return true;

  try {
    const output = execFileSync(
      'git',
      [
        'diff',
        '--name-only',
        '--no-renames',
        '-z',
        '--diff-filter=ACDMRTUXB',
        beforeSha,
        afterSha,
        '--',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return classifyImageInputPaths(output.split('\0').filter(Boolean));
  } catch (error) {
    console.warn(`Unable to classify image inputs safely; publishing the image: ${String(error)}`);
    return true;
  }
}

function main() {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const changed = determineImageInputsChanged({
    beforeSha: process.env.BEFORE_SHA,
    afterSha: process.env.AFTER_SHA,
    repoRoot,
  });
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('GITHUB_OUTPUT is required');
  appendFileSync(outputPath, `changed=${String(changed)}\n`, 'utf8');
  console.log(
    changed
      ? 'App image inputs changed; publication is required.'
      : 'App image inputs are unchanged; publication is skipped.',
  );
}

const invokedPath = process.argv[1] === undefined ? '' : pathToFileURL(process.argv[1]).href;
if (import.meta.url === invokedPath) main();
