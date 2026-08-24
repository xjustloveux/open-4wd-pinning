import console from 'node:console';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const NEEDS_INFO_MARKER = '<!-- open4wd-needs-info -->';
const STALE_MARKER = '<!-- open4wd-stale -->';
const STALE_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

function yamlScalar(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    const body = trimmed.slice(1, -1);
    return trimmed.startsWith("'") ? body.replaceAll("''", "'") : JSON.parse(trimmed);
  }
  return trimmed;
}

function formLabel(source) {
  const block = /^labels:\s*\r?\n(?<items>(?: {2}-[^\r\n]*\r?\n)+)/mu.exec(source)?.groups?.items;
  const first = block?.match(/^ {2}-\s*(?<label>[^\r\n]+)$/mu)?.groups?.label;
  return first ? yamlScalar(first) : null;
}

function requiredCheckboxes(item) {
  const result = [];
  const pattern =
    /^ {8}- label:\s*(?<label>[^\r\n]+)\r?\n(?:(?: {10}[^\r\n]*\r?\n)*?) {10}required:\s*true\s*$/gmu;
  for (const match of item.matchAll(pattern)) result.push(yamlScalar(match.groups.label));
  return result;
}

export function parseIssueForm(source, filename = 'issue.yml') {
  const required = [];
  const items = source.matchAll(
    /^ {2}- type:\s*(?<type>[a-z]+)\s*\r?\n(?<item>[\s\S]*?)(?=^ {2}- type:|(?![\s\S]))/gmu,
  );
  for (const match of items) {
    if (match.groups.type === 'markdown') continue;
    const item = match.groups.item;
    const id = /^ {4}id:\s*(?<id>[A-Za-z0-9_-]+)\s*$/mu.exec(item)?.groups?.id;
    const labelText = /^ {6}label:\s*(?<label>[^\r\n]+)$/mu.exec(item)?.groups?.label;
    if (!id || !labelText) {
      throw new Error(filename + ': every non-markdown form item needs an id and label');
    }
    const checkboxes = match.groups.type === 'checkboxes' ? requiredCheckboxes(item) : [];
    const requiredByValidation =
      /^ {4}validations:\s*\r?\n(?:(?: {6}[^\r\n]*\r?\n)*?) {6}required:\s*true\s*$/mu.test(item);
    if (requiredByValidation || checkboxes.length > 0) {
      required.push({ id, label: yamlScalar(labelText), checkboxes });
    }
  }

  const label = formLabel(source);
  if (!label) throw new Error(filename + ': a routing label is required');
  if (required.length === 0) throw new Error(filename + ': no required form fields found');
  return { filename, label, required };
}

export async function loadIssueForms(directory = resolve('.github/ISSUE_TEMPLATE')) {
  const names = (await readdir(directory))
    .filter((name) => /\.ya?ml$/u.test(name) && name !== 'config.yml')
    .sort();
  return Promise.all(
    names.map(async (name) =>
      parseIssueForm(await readFile(resolve(directory, name), 'utf8'), name),
    ),
  );
}

function issueLabelNames(issue) {
  return (issue.labels ?? []).map((label) =>
    (typeof label === 'string' ? label : (label.name ?? '')).toLowerCase(),
  );
}

function hasSecurityLabel(issue) {
  return issueLabelNames(issue).some(
    (label) =>
      /^(?:type\/)?security(?:\/|$)/u.test(label) ||
      label.includes('vulnerabil') ||
      label.includes('資安'),
  );
}

function hasSecuritySignal(issue) {
  const title = (issue.title ?? '').toLowerCase();
  return (
    hasSecurityLabel(issue) ||
    /\b(?:security|vulnerabilit(?:y|ies)|cve-\d{4}-\d+)\b|資安|漏洞|安全性/u.test(title)
  );
}

function isPrivileged(issue) {
  return ['OWNER', 'MEMBER'].includes(issue.author_association);
}

function isBot(issue) {
  return issue.user?.type === 'Bot';
}

function markdownSections(body) {
  const sections = new Map();
  const pattern = /^###\s+(?<heading>[^\r\n]+)\s*\r?\n(?<answer>[\s\S]*?)(?=^###\s+|(?![\s\S]))/gmu;
  for (const match of (body ?? '').matchAll(pattern)) {
    sections.set(match.groups.heading.trim(), match.groups.answer.trim());
  }
  return sections;
}

function hasAnswer(value) {
  return Boolean(value && value !== '_No response_' && value !== 'No response');
}

function checkedOptions(value) {
  const checked = new Set();
  for (const match of (value ?? '').matchAll(/^\s*-\s*\[[xX]\]\s*(?<label>.+?)\s*$/gmu)) {
    checked.add(match.groups.label.trim());
  }
  return checked;
}

export function inspectIssue(issue, forms) {
  if (
    issue.state !== 'open' ||
    issue.locked ||
    issue.pull_request ||
    isPrivileged(issue) ||
    isBot(issue) ||
    hasSecuritySignal(issue)
  ) {
    return { disposition: 'skip' };
  }

  const labels = issueLabelNames(issue);
  const form = forms.find((candidate) => labels.includes(candidate.label.toLowerCase()));
  if (!form) return { disposition: 'skip' };

  const sections = markdownSections(issue.body);
  const missing = [];
  for (const field of form.required) {
    const answer = sections.get(field.label);
    if (!hasAnswer(answer)) {
      missing.push(field.label);
      continue;
    }
    if (field.checkboxes.length > 0) {
      const checked = checkedOptions(answer);
      for (const option of field.checkboxes) {
        if (!checked.has(option)) missing.push(field.label + ': ' + option);
      }
    }
  }
  return missing.length > 0 ? { disposition: 'needs-info', missing } : { disposition: 'valid' };
}

function needsInfoComment(missing) {
  const list = missing.map((item) => '- ' + item).join('\n');
  return [
    NEEDS_INFO_MARKER,
    'Thanks for the report. The Issue Form is missing required information:',
    '',
    list,
    '',
    'Please edit the issue to complete these fields. The needs-info label remains as a visible history marker; adding the information makes the issue eligible for review again.',
  ].join('\n');
}

const staleComment = [
  STALE_MARKER,
  'This issue has had no activity for 60 days while waiting for required information, so it is being closed automatically. You may reopen it after adding the missing details.',
].join('\n');

export async function maintainIssue({ issue, forms, api }) {
  const result = inspectIssue(issue, forms);
  if (result.disposition !== 'needs-info') return result;

  if (!issueLabelNames(issue).includes('needs-info')) {
    await api.addLabels(issue.number, ['needs-info']);
  }
  const comments = await api.listComments(issue.number);
  if (!comments.some((comment) => comment.body?.includes(NEEDS_INFO_MARKER))) {
    await api.createComment(issue.number, needsInfoComment(result.missing));
  }
  return result;
}

function eligibleForStale(issue, cutoff) {
  if (
    issue.state !== 'open' ||
    issue.locked ||
    issue.pull_request ||
    isPrivileged(issue) ||
    isBot(issue) ||
    hasSecuritySignal(issue) ||
    !issueLabelNames(issue).includes('needs-info')
  ) {
    return false;
  }
  const updatedAt = Date.parse(issue.updated_at);
  return Number.isFinite(updatedAt) && updatedAt <= cutoff;
}

export async function sweepNeedsInfo({ api, forms, now = new Date() }) {
  const candidates = await api.listNeedsInfoIssues();
  const cutoff = now.getTime() - STALE_DAYS * DAY_MS;
  const closed = [];

  for (const candidate of candidates) {
    const issue = await api.getIssue(candidate.number);
    if (!eligibleForStale(issue, cutoff)) continue;
    if (inspectIssue(issue, forms).disposition !== 'needs-info') continue;

    const comments = (await api.listComments?.(issue.number)) ?? [];
    if (!comments.some((comment) => comment.body?.includes(STALE_MARKER))) {
      await api.createComment(issue.number, staleComment);
    }
    await api.closeIssue(issue.number);
    closed.push(issue.number);
  }
  return { examined: candidates.length, closed };
}

export async function runMaintenanceEvent({
  eventName,
  event,
  api,
  loadForms = () => loadIssueForms(),
  now = new Date(),
}) {
  if (event.repository?.private !== false) return { skipped: 'private-repository' };

  if (eventName === 'issues') {
    if (!event.issue) return { skipped: 'missing-issue' };
    const forms = await loadForms();
    return maintainIssue({ issue: event.issue, forms, api });
  }
  if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
    const forms = await loadForms();
    return sweepNeedsInfo({ api, forms, now });
  }
  return { skipped: 'unsupported-event' };
}

export function createGitHubApi({
  repository,
  token,
  apiUrl = 'https://api.github.com',
  fetchImpl = globalThis.fetch,
}) {
  if (!repository || !repository.includes('/')) throw new Error('GITHUB_REPOSITORY is invalid');
  const base = apiUrl.replace(/\/$/u, '') + '/repos/' + repository;

  async function request(method, path, body) {
    if (!token) throw new Error('GITHUB_TOKEN is required for public issue maintenance');
    const response = await fetchImpl(base + path, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'User-Agent': 'open4wd-issue-maintenance',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(
        'GitHub API ' + method + ' ' + path + ' failed (' + response.status + '): ' + detail,
      );
    }
    return response.status === 204 ? null : response.json();
  }

  async function paged(path) {
    const rows = [];
    for (let page = 1; ; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const batch = await request('GET', path + separator + 'per_page=100&page=' + String(page));
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
  }

  return {
    listNeedsInfoIssues: () =>
      paged('/issues?state=open&labels=needs-info').then((issues) =>
        issues.filter((issue) => !issue.pull_request),
      ),
    getIssue: (number) => request('GET', '/issues/' + String(number)),
    listComments: (number) => paged('/issues/' + String(number) + '/comments'),
    addLabels: (number, labels) =>
      request('POST', '/issues/' + String(number) + '/labels', { labels }),
    createComment: (number, body) =>
      request('POST', '/issues/' + String(number) + '/comments', { body }),
    closeIssue: (number) => request('PATCH', '/issues/' + String(number), { state: 'closed' }),
  };
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const api = createGitHubApi({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
    apiUrl: process.env.GITHUB_API_URL,
  });
  const result = await runMaintenanceEvent({
    eventName: process.env.GITHUB_EVENT_NAME,
    event,
    api,
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
