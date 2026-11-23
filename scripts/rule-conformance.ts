import { it } from 'vitest';

type Boundary<TArgs extends unknown[], TResult> = (...args: TArgs) => TResult;

export function ruleConformance<TArgs extends unknown[], TResult>(options: {
  ruleId: string;
  layer: 'service';
  contract: string;
  boundary: Boundary<TArgs, TResult>;
  verify: (context: {
    invoke: (...args: TArgs) => Promise<Awaited<TResult>>;
  }) => void | Promise<void>;
}): void {
  it(`${options.ruleId}:${options.layer}:${options.contract}`, async () => {
    let invocationCount = 0;
    await options.verify({
      invoke: async (...args): Promise<Awaited<TResult>> => {
        invocationCount += 1;
        return (await options.boundary(...args)) as Awaited<TResult>;
      },
    });
    if (invocationCount === 0) throw new Error('rule conformance：production boundary 未被呼叫');
  });
}
