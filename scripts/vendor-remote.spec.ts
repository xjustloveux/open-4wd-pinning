import { describe, expect, it, vi } from 'vitest';
import { fetchVendorText, formatRemoteFailures } from './vendor-remote';

describe('vendor remote diagnostics', () => {
  it.each([
    [403, 'Forbidden'],
    [404, 'Not Found'],
    [429, 'Too Many Requests'],
    [500, 'Internal Server Error'],
  ])('preserves HTTP %i and URL without reading the response body', async (status, statusText) => {
    const text = vi.fn(async () => 'PRIVATE_RESPONSE_BODY');
    const fetchFn = vi.fn(
      async () => ({ ok: false, status, statusText, text }) as unknown as Response,
    );
    const url = `https://raw.githubusercontent.com/open4wd/upstream/${status}`;

    const result = await fetchVendorText(fetchFn as typeof fetch, url);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an HTTP failure');
    expect(result).toEqual({
      ok: false,
      failure: { kind: 'http', url, status, statusText },
    });
    expect(text).not.toHaveBeenCalled();
    expect(formatRemoteFailures([result.failure])).toContain(`HTTP ${status}`);
    expect(formatRemoteFailures([result.failure])).toContain(url);
    expect(formatRemoteFailures([result.failure])).not.toContain('PRIVATE_RESPONSE_BODY');
  });

  it.each([
    ['ETIMEDOUT', 'timeout SECRET_AUTHORIZATION'],
    ['ENOTFOUND', 'dns SECRET_AUTHORIZATION'],
  ])('preserves safe network code %s without leaking the raw message', async (code, message) => {
    const cause = Object.assign(new TypeError(message), { code });
    const fetchFn = vi.fn(async () => {
      throw cause;
    });
    const url = 'https://raw.githubusercontent.com/open4wd/upstream/network';

    const result = await fetchVendorText(fetchFn as typeof fetch, url);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a remote failure');
    expect(result.failure).toEqual({
      kind: 'network',
      url,
      code,
      message: 'TypeError',
    });
    const summary = formatRemoteFailures([result.failure]);
    expect(summary).toContain(code);
    expect(summary).toContain(url);
    expect(summary).not.toContain('SECRET_AUTHORIZATION');
  });

  it('returns successful text without diagnostics', async () => {
    const fetchFn = vi.fn(async () => new Response('upstream bytes', { status: 200 }));

    await expect(
      fetchVendorText(fetchFn as typeof fetch, 'https://example.test/source'),
    ).resolves.toEqual({ ok: true, text: 'upstream bytes' });
  });
});
