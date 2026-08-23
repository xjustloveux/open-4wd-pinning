import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { selectViewerMode } from './graphify-viewer.mjs';
import { prepareGraphifyRelease } from './prepare-graphify-release.mjs';

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';

function readStoredZip(bytes) {
  const members = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8);
    assert.equal(method, 0, 'release fixture reader expects deterministic stored ZIP members');
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString('utf8');
    members.set(name, bytes.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return members;
}

test('selects full and community drill modes at the shared threshold', () => {
  assert.equal(selectViewerMode(5_000), 'full');
  assert.equal(selectViewerMode(5_001), 'community-drill');
});

test('builds deterministic public Graphify release assets', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'open4wd-graphify-release-'));
  const graphPath = join(temporary, 'graph.json');
  await writeFile(graphPath, JSON.stringify({ nodes: [{ id: 'a' }], links: [] }));
  const outputs = [join(temporary, 'one'), join(temporary, 'two')];
  const manifests = [];
  for (const outputDirectory of outputs) {
    manifests.push(
      await prepareGraphifyRelease({
        graphPath,
        outputDirectory,
        repository: 'xjustloveux/open-4wd-pinning',
        sourceSha: SHA,
        generatedAt: '2026-08-18T00:00:00.000Z',
      }),
    );
  }
  assert.deepEqual(manifests[0], manifests[1]);
  for (const name of ['graphify-manifest.json', 'graphify-site.zip']) {
    assert.deepEqual(
      await readFile(join(outputs[0], name)),
      await readFile(join(outputs[1], name)),
    );
  }
});

test('packages a direct-file interactive viewer and declares manifest schema v2', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'open4wd-graphify-viewer-'));
  const graphPath = join(temporary, 'graph.json');
  await writeFile(
    graphPath,
    JSON.stringify({
      nodes: [
        { id: 'a', label: 'Alpha', type: 'concept', community: 7 },
        { id: 'b', label: 'Beta', type: 'function', community: 7 },
      ],
      links: [{ source: 'a', target: 'b', type: 'calls' }],
    }),
  );
  const outputDirectory = join(temporary, 'output');
  const manifest = await prepareGraphifyRelease({
    graphPath,
    outputDirectory,
    repository: 'xjustloveux/open-4wd-pinning',
    sourceSha: SHA,
    generatedAt: '2026-08-18T00:00:00.000Z',
  });
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.viewer, {
    mode: 'full',
    threshold: 5_000,
    engine: 'vis-network-9.1.6',
    data: 'viewer-data.js',
  });
  const members = readStoredZip(await readFile(join(outputDirectory, 'graphify-site.zip')));
  assert.deepEqual([...members.keys()].sort(), [
    'graph.json',
    'index.html',
    'viewer-data.js',
    'vis-network.min.js',
  ]);
  const html = members.get('index.html').toString('utf8');
  assert.match(html, /<div[^>]+id="graph"/u);
  assert.match(html, /<script src="vis-network\.min\.js"><\/script>/u);
  assert.match(html, /new vis\.Network/u);
  assert.match(html, /forceAtlas2Based/u);
  assert.match(html, /network\.on\('click'/u);
  assert.match(html, /viewer-data\.js/u);
  assert.match(html, /data-action="back"/u);
  assert.doesNotMatch(html, /fetch\(|nodes\.slice\(0,\s*200\)|https?:\/\//u);
  assert.match(members.get('vis-network.min.js').toString('utf8'), /@version 9\.1\.6/u);
  const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)];
  assert.equal(inlineScripts.length, 1);
  assert.doesNotThrow(() => Function(inlineScripts[0][1]));
  const data = members.get('viewer-data.js').toString('utf8');
  assert.match(data, /^window\.__OPEN4WD_GRAPH__=/u);
  assert.match(data, /"Alpha"/u);
  assert.match(data, /"calls"/u);
});

test('rejects private source paths before publishing', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'open4wd-graphify-private-'));
  const graphPath = join(temporary, 'graph.json');
  await writeFile(
    graphPath,
    JSON.stringify({
      nodes: [{ id: 'secret', source_file: 'C:\\Users\\maintainer\\private.ts' }],
      links: [],
    }),
  );
  await assert.rejects(
    prepareGraphifyRelease({
      graphPath,
      outputDirectory: join(temporary, 'output'),
      repository: 'xjustloveux/open-4wd-pinning',
      sourceSha: SHA,
      generatedAt: '2026-08-18T00:00:00.000Z',
    }),
    /private path|non-public source path/u,
  );
});
