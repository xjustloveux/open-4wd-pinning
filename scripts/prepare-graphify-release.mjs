import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  buildViewerProjection,
  renderViewerData,
  renderViewerIndex,
  VIEWER_ENGINE,
  VIEWER_THRESHOLD,
} from './graphify-viewer.mjs';

const SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^xjustloveux\/(open-4wd|open-4wd-pinning|open-4wd-signaling|open-4wd-turn)$/u;
const GRAPHIFY_VERSION = '0.9.25';
const ZIP_UTF8 = 0x0800;
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1)
    current = (current & 1) === 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  return current >>> 0;
});
const crc32 = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function zipStore(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    if (entry.bytes.length > 0xffffffff) throw new Error(`ZIP32 member too large: ${entry.name}`);
    const name = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(ZIP_UTF8, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, entry.bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(ZIP_UTF8, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.bytes.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + entry.bytes.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function validatePublicGraph(graph) {
  const forbiddenText = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}/u,
    /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]/u,
    /\/(?:Users|home)\/[^/\s]+/u,
  ];
  const visit = (value) => {
    if (typeof value === 'string') {
      for (const pattern of forbiddenText)
        if (pattern.test(value))
          throw new Error('Graphify graph contains private path or credential-shaped content');
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(graph);
  for (const node of graph.nodes) {
    const source = node?.source_file;
    if (typeof source !== 'string' || source === '') continue;
    const canonical = source.replaceAll('\\', '/');
    if (
      canonical.startsWith('/') ||
      canonical.startsWith('../') ||
      canonical.includes('/../') ||
      canonical
        .split('/')
        .some((segment) => segment === '.git' || segment === '.env' || segment === 'graphify-out')
    )
      throw new Error(`Graphify graph contains a non-public source path: ${source}`);
  }
}

export async function prepareGraphifyRelease({
  graphPath,
  outputDirectory,
  repository,
  sourceSha,
  generatedAt,
}) {
  if (!REPOSITORY.test(repository))
    throw new Error('repository is outside the fixed Open4WD product allowlist');
  const normalizedSha = String(sourceSha).trim().toLowerCase();
  if (!SHA.test(normalizedSha))
    throw new Error('source SHA must be exactly 40 lowercase hexadecimal characters');
  const generated = new Date(generatedAt);
  if (!Number.isFinite(generated.valueOf()) || generated.toISOString() !== generatedAt)
    throw new Error('generatedAt must be a canonical ISO timestamp');
  const graphBytes = await readFile(resolve(graphPath));
  const graph = JSON.parse(graphBytes.toString('utf8'));
  const links = Array.isArray(graph.links) ? graph.links : graph.edges;
  if (!Array.isArray(graph.nodes) || !Array.isArray(links))
    throw new Error('Graphify graph must contain nodes and links/edges arrays');
  validatePublicGraph(graph);
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length > 0) throw new Error('Graphify release output must be empty');
  const projection = buildViewerProjection({ repository, nodes: graph.nodes, edges: links });
  const indexBytes = renderViewerIndex({
    repository,
    nodeCount: graph.nodes.length,
    edgeCount: links.length,
    mode: projection.mode,
  });
  const viewerDataBytes = renderViewerData(projection);
  const visNetworkBytes = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'vendor', 'vis-network.min.js'),
  );
  if (!visNetworkBytes.subarray(0, 1_024).toString('utf8').includes('@version 9.1.6'))
    throw new Error('vendored vis-network asset does not match viewer engine 9.1.6');
  const siteZip = zipStore([
    { name: 'graph.json', bytes: graphBytes },
    { name: 'index.html', bytes: indexBytes },
    { name: 'viewer-data.js', bytes: viewerDataBytes },
    { name: 'vis-network.min.js', bytes: visNetworkBytes },
  ]);
  await writeFile(join(output, 'graphify-site.zip'), siteZip);
  const manifest = {
    schemaVersion: 1,
    repository,
    sourceSha: normalizedSha,
    tag: `graphify-${normalizedSha.slice(0, 12)}`,
    graphifyVersion: GRAPHIFY_VERSION,
    generatedAt,
    graph: { nodes: graph.nodes.length, edges: links.length },
    viewer: {
      mode: projection.mode,
      threshold: VIEWER_THRESHOLD,
      engine: VIEWER_ENGINE,
      data: 'viewer-data.js',
    },
    assets: [{ name: 'graphify-site.zip', size: siteZip.length, sha256: sha256(siteZip) }],
  };
  await writeFile(join(output, 'graphify-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : args[index + 1];
  };
  const explicitSourceSha = option('--source-sha', null);
  const sourceSha =
    explicitSourceSha ??
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const explicitGeneratedAt = option('--generated-at', null);
  const generatedAt =
    explicitGeneratedAt ??
    execFileSync('git', ['show', '-s', '--format=%cI', sourceSha], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  const manifest = await prepareGraphifyRelease({
    graphPath: option('--graph', join(root, 'graphify-out', 'graph.json')),
    outputDirectory: option('--output', join(root, 'graphify-release')),
    repository: option('--repository', process.env.GITHUB_REPOSITORY),
    sourceSha,
    generatedAt: new Date(generatedAt).toISOString(),
  });
  console.log(JSON.stringify(manifest));
}
