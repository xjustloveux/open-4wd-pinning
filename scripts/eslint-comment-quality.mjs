import { inspectCommentQuality } from './comment-quality.ts';

/** 將 repo-local analyzer 的 findings 對映為 ESLint 診斷。 */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Enforce the repository comment-quality declaration contract.' },
    schema: [],
  },
  create(context) {
    return {
      'Program:exit'() {
        for (const finding of inspectCommentQuality(
          context.sourceCode.getText(),
          context.filename,
        )) {
          context.report({
            loc: {
              start: { line: finding.line, column: 0 },
              end: { line: finding.line, column: 1 },
            },
            message: `${finding.rule}${finding.detail ? `: ${finding.detail}` : ''}`,
          });
        }
      },
    };
  },
};
