import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVendorCheck } from './vendor-check-runner';

export { runVendorCheck } from './vendor-check-runner';

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await runVendorCheck({ argv: process.argv.slice(2) });
}
