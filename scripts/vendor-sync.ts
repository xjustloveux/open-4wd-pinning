import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncVendor } from './vendor-sync-runner';

export { syncVendor } from './vendor-sync-runner';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const upstreamRoot = resolve(repoRoot, process.env['OPEN4WD_UPSTREAM_ROOT'] ?? '../open-4wd/src');
  try {
    const result = await syncVendor({ repoRoot, upstreamRoot });
    console.log(`${result.copied} files copied, MANIFEST written`);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : 'vendor sync failed');
    process.exitCode = 1;
  }
}
