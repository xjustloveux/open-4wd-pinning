export type RemoteFailure =
  | Readonly<{
      kind: 'http';
      url: string;
      status: number;
      statusText: string;
    }>
  | Readonly<{
      kind: 'network';
      url: string;
      code?: string;
      message: string;
    }>;

export type VendorFetchResult =
  Readonly<{ ok: true; text: string }> | Readonly<{ ok: false; failure: RemoteFailure }>;

const safeErrorCode = (cause: unknown): string | undefined => {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined;
  const code = Reflect.get(cause, 'code');
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : undefined;
};

const safeErrorName = (cause: unknown): string => {
  if (cause instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(cause.name)) return cause.name;
  return 'NetworkError';
};

export async function fetchVendorText(
  fetchFn: typeof fetch,
  url: string,
): Promise<VendorFetchResult> {
  try {
    const response = await fetchFn(url);
    if (!response.ok) {
      return {
        ok: false,
        failure: {
          kind: 'http',
          url,
          status: response.status,
          statusText: response.statusText,
        },
      };
    }
    return { ok: true, text: await response.text() };
  } catch (cause) {
    const code = safeErrorCode(cause);
    return {
      ok: false,
      failure: {
        kind: 'network',
        url,
        ...(code === undefined ? {} : { code }),
        message: safeErrorName(cause),
      },
    };
  }
}

export function formatRemoteFailures(failures: readonly RemoteFailure[]): string {
  const http = failures.filter(
    (failure): failure is Extract<RemoteFailure, { kind: 'http' }> => failure.kind === 'http',
  );
  const network = failures.filter(
    (failure): failure is Extract<RemoteFailure, { kind: 'network' }> => failure.kind === 'network',
  );
  const lines: string[] = [];
  if (http.length > 0) {
    lines.push('上游 HTTP 失敗：');
    for (const failure of http) {
      const statusText = failure.statusText.trim();
      lines.push(
        `- HTTP ${failure.status}${statusText === '' ? '' : ` ${statusText}`} ${failure.url}`,
      );
    }
  }
  if (network.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('上游網路失敗：');
    for (const failure of network) {
      lines.push(
        `- ${failure.code === undefined ? failure.message : `${failure.code} ${failure.message}`} ${failure.url}`,
      );
    }
  }
  return lines.join('\n');
}
