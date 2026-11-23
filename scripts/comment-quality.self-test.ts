import assert from 'node:assert/strict';

import { inspectCommentQuality } from './comment-quality';

const clean = `
/** Describes a public boundary. */
export interface PublicBoundary {}

/** Coordinates requests. */
export class Coordinator {
  /** Tracks active requests. */
  readonly active = 0;

  /** Stores internal state. */
  private state = 0;
}
`;

assert.deepEqual(inspectCommentQuality(clean, 'core/clean.ts'), []);

const findings = inspectCommentQuality(
  `
export interface MissingDocs {}
export class Service {
  run(): void {}
  private reset(): void {}
}
// TODO: see specs/legacy.md
`,
  'core/broken.ts',
);

assert.deepEqual(
  findings.map(({ rule, line }) => ({ rule, line })),
  [
    { rule: 'exported API missing TSDoc', line: 2 },
    { rule: 'exported API missing TSDoc', line: 3 },
    { rule: 'public member missing TSDoc', line: 4 },
    { rule: 'private declaration missing TSDoc', line: 5 },
    { rule: 'stale documentation reference', line: 7 },
    { rule: 'work-in-progress marker', line: 7 },
  ],
);

assert.deepEqual(
  inspectCommentQuality('export const VALUE = 1;\n', 'core/index.ts').map(({ rule }) => rule),
  ['exported API missing TSDoc', 'module entry missing header'],
);

const syntaxFindings = inspectCommentQuality(
  `
class IndirectService {
  protected prepare(): void {}
}
export { IndirectService };

class InternalState {
  private cache = 0;
  #secret = 0;
  helper(): void {}
}

/** Exposes a class-expression service. */
export const ExpressionService = class {
  get active(): boolean { return true; }
  private set token(value: string) {}
};

function audited(_target: object, _key: string): void {}

/** Exposes a decorated service. */
export class DecoratedService {
  @audited
  run(): void {}
}
`,
  'core/syntax.ts',
);

assert.deepEqual(
  syntaxFindings.map(({ rule, line }) => ({ rule, line })),
  [
    { rule: 'public member missing TSDoc', line: 3 },
    { rule: 'exported API missing TSDoc', line: 2 },
    { rule: 'private declaration missing TSDoc', line: 8 },
    { rule: 'private declaration missing TSDoc', line: 9 },
    { rule: 'public member missing TSDoc', line: 15 },
    { rule: 'private declaration missing TSDoc', line: 16 },
    { rule: 'public member missing TSDoc', line: 24 },
  ].sort((left, right) => left.line - right.line || left.rule.localeCompare(right.rule)),
);

assert.deepEqual(
  inspectCommentQuality(
    `
/** Exposes overload behavior. */
export class OverloadedService {
  /** Resolves text and numeric identifiers. */
  resolve(value: string): string;
  resolve(value: number): string;
  resolve(value: string | number): string { return String(value); }
}
`,
    'core/overloads.ts',
  ),
  [],
);

console.log('comment-quality self-test: pass');
