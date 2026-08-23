import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { prepareGraphifyRelease } from './prepare-graphify-release.mjs';

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';

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
