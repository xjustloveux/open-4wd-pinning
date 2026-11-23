import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { auditVendorImportClosure } from './vendor-closure';
import { PINNED_PACKAGES, type VendorManifestEntry, type VendorManifest } from './vendor-contract';

interface VendorList {
  upstreamRoot: string;
  targetRoot: string;
  files: string[];
}
interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface SyncVendorOptions {
  readonly repoRoot: string;
  readonly upstreamRoot: string;
}

export async function syncVendor(
  options: SyncVendorOptions,
): Promise<{ copied: number; manifestPath: string }> {
  const list = JSON.parse(
    await readFile(join(options.repoRoot, 'scripts', 'vendor-list.json'), 'utf8'),
  ) as VendorList;
  const targetRoot = join(options.repoRoot, list.targetRoot);
  const mainPackagePath = join(dirname(options.upstreamRoot), 'package.json');
  const missingFiles = list.files.filter(
    (relativePath) => !existsSync(join(options.upstreamRoot, relativePath)),
  );
  if (!existsSync(mainPackagePath)) missingFiles.push('../package.json');
  if (missingFiles.length > 0) {
    throw new Error(`閉包缺檔：${missingFiles.join(', ')}；中止同步且未寫入任何檔案`);
  }

  const mainPackage = JSON.parse(await readFile(mainPackagePath, 'utf8')) as PackageJson;
  const semanticPackages: Record<string, string> = {};
  const missingPackages: string[] = [];
  for (const name of PINNED_PACKAGES) {
    const version = mainPackage.dependencies?.[name] ?? mainPackage.devDependencies?.[name];
    if (version === undefined) missingPackages.push(name);
    else semanticPackages[name] = version;
  }
  if (missingPackages.length > 0) {
    throw new Error(
      `主 repo package.json 缺少語意套件：${missingPackages.join(', ')}；中止同步且未寫入任何檔案`,
    );
  }

  const sources = await Promise.all(
    list.files.map(async (relativePath) => ({
      relativePath,
      bytes: await readFile(join(options.upstreamRoot, relativePath)),
    })),
  );
  const closureFailures = auditVendorImportClosure(
    sources.map(({ relativePath, bytes }) => ({
      path: relativePath,
      text: bytes.toString('utf8'),
    })),
  );
  if (closureFailures.length > 0)
    throw new Error(
      `來源清單 import 閉包不完整：${closureFailures.join(', ')}；中止同步且未寫入任何檔案`,
    );
  const entries: VendorManifestEntry[] = [];
  for (const source of sources) {
    const destination = join(targetRoot, source.relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, source.bytes);
    entries.push({
      path: source.relativePath,
      upstream: `src/${source.relativePath}`,
      sha256: createHash('sha256').update(source.bytes).digest('hex'),
    });
  }

  const manifest: VendorManifest = {
    schemaVersion: 1,
    upstreamRepo: 'xjustloveux/open-4wd',
    semanticPackages,
    files: entries,
  };
  const manifestPath = join(targetRoot, 'MANIFEST.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { copied: entries.length, manifestPath };
}
