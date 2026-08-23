import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchVendorText, formatRemoteFailures, type RemoteFailure } from './vendor-remote';
import { auditVendorImportClosure, type VendorClosureSource } from './vendor-closure';
import { normalizeSemanticVersion, PINNED_PACKAGES, type VendorManifest } from './vendor-contract';

interface VendorList {
  upstreamRoot: string;
  targetRoot: string;
  files: string[];
}
interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const UPSTREAM_REPO = 'xjustloveux/open-4wd';
const UPSTREAM_BRANCH = 'master';
const defaultRepoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

export interface RunVendorCheckOptions {
  readonly argv: readonly string[];
  readonly fetchFn?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly repoRoot?: string;
}

export async function runVendorCheck(options: RunVendorCheckOptions): Promise<number> {
  const fetchFn = options.fetchFn ?? fetch;
  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const localOnly = options.argv.includes('--local-only');
  const list = JSON.parse(
    await readFile(join(repoRoot, 'scripts', 'vendor-list.json'), 'utf8'),
  ) as VendorList;
  const vendorDir = join(repoRoot, list.targetRoot);
  const manifest = JSON.parse(
    await readFile(join(vendorDir, 'MANIFEST.json'), 'utf8'),
  ) as VendorManifest;
  const failures: string[] = [];
  const remoteFailures: RemoteFailure[] = [];
  const isCi = env['CI'] === 'true';
  const listedPaths = [...list.files].sort();
  const manifestPaths = manifest.files.map(({ path }) => path).sort();
  if (
    new Set(list.files).size !== list.files.length ||
    new Set(manifestPaths).size !== manifestPaths.length ||
    JSON.stringify(listedPaths) !== JSON.stringify(manifestPaths)
  )
    failures.push('vendor-list.json 與 MANIFEST files 必須形成相同且無重複的 exact set');

  const vendorSources: VendorClosureSource[] = [];
  for (const entry of manifest.files) {
    const local = await readFile(join(vendorDir, entry.path));
    if (sha256(local) !== entry.sha256) {
      failures.push(
        `本地完整性失敗：${entry.path}（vendored 檔不得手改，或需重跑 pnpm vendor:sync）`,
      );
    }
    vendorSources.push({ path: entry.path, text: local.toString('utf8') });
  }
  for (const failure of auditVendorImportClosure(vendorSources))
    failures.push(`vendored import 閉包失敗：${failure}`);

  const ownPkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as PackageJson;
  if (manifest.schemaVersion !== 1 || manifest.upstreamRepo !== UPSTREAM_REPO) {
    failures.push('vendored MANIFEST 缺少有效的 schemaVersion=1／upstreamRepo 契約');
  }
  for (const name of PINNED_PACKAGES) {
    const upstreamVersion = manifest.semanticPackages?.[name];
    const ownVersion = ownPkg.dependencies?.[name] ?? ownPkg.devDependencies?.[name];
    if (upstreamVersion === undefined) {
      failures.push(`套件同版斷言失敗：${name} 不在 vendored MANIFEST semanticPackages`);
    } else if (ownVersion === undefined) {
      failures.push(`套件同版斷言失敗：${name} 未安裝於本 repo（同步契約＝${upstreamVersion}）`);
    } else if (normalizeSemanticVersion(ownVersion) !== normalizeSemanticVersion(upstreamVersion)) {
      failures.push(
        `套件同版斷言失敗：${name} 本 repo＝${ownVersion}，同步契約＝${upstreamVersion}（帳本語意套件必須同版）`,
      );
    }
  }

  if (!localOnly) {
    const rawBase = `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_BRANCH}`;
    for (const entry of manifest.files) {
      const rawUrl = `${rawBase}/${entry.upstream}`;
      const remote = await fetchVendorText(fetchFn, rawUrl);
      if (!remote.ok) {
        remoteFailures.push(remote.failure);
      } else if (sha256(remote.text) !== entry.sha256) {
        failures.push(`上游漂移：${entry.path} 與 ${entry.upstream} 不一致`);
      }
    }
  }
  if (localOnly) {
    const upstreamRoot = join(repoRoot, list.upstreamRoot);
    if (!existsSync(upstreamRoot)) {
      console.log(`本機 upstream 不存在，略過 sibling parity：${list.upstreamRoot}`);
    } else {
      for (const entry of manifest.files) {
        const upstreamPath = join(upstreamRoot, entry.path);
        if (!existsSync(upstreamPath)) {
          failures.push(`本機 upstream 缺檔：${entry.path}`);
          continue;
        }
        const upstream = await readFile(upstreamPath);
        if (sha256(upstream) !== entry.sha256)
          failures.push(`本機 upstream 漂移：${entry.path} 與 vendored MANIFEST 不一致`);
      }
    }
  }

  if (remoteFailures.length > 0) {
    const message = `${remoteFailures.length} 個檔案無法取得上游原檔\n${formatRemoteFailures(remoteFailures)}`;
    if (isCi) failures.push(`${message}\n（CI 環境視為失敗）`);
    else console.warn(`警告：${message}\n已跳過上游比對`);
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    return 1;
  }
  console.log('vendored 檢查通過');
  return 0;
}
