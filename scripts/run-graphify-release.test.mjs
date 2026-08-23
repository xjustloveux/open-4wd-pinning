import assert from 'node:assert/strict';
import test from 'node:test';

import { assertCacheOnlyExtraction, buildGraphifyInvocations } from './run-graphify-release.mjs';

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
