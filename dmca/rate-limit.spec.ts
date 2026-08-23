import { describe, expect, it } from 'vitest';
import { checkFixedWindowRate } from './rate-limit';

describe('checkFixedWindowRate', () => {
  it('counts within one fixed window and resets after the window expires', () => {
    const first = checkFixedWindowRate(undefined, 1_000, 2, 500);
    const second = checkFixedWindowRate(first.window, 1_500, 2, 500);

    expect(second).toEqual({
      allowed: true,
      window: { count: 2, windowStart: 1_000 },
    });
    expect(checkFixedWindowRate(second.window, 1_500, 2, 500).allowed).toBe(false);
    expect(checkFixedWindowRate(second.window, 1_501, 2, 500)).toEqual({
      allowed: true,
      window: { count: 1, windowStart: 1_501 },
    });
  });
});
