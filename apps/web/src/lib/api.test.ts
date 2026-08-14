import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, type TokenPair } from './api';

const oldTokens: TokenPair = {
  accessToken: 'access-old',
  refreshToken: 'refresh-old',
  tokenType: 'bearer',
  expiresIn: 3600,
};

const newTokens: TokenPair = {
  accessToken: 'access-new',
  refreshToken: 'refresh-new',
  tokenType: 'bearer',
  expiresIn: 3600,
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof Request ? input.url : input.href;
}

function createClient(initialTokens: TokenPair | null = oldTokens) {
  let tokens = initialTokens;
  const writeTokens = vi.fn((nextTokens: TokenPair | null) => {
    tokens = nextTokens;
  });
  const client = new ApiClient(() => tokens, writeTokens);

  return {
    client,
    readTokens: () => tokens,
    replaceTokens: (nextTokens: TokenPair | null) => {
      tokens = nextTokens;
    },
    writeTokens,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ApiClient', () => {
  it('serializes request fields with their camelCase contract names', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ revision: 8 }));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = createClient();

    await client.put('/tempo-maps/map-1', {
      expectedRevision: 7,
      serverStartTimeNs: 123_456,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/feelmyrythm/api/tempo-maps/map-1');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ expectedRevision: 7, serverStartTimeNs: 123_456 }),
    );
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Authorization')).toBe('Bearer access-old');
  });

  it('shares one refresh across concurrent 401 responses and retries both requests once', async () => {
    let unauthorizedResponses = 0;
    let releaseRefresh: (() => void) | undefined;
    const bothRequestsReachedServer = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      const headers = new Headers(init?.headers);

      if (url.endsWith('/auth/refresh')) {
        await bothRequestsReachedServer;
        return jsonResponse(newTokens);
      }

      if (headers.get('Authorization') === 'Bearer access-old') {
        unauthorizedResponses += 1;
        if (unauthorizedResponses === 2) releaseRefresh?.();
        return jsonResponse({ detail: 'expired' }, 401);
      }

      return jsonResponse({ path: url, authorized: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { client, readTokens, writeTokens } = createClient();

    const [first, second] = await Promise.all([
      client.get<{ authorized: boolean }>('/projects/project-1'),
      client.get<{ authorized: boolean }>('/groups/group-1'),
    ]);

    expect(first.authorized).toBe(true);
    expect(second.authorized).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(
      fetchMock.mock.calls.filter(([input]) => requestUrl(input).endsWith('/auth/refresh')),
    ).toHaveLength(1);
    const refreshCall = fetchMock.mock.calls.find(([input]) =>
      requestUrl(input).endsWith('/auth/refresh'),
    );
    expect(refreshCall?.[1]?.body).toBe(JSON.stringify({ refreshToken: 'refresh-old' }));

    const retryCalls = fetchMock.mock.calls.filter(([, init]) => {
      const headers = new Headers(init?.headers);
      return headers.get('Authorization') === 'Bearer access-new';
    });
    expect(retryCalls).toHaveLength(2);
    expect(writeTokens).toHaveBeenCalledOnce();
    expect(readTokens()).toEqual(newTokens);
  });

  it('retries a late stale 401 with the already-rotated session without refreshing twice', async () => {
    let releaseSlowRequest: ((response: Response) => void) | undefined;
    const slowResponse = new Promise<Response>((resolve) => {
      releaseSlowRequest = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      const authorization = new Headers(init?.headers).get('Authorization');
      if (url.endsWith('/slow') && authorization === 'Bearer access-old') return slowResponse;
      if (url.endsWith('/fast') && authorization === 'Bearer access-old') {
        return jsonResponse({ detail: 'expired' }, 401);
      }
      if (url.endsWith('/auth/refresh')) return jsonResponse(newTokens);
      if (authorization === 'Bearer access-new') return jsonResponse({ authorized: true });
      return jsonResponse({ detail: 'unexpected request' }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { client, readTokens, writeTokens } = createClient();

    const slowRequest = client.get<{ authorized: boolean }>('/slow');
    await expect(client.get<{ authorized: boolean }>('/fast')).resolves.toEqual({
      authorized: true,
    });
    releaseSlowRequest?.(jsonResponse({ detail: 'expired' }, 401));
    await expect(slowRequest).resolves.toEqual({ authorized: true });

    expect(
      fetchMock.mock.calls.filter(([input]) => requestUrl(input).endsWith('/auth/refresh')),
    ).toHaveLength(1);
    expect(writeTokens).toHaveBeenCalledOnce();
    expect(readTokens()).toEqual(newTokens);
  });

  it.each([
    { outcome: 'success', response: () => jsonResponse(newTokens) },
    {
      outcome: 'failure',
      response: () => jsonResponse({ detail: 'rotated refresh rejected' }, 401),
    },
  ])(
    'does not overwrite a replacement login when an old refresh finishes with $outcome',
    async ({ response: refreshResponse }) => {
      const replacementTokens: TokenPair = {
        accessToken: 'access-other-account',
        refreshToken: 'refresh-other-account',
        tokenType: 'bearer',
        expiresIn: 3600,
      };
      let releaseRefresh: ((response: Response) => void) | undefined;
      const pendingRefresh = new Promise<Response>((resolve) => {
        releaseRefresh = resolve;
      });
      const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
        const url = requestUrl(input);
        const authorization = new Headers(init?.headers).get('Authorization');
        if (url.endsWith('/auth/refresh')) return pendingRefresh;
        if (authorization === 'Bearer access-old') {
          return jsonResponse({ detail: 'expired' }, 401);
        }
        if (authorization === 'Bearer access-other-account') {
          return jsonResponse({ account: 'replacement' });
        }
        return jsonResponse({ detail: 'unexpected request' }, 500);
      });
      vi.stubGlobal('fetch', fetchMock);
      const { client, readTokens, replaceTokens, writeTokens } = createClient();

      const request = client.get<{ account: string }>('/groups');
      await vi.waitFor(() => {
        expect(
          fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/auth/refresh')),
        ).toBe(true);
      });
      replaceTokens(replacementTokens);
      releaseRefresh?.(refreshResponse());

      await expect(request).resolves.toEqual({ account: 'replacement' });
      expect(readTokens()).toEqual(replacementTokens);
      expect(writeTokens).not.toHaveBeenCalled();
    },
  );

  it('clears tokens when refresh fails', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ detail: 'expired' }, 401))
      .mockResolvedValueOnce(jsonResponse({ detail: 'invalid refresh token' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    const { client, readTokens, writeTokens } = createClient();

    await expect(client.get('/groups')).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      message: 'invalid refresh token',
    });

    expect(writeTokens).toHaveBeenCalledOnce();
    expect(writeTokens).toHaveBeenCalledWith(null);
    expect(readTokens()).toBeNull();
  });

  it('keeps tokens and shares the retryable network error when a concurrent refresh cannot connect', async () => {
    let unauthorizedResponses = 0;
    let releaseRefresh: (() => void) | undefined;
    const bothRequestsReachedServer = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const networkError = new TypeError('Failed to fetch');
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith('/auth/refresh')) {
        await bothRequestsReachedServer;
        throw networkError;
      }
      if (new Headers(init?.headers).get('Authorization') === 'Bearer access-old') {
        unauthorizedResponses += 1;
        if (unauthorizedResponses === 2) releaseRefresh?.();
        return jsonResponse({ detail: 'expired' }, 401);
      }
      return jsonResponse({ detail: 'unexpected request' }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { client, readTokens, writeTokens } = createClient();

    const requests = Promise.allSettled([client.get('/projects'), client.get('/groups')]);

    await expect(requests).resolves.toEqual([
      { status: 'rejected', reason: networkError },
      { status: 'rejected', reason: networkError },
    ]);
    expect(
      fetchMock.mock.calls.filter(([input]) => requestUrl(input).endsWith('/auth/refresh')),
    ).toHaveLength(1);
    expect(writeTokens).not.toHaveBeenCalled();
    expect(readTokens()).toEqual(oldTokens);
  });

  it('keeps tokens and surfaces a retryable server error when refresh is unavailable', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ detail: 'expired' }, 401))
      .mockResolvedValueOnce(jsonResponse({ detail: 'refresh temporarily unavailable' }, 503));
    vi.stubGlobal('fetch', fetchMock);
    const { client, readTokens, writeTokens } = createClient();

    await expect(client.get('/groups')).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      message: 'refresh temporarily unavailable',
    });

    expect(writeTokens).not.toHaveBeenCalled();
    expect(readTokens()).toEqual(oldTokens);
  });

  it('leaves FormData content type unset so the browser can add its multipart boundary', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ accepted: true }));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = createClient();
    const form = new FormData();
    form.append('score', new File(['score'], 'score.pdf', { type: 'application/pdf' }));

    await client.request('/scores/import', { method: 'POST', body: form });

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.has('Content-Type')).toBe(false);
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.get('Authorization')).toBe('Bearer access-old');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(form);
  });

  it('returns undefined for a successful 204 response without parsing JSON', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = createClient();

    await expect(client.delete('/practice/logs/log-1')).resolves.toBeUndefined();
  });
});
