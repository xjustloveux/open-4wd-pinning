import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_ENVIRONMENT_KEYS = [
  'ANTHROPIC_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'MOONSHOT_API_KEY',
  'OPENAI_API_KEY',
  'OLLAMA_HOST',
];

export function buildGraphifyInvocations({
  python = process.env.PYTHON ?? 'python',
  inheritedEnvironment = process.env,
} = {}) {
  const environment = { ...inheritedEnvironment };
  for (const name of MODEL_ENVIRONMENT_KEYS) delete environment[name];
  environment.OLLAMA_BASE_URL = 'http://127.0.0.1:9';
  environment.PYTHONNOUSERSITE = '1';
  return {
    command: python,
    extractArgs: ['-m', 'graphify', 'extract', '.', '--backend', 'ollama'],
    clusterArgs: ['-m', 'graphify', 'cluster-only', '.', '--no-label', '--no-viz'],
    environment,
  };
}

export function assertCacheOnlyExtraction(output) {
  const summaries = [
    ...String(output).matchAll(/semantic cache:\s+(\d+) hit\s*\/\s*(\d+) miss/giu),
  ];
  if (summaries.length === 0)
    throw new Error('Graphify release extraction did not report a semantic cache summary');
  const misses = summaries.reduce((total, match) => total + Number(match[2]), 0);
  if (misses !== 0)
    throw new Error(`Graphify release extraction refused ${misses} semantic cache miss(es)`);
  if (/semantic extraction on\s+\d+\s+files/iu.test(output))
    throw new Error('Graphify release extraction attempted uncached semantic extraction');
  if (!/wrote\s+[^\r\n]*graphify-out[\\/]graph\.json:/iu.test(output))
    throw new Error('Graphify release extraction did not write graph.json');
}

function invoke(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.environment,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Graphify ${args[2]} failed with exit code ${result.status}`);
  return output;
}

export function runGraphifyRelease({ cwd = process.cwd() } = {}) {
  const invocation = buildGraphifyInvocations();
  const extraction = invoke(invocation.command, invocation.extractArgs, {
    cwd,
    environment: invocation.environment,
  });
  assertCacheOnlyExtraction(extraction);
  invoke(invocation.command, invocation.clusterArgs, {
    cwd,
    environment: invocation.environment,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runGraphifyRelease();
  } catch (error) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
