import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROFILES = new Set(['maintainer', 'contributor']);
const HOOK_NAMES = ['pre-commit', 'pre-push'];
const OWNERSHIP_MARKER = '# Open4WD 管理的本機註解品質 hook。';

const defaultGit = (root) => (args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const optionalGit = (runGit, args) => {
  try {
    return runGit(args).trim();
  } catch {
    return null;
  }
};

// 以 git rev-parse 解析 hooks 目錄，一般 clone 與 worktree 皆適用。
const hookFiles = (root, runGit) => {
  const gitDirectoryValue = runGit(['rev-parse', '--git-dir']).trim();
  const gitDirectory = isAbsolute(gitDirectoryValue)
    ? gitDirectoryValue
    : resolve(root, gitDirectoryValue);
  return HOOK_NAMES.map((name) => ({
    name,
    source: join(root, '.githooks', name),
    target: join(gitDirectory, 'hooks', name),
  }));
};

const readHookTemplates = (files) =>
  files.map((file) => ({ ...file, content: readFileSync(file.source, 'utf8') }));

// 只允許覆寫或移除缺席、與 template 相同或帶 Open4WD 標記的 hook。
const assertOwnedOrAbsent = (files) => {
  for (const file of files) {
    if (!existsSync(file.target)) continue;
    const current = readFileSync(file.target, 'utf8');
    if (current !== file.content && !current.split(/\r?\n/u).includes(OWNERSHIP_MARKER)) {
      throw new Error(`refusing to replace or remove non-Open4WD Git hook: ${file.name}`);
    }
  }
};

/** 設定或停用目前 Template clone 的 opt-in 註解 hooks，不觸碰全域 Git 設定。 */
export function configureCommentHooks({ root, action, profile, runGit = defaultGit(root) }) {
  const current = optionalGit(runGit, ['config', '--local', '--get', 'core.hooksPath']);
  const files = readHookTemplates(hookFiles(root, runGit));
  if (action === 'disable') {
    assertOwnedOrAbsent(files);
    for (const file of files) {
      if (existsSync(file.target)) unlinkSync(file.target);
    }
    if (current === '.githooks') runGit(['config', '--local', '--unset-all', 'core.hooksPath']);
    optionalGit(runGit, ['config', '--local', '--unset-all', 'open4wd.commentProfile']);
    return;
  }
  if (action !== 'setup') throw new Error('action must be setup or disable');
  if (!PROFILES.has(profile)) throw new Error('profile must be maintainer or contributor');
  if (current !== null && current !== '' && current !== '.githooks') {
    throw new Error(`refusing to replace custom core.hooksPath: ${current}`);
  }
  assertOwnedOrAbsent(files);
  // wrapper 由 setup 寫入並設 0755；版控 .githooks 只是 template、不需攜帶 executable mode。
  for (const file of files) {
    mkdirSync(dirname(file.target), { recursive: true });
    writeFileSync(file.target, file.content, { mode: 0o755 });
    chmodSync(file.target, 0o755);
  }
  if (current === '.githooks') runGit(['config', '--local', '--unset-all', 'core.hooksPath']);
  runGit(['config', '--local', '--replace-all', 'open4wd.commentProfile', profile]);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const invokedPath =
  globalThis.process.argv[1] === undefined ? '' : pathToFileURL(globalThis.process.argv[1]).href;
if (import.meta.url === invokedPath) {
  const action = globalThis.process.argv[2];
  const profile = globalThis.process.argv[3];
  try {
    configureCommentHooks({ root, action, profile });
    globalThis.console.log(
      action === 'setup' ? `comment hooks enabled (${profile})` : 'comment hooks disabled',
    );
  } catch (error) {
    globalThis.console.error(error instanceof Error ? error.message : String(error));
    globalThis.process.exitCode = 1;
  }
}
