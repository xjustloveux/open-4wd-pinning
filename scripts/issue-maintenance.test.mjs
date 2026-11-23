import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';

import {
  inspectIssue,
  parseIssueForm,
  runMaintenanceEvent,
  sweepNeedsInfo,
} from './issue-maintenance.mjs';

const formSource = `
name: Bug
labels:
  - type/bug
body:
  - type: textarea
    id: summary
    attributes:
      label: Summary
    validations:
      required: true
  - type: checkboxes
    id: confirmations
    attributes:
      label: Confirmation
      options:
        - label: I searched existing issues.
          required: true
`;

const report = (overrides = {}) => ({
  number: 7,
  state: 'open',
  title: '[Bug]: test',
  body: '### Summary\\n\\nDetails\\n\\n### Confirmation\\n\\n- [x] I searched existing issues.',
  labels: [{ name: 'type/bug' }, { name: 'needs-info' }],
  author_association: 'CONTRIBUTOR',
  user: { type: 'User' },
  updated_at: '2026-06-01T00:00:00Z',
  ...overrides,
});

test('derives validation from the local Issue Form and reports missing required data', () => {
  const form = parseIssueForm(formSource, 'bug.yml');
  assert.equal(form.label, 'type/bug');
  assert.deepEqual(inspectIssue(report({ body: '' }), [form]), {
    disposition: 'needs-info',
    missing: ['Summary', 'Confirmation'],
  });
});

test('stale sweep closes an eligible issue with a static marker comment', async () => {
  const issue = report({ body: '' });
  const comments = [];
  const api = {
    async listNeedsInfoIssues() {
      return [issue];
    },
    async getIssue() {
      return issue;
    },
    async createComment(_number, body) {
      comments.push(body);
    },
    async closeIssue() {
      issue.state = 'closed';
    },
  };

  assert.deepEqual(
    await sweepNeedsInfo({
      api,
      forms: [parseIssueForm(formSource, 'bug.yml')],
      now: new Date('2026-08-24T00:00:00Z'),
    }),
    {
      examined: 1,
      closed: [7],
    },
  );
  assert.equal(issue.state, 'closed');
  assert.match(comments[0], /open4wd-stale/u);
});

test('private repository event performs no GitHub operation', async () => {
  let touched = false;
  const result = await runMaintenanceEvent({
    eventName: 'schedule',
    event: { repository: { private: true } },
    loadForms: async () => {
      touched = true;
      return [];
    },
    api: {
      async listNeedsInfoIssues() {
        touched = true;
        return [];
      },
    },
  });
  assert.deepEqual(result, { skipped: 'private-repository' });
  assert.equal(touched, false);
});

test('local workflow has the public guard, minimal permissions, and no secrets', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/issue-maintenance.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /^permissions:\n {2}contents: read\n {2}issues: write$/mu);
  assert.match(workflow, /if: github\.event\.repository\.private == false/u);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/u);
  assert.doesNotMatch(workflow, /secrets\.|app-id|client-id/u);
});
