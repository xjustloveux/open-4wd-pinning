import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('pre-public pinning CI', () => {
  it('publishes the GitHub CI badge and links the repository license', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toContain(
      '[![CI](https://github.com/xjustloveux/open-4wd-pinning/actions/workflows/cicd.yml/badge.svg?branch=master)](https://github.com/xjustloveux/open-4wd-pinning/actions/workflows/cicd.yml)',
    );
    expect(readme).toContain('[MIT](LICENSE)');
    expect(readme).not.toContain('docs/badges/license-mit.svg');
  });

  it('only gives the Graphify release job write access for an official master push', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/graphify-release.yml', import.meta.url),
      'utf8',
    );

    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain(
      'github.event.workflow_run.head_repository.full_name == github.repository',
    );
    // 守門驗的是產出：release 自身的 immutable 欄位（現有 contents 權限即可讀），
    // 不得回頭查 repository 設定——administration 不在 GITHUB_TOKEN 的 permissions 之列。
    expect(workflow).toContain("--jq '.immutable'");
    expect(workflow).toContain('if [ "${immutable}" != "true" ]; then');
    expect(workflow).not.toContain('immutable-releases');
  });

  it('mints the specs token from the GitHub App Client ID without the legacy App ID input', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/graphify-release.yml', import.meta.url),
      'utf8',
    );

    expect(workflow).toContain('client-id: ${{ vars.OPEN4WD_GRAPH_APP_CLIENT_ID }}');
    expect(workflow).not.toMatch(/^\s+app-id:/mu);
    expect(workflow).not.toContain('OPEN4WD_GRAPH_APP_ID');
  });

  it('replays the complete semantic cache through the tested Graphify runner', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/graphify-release.yml', import.meta.url),
      'utf8',
    );
    expect(workflow).toContain('node scripts/run-graphify-release.mjs');
    expect(workflow).not.toMatch(/graphify extract[^\n]*(?:--code-only|--no-cluster)/u);
  });

  it('uses the self-contained local-only vendor gate without external repository access', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/cicd.yml', import.meta.url),
      'utf8',
    );

    expect(workflow).toContain('pnpm check:vendor -- --local-only');
    expect(workflow).not.toContain('OPEN4WD_UPSTREAM_ROOT');
    expect(workflow).not.toMatch(/repository:\s*xjustloveux\/open-4wd(?:\s|$)/mu);
    expect(workflow).not.toContain('MAIN_REPO_TOKEN');
  });

  it('checks only pinning-owned rules against an immutable public specs checkout', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/cicd.yml', import.meta.url),
      'utf8',
    );

    expect(workflow).toMatch(
      /repository:\s*xjustloveux\/open-4wd-specs[\s\S]*?ref:\s*[0-9a-f]{40}\s*(?:#.*)?\n[\s\S]*?path:\s*\.ci\/open-4wd-specs/u,
    );
    expect(workflow).toContain(
      'node .ci/open-4wd-specs/scripts/check-trace.mjs --target open-4wd-pinning=scripts --target open-4wd-pinning=integration',
    );
    expect(workflow).not.toMatch(
      /repository:\s*xjustloveux\/open-4wd-(?:signaling|turn)(?:\s|$)/mu,
    );
  });

  it('runs language-neutral comment quality only for the official upstream', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/cicd.yml', import.meta.url),
      'utf8',
    );
    expect(workflow).toContain("if: github.repository == 'xjustloveux/open-4wd-pinning'");
    expect(workflow).toContain('pnpm check:comments:self-test');
    expect(workflow).toContain('pnpm check:comments');
    expect(workflow).not.toContain('check:comment-language');
    expect(workflow).toContain('build-and-push:\n    needs: verify');
    expect(workflow).not.toContain('needs: comment-quality');
  });

  it('runs the node:test script contracts in the verify job for every fork', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/cicd.yml', import.meta.url),
      'utf8',
    );
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    // node:test 檔被 vitest 排除，必須有自己的 CI 入口，且對 fork 也執行（不放 official-only job）。
    const verify = workflow.slice(0, workflow.indexOf('comment-quality:'));
    expect(verify).toContain('pnpm test:scripts');
    expect(pkg.scripts['test:scripts']).toBe(
      'node --test scripts/comment-hook-runner.test.mjs scripts/eslint-comment-quality.test.mjs scripts/image-build-inputs.test.mjs scripts/issue-maintenance.test.mjs scripts/prepare-graphify-release.test.mjs scripts/run-graphify-release.test.mjs',
    );

    const vitestConfig = (await import('../vitest.config')).default;
    const nodeTestFiles = pkg.scripts['test:scripts']
      .split(' ')
      .filter((argument: string) => argument.endsWith('.test.mjs'));
    expect(vitestConfig.test?.exclude).toEqual(expect.arrayContaining(nodeTestFiles));
  });

  it('publishes an app image only when the verified push changed an image input', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/cicd.yml', import.meta.url),
      'utf8',
    );

    expect(workflow).toContain('image-inputs-changed: ${{ steps.image-inputs.outputs.changed }}');
    expect(workflow).toContain('id: image-inputs');
    expect(workflow).toContain('run: node scripts/image-build-inputs.mjs');
    expect(workflow).toContain("needs.verify.outputs.image-inputs-changed == 'true'");
  });

  it('reports specs lock drift weekly without blocking and without a floating checkout', async () => {
    const drift = await readFile(
      new URL('../.github/workflows/specs-lock-drift.yml', import.meta.url),
      'utf8',
    );
    // 只提醒不阻斷：排程＋手動、唯讀權限、specs 只 checkout 釘定 commit、比對範圍限本 repo 消費的路徑。
    expect(drift).toMatch(/^on:\n {2}schedule:\n {4}- cron: '[^']+'\n {2}workflow_dispatch:/mu);
    expect(drift).toMatch(/^permissions:\n {2}contents: read$/mu);
    expect(drift).not.toMatch(/write/u);
    expect(drift).toContain('ref: ${{ steps.specs-lock.outputs.commit }}');
    expect(drift).not.toMatch(/ref:\s*(master|main)\b/u);
    // 只列 pinning 真正讀的 rules.json 與執行的 check-trace.mjs，不把 specs scripts/ 整目錄算進來。
    expect(drift).toContain('-- rules.json scripts/check-trace.mjs)');
    expect(drift).not.toMatch(
      /diff --name-status[^\n]*(?:rule-ownership\.json|rule-contracts\.json| scripts\))/u,
    );
    expect(drift).toContain('::warning');
    expect(drift).not.toContain('exit 1');
  });

  it('labels the image with its own source repository so the GHCR package links back and inherits access', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/cicd.yml', import.meta.url),
      'utf8',
    );
    expect(workflow).toContain(
      '--label "org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}"',
    );
    // fork 必須標記自己的 repository；寫死上游會把 fork 的 package 連結到別人的 repo。
    expect(workflow).not.toMatch(/image\.source=[^"\s]*xjustloveux/u);
  });

  it('runs every test step exactly once: no retry wrapper can turn a flaky failure green', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/cicd.yml', import.meta.url),
      'utf8',
    );
    // 對齊 main 的零重試：重跑包裝會吞掉斷言失敗，讓 flaky 只剩 annotation 可見。
    expect(workflow).not.toContain('首次執行失敗');
    expect(workflow).not.toMatch(/pnpm (?:test|e2e)\s*\|\|/u);
    expect(workflow).not.toMatch(/if ! run_integration/u);
  });

  it('declares the pnpm version once: packageManager is the single source and no workflow repeats it', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { packageManager?: string };
    const pinned = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(packageJson.packageManager ?? '')?.[1];
    expect(pinned).toBeDefined();
    const workflowRoot = new URL('../.github/workflows/', import.meta.url);
    const names = (await readdir(workflowRoot)).filter((name) => name.endsWith('.yml'));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const yaml = await readFile(new URL(name, workflowRoot), 'utf8');
      // pnpm/action-setup 同時看到 with.version 與 packageManager 且兩者不同時會直接中止
      // （Multiple versions of pnpm specified）；只接受「不帶 version」或「與 packageManager 完全相同」。
      for (const step of yaml.split(/\n(?=\s*- (?:uses|name|run):)/u)) {
        if (!step.includes('pnpm/action-setup')) continue;
        const version = /^\s*version:\s*['"]?([^'"\s]+)['"]?\s*$/mu.exec(step)?.[1];
        expect(version === undefined || version === pinned, `${name}: ${step.trim()}`).toBe(true);
      }
    }
  });
});
