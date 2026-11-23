import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertCacheOnlyExtraction,
  assertNativeCachePreflight,
  assertTrackedPromptCacheCoverage,
  buildGraphifyInvocations,
  findMissingPromptCacheEntries,
} from './run-graphify-release.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('pins complete extraction to a keyless loopback backend', () => {
  const invocation = buildGraphifyInvocations({
    python: 'python3',
    inheritedEnvironment: {
      PATH: '/bin',
      OPENAI_API_KEY: 'must-not-leak',
      ANTHROPIC_API_KEY: 'must-not-leak',
    },
  });
  assert.equal(invocation.command, 'python3');
  assert.deepEqual(invocation.extractArgs, [
    '-m',
    'graphify',
    'extract',
    '.',
    '--backend',
    'ollama',
  ]);
  assert.deepEqual(invocation.clusterArgs, [
    '-m',
    'graphify',
    'cluster-only',
    '.',
    '--no-label',
    '--no-viz',
  ]);
  assert.equal(invocation.environment.OLLAMA_BASE_URL, 'http://127.0.0.1:9');
  assert.equal(invocation.environment.OPENAI_API_KEY, undefined);
  assert.equal(invocation.environment.ANTHROPIC_API_KEY, undefined);
  assert.match(invocation.preflightArgs[1], /ls-files.*--exclude-standard/su);
  assert.doesNotMatch(invocation.extractArgs.join(' '), /--code-only|--no-cluster/u);
});

test('accepts only an all-hit semantic replay with a written graph', () => {
  assert.doesNotThrow(() =>
    assertCacheOnlyExtraction(`
[graphify extract] semantic cache: 18 hit / 0 miss
[graphify extract] wrote /work/graphify-out/graph.json: 928 nodes, 1970 edges, 50 communities
`),
  );
  assert.throws(
    () =>
      assertCacheOnlyExtraction(`
[graphify extract] semantic cache: 17 hit / 1 miss
[graphify extract] semantic extraction on 1 files via ollama...
`),
    /cache miss/u,
  );
  assert.throws(
    () => assertCacheOnlyExtraction('[graphify extract] AST extraction on 112 code files...'),
    /cache summary/u,
  );
  assert.throws(
    () => assertCacheOnlyExtraction('[graphify extract] semantic cache: 18 hit / 0 miss'),
    /graph\.json/u,
  );
});

test('requires exact current-profile cache coverage before Graphify extraction', () => {
  assert.deepEqual(
    findMissingPromptCacheEntries({
      promptFingerprint: 'f33081f95084',
      sourceHashes: new Map([['deploy/docker/docker-compose.yml', 'content-hash']]),
      namespaceHashes: new Map([
        ['pd5fd89c46bb5', new Set(['content-hash'])],
        ['pf33081f95084', new Set()],
      ]),
    }),
    ['deploy/docker/docker-compose.yml'],
  );
  const coverage = assertTrackedPromptCacheCoverage({ cwd: REPOSITORY_ROOT });
  assert.equal(coverage.promptFingerprint, 'f33081f95084');
  assert.deepEqual(coverage.missing, []);
  assert.doesNotThrow(() =>
    assertNativeCachePreflight(
      'GRAPHIFY_CACHE_PREFLIGHT={"version":"0.9.25","promptFingerprint":"f33081f95084","hits":4,"misses":0,"missing":[]}',
    ),
  );
  assert.throws(
    () =>
      assertNativeCachePreflight(
        'GRAPHIFY_CACHE_PREFLIGHT={"version":"0.9.25","promptFingerprint":"f33081f95084","hits":2,"misses":2,"missing":["deploy/docker/docker-compose.yml","deploy/docker/docker-compose.all-in-one.yml"]}',
      ),
    /docker-compose\.yml.*docker-compose\.all-in-one\.yml/u,
  );
});
