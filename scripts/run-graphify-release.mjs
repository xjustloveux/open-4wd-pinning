import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import process from 'node:process';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GRAPHIFY_RELEASE_VERSION = '0.9.25';
export const GRAPHIFY_RELEASE_PROMPT_FINGERPRINT = 'f33081f95084';

const SEMANTIC_EXTENSIONS = new Set([
  '.docx',
  '.gif',
  '.gdoc',
  '.gdraw',
  '.gsheet',
  '.gslides',
  '.html',
  '.jpeg',
  '.jpg',
  '.md',
  '.mdx',
  '.pdf',
  '.png',
  '.qmd',
  '.rst',
  '.skill',
  '.svg',
  '.txt',
  '.webp',
  '.xlsx',
  '.yaml',
  '.yml',
]);

const SECRET_PRONE_EXTENSIONS = new Set([
  '.cfg',
  '.conf',
  '.config',
  '.ini',
  '.json',
  '.properties',
  '.toml',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

const NATIVE_CACHE_PREFLIGHT = String.raw`
import json
import subprocess
import sys
from importlib.metadata import version
from pathlib import Path
import graphify.cache as cache
from graphify.detect import detect
from graphify.llm import _extraction_system

root = Path(sys.argv[1]).resolve()
try:
    git_result = subprocess.run(
        ['git', '-c', f'safe.directory={root.as_posix()}', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        cwd=root,
        check=True,
        stdout=subprocess.PIPE,
    )
    git_sources = {
        (root / source).resolve()
        for source in git_result.stdout.decode('utf-8').split('\0')
        if source
    }
    detection = detect(root, cache_root=root)
    semantic_files = [
        Path(path)
        for category in ('document', 'paper', 'image')
        for path in detection.get('files', {}).get(category, [])
        if Path(path).resolve() in git_sources
    ]
    prompt = _extraction_system(deep=False)
    fingerprint = cache.prompt_fingerprint(prompt)
    missing = []
    hits = 0
    for source in semantic_files:
        result = cache.load_cached(
            source,
            root=root,
            kind='semantic',
            cache_root=root,
            prompt=prompt,
            allow_legacy=False,
        )
        if result is None:
            missing.append(source.resolve().relative_to(root).as_posix())
        else:
            hits += 1
    print('GRAPHIFY_CACHE_PREFLIGHT=' + json.dumps({
        'version': version('graphifyy'),
        'promptFingerprint': fingerprint,
        'hits': hits,
        'misses': len(missing),
        'missing': sorted(missing),
    }, ensure_ascii=False, sort_keys=True))
finally:
    # The preflight is read-only; suppress cache.py's atexit stat-index write.
    cache._stat_index_dirty = False
`;

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

function normalizePath(path) {
  return path.replaceAll('\\', '/');
}

function graphifyIgnoreRules(cwd) {
  const path = resolve(cwd, '.graphifyignore');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function matchesGraphifyIgnoreContract(source, rules) {
  let included = true;
  for (const rule of rules) {
    if (rule === '/*') {
      included = false;
      continue;
    }
    const negated = rule.startsWith('!');
    const pattern = (negated ? rule.slice(1) : rule).replace(/^\//u, '');
    let matches;
    if (pattern.startsWith('*.')) matches = source.endsWith(pattern.slice(1));
    else if (pattern.endsWith('/')) matches = source.startsWith(pattern);
    else if (!pattern.includes('*')) matches = source === pattern;
    else throw new Error(`Unsupported .graphifyignore rule in release preflight: ${rule}`);
    if (matches) included = negated;
  }
  return included;
}

function isSensitiveSemanticSource(source) {
  const extension = extname(source).toLowerCase();
  if (!SECRET_PRONE_EXTENSIONS.has(extension)) return false;
  const stem = source.slice(source.lastIndexOf('/') + 1, -extension.length).toLowerCase();
  return /(?:^|[._-])(credential|secret|passwd|password|private[._-]?key|token)s?$/u.test(stem);
}

function trackedFiles(cwd) {
  const result = spawnSync(
    'git',
    [
      '-c',
      `safe.directory=${normalizePath(resolve(cwd))}`,
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
    ],
    { cwd, encoding: 'buffer' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `git ls-files failed with exit code ${result.status}: ${String(result.stderr)}`,
    );
  return result.stdout.toString('utf8').split('\0').filter(Boolean).map(normalizePath);
}

function semanticSources(cwd) {
  const rules = graphifyIgnoreRules(cwd);
  return trackedFiles(cwd)
    .filter((source) => matchesGraphifyIgnoreContract(source, rules))
    .filter((source) => SEMANTIC_EXTENSIONS.has(extname(source).toLowerCase()))
    .filter((source) => !isSensitiveSemanticSource(source))
    .sort();
}

function markdownBody(content) {
  const text = content.toString('utf8');
  const delimiter = /^---[ \t]*\r?$/gmu;
  const opener = delimiter.exec(text);
  if (!opener || opener.index !== 0) return content;
  const closer = delimiter.exec(text);
  if (!closer) return content;
  return Buffer.from(text.slice(closer.index + 3));
}

function semanticFileHash(cwd, source) {
  const path = resolve(cwd, source);
  let content = readFileSync(path);
  if (extname(source).toLowerCase() === '.md') content = markdownBody(content);
  const salt = normalizePath(relative(resolve(cwd), path)).toLowerCase();
  return createHash('sha256')
    .update(content)
    .update(Buffer.from([0]))
    .update(salt)
    .digest('hex');
}

function currentPromptCacheHashes(cwd, promptFingerprint) {
  const namespace = `p${promptFingerprint}`;
  const root = resolve(cwd, 'graphify-out/cache/semantic', namespace);
  const hashes = new Set();
  if (!existsSync(root)) return new Map([[namespace, hashes]]);
  for (const file of readdirSync(root, { withFileTypes: true })) {
    if (!file.isFile() || !/^[0-9a-f]{64}\.json$/u.test(file.name)) continue;
    const payload = JSON.parse(readFileSync(resolve(root, file.name), 'utf8'));
    if (payload.partial === true) continue;
    hashes.add(file.name.slice(0, -'.json'.length));
  }
  return new Map([[namespace, hashes]]);
}

export function findMissingPromptCacheEntries({
  promptFingerprint,
  sourceHashes,
  namespaceHashes,
}) {
  const current = namespaceHashes.get(`p${promptFingerprint}`) ?? new Set();
  return [...sourceHashes]
    .filter(([, hash]) => !current.has(hash))
    .map(([source]) => source)
    .sort();
}

export function assertTrackedPromptCacheCoverage({
  cwd = process.cwd(),
  promptFingerprint = GRAPHIFY_RELEASE_PROMPT_FINGERPRINT,
} = {}) {
  const sources = semanticSources(cwd);
  const sourceHashes = new Map(sources.map((source) => [source, semanticFileHash(cwd, source)]));
  const missing = findMissingPromptCacheEntries({
    promptFingerprint,
    sourceHashes,
    namespaceHashes: currentPromptCacheHashes(cwd, promptFingerprint),
  });
  if (missing.length !== 0)
    throw new Error(
      `Graphify ${GRAPHIFY_RELEASE_VERSION} prompt ${promptFingerprint} cache missing: ${missing.join(', ')}`,
    );
  return { version: GRAPHIFY_RELEASE_VERSION, promptFingerprint, sources, missing };
}

export function assertNativeCachePreflight(output) {
  const line = String(output)
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith('GRAPHIFY_CACHE_PREFLIGHT='));
  if (!line) throw new Error('Graphify native cache preflight did not report its result');
  const result = JSON.parse(line.slice('GRAPHIFY_CACHE_PREFLIGHT='.length));
  if (result.version !== GRAPHIFY_RELEASE_VERSION)
    throw new Error(
      `Graphify release version drift: expected ${GRAPHIFY_RELEASE_VERSION}, got ${result.version}`,
    );
  if (result.promptFingerprint !== GRAPHIFY_RELEASE_PROMPT_FINGERPRINT)
    throw new Error(
      `Graphify release prompt drift: expected ${GRAPHIFY_RELEASE_PROMPT_FINGERPRINT}, got ${result.promptFingerprint}`,
    );
  if (result.misses !== 0 || result.missing.length !== 0)
    throw new Error(`Graphify native current-profile cache missing: ${result.missing.join(', ')}`);
  return result;
}

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
    preflightArgs: ['-c', NATIVE_CACHE_PREFLIGHT, '.'],
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

export function runGraphifyCachePreflight({ cwd = process.cwd() } = {}) {
  assertTrackedPromptCacheCoverage({ cwd });
  const invocation = buildGraphifyInvocations();
  const output = invoke(invocation.command, invocation.preflightArgs, {
    cwd,
    environment: invocation.environment,
  });
  return assertNativeCachePreflight(output);
}

export function runGraphifyRelease({ cwd = process.cwd() } = {}) {
  runGraphifyCachePreflight({ cwd });
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
    if (process.argv.includes('--check-cache')) runGraphifyCachePreflight();
    else runGraphifyRelease();
  } catch (error) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
