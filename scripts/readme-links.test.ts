import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function localMarkdownTargets(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)]
    .map((match) => match[1]!.trim().replace(/^<|>$/gu, ''))
    .filter((target) => target !== '' && !/^(?:https?:|mailto:|#)/u.test(target))
    .map((target) => decodeURIComponent(target.split('#')[0]!));
}

test('README relative Markdown links point at existing repository paths', async () => {
  const readmePath = resolve(ROOT, 'README.md');
  const targets = localMarkdownTargets(await readFile(readmePath, 'utf8'));
  expect(targets.length).toBeGreaterThan(0);
  for (const target of targets) {
    const destination = resolve(dirname(readmePath), target);
    expect(existsSync(destination), target).toBe(true);
    expect(statSync(destination).isFile() || statSync(destination).isDirectory(), target).toBe(
      true,
    );
  }
});

test('public monitoring template leaves the notification receiver to the operator', async () => {
  const text = (
    await Promise.all(
      ['deploy/monitoring/README.md', 'deploy/monitoring/alertmanager.yml'].map((path) =>
        readFile(resolve(ROOT, path), 'utf8'),
      ),
    )
  ).join('\n');
  expect(text).not.toMatch(/Discord|private-discord|discord_configs/iu);
  expect(text).toMatch(/operator-selected/u);
  expect(text).toMatch(/營運者.*自行選擇.*receiver/u);
});
