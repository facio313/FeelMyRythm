import { API_BASE } from './paths';
import type { components } from '@feelmyrythm/protocol';

export interface ApiErrorPayload {
  code?: string;
  detail?: unknown;
  message?: string;
  currentRevision?: number;
  actualRevision?: number;
  expectedRevision?: number;
  errors?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly payload: ApiErrorPayload;

  constructor(status: number, payload: ApiErrorPayload) {
    const nestedDetail =
      typeof payload.detail === 'object' && payload.detail !== null
        ? (payload.detail as Record<string, unknown>)
        : undefined;
    const detailMessage =
      typeof payload.detail === 'string'
        ? payload.detail
        : typeof nestedDetail?.message === 'string'
          ? nestedDetail.message
          : undefined;
    super(detailMessage ?? payload.message ?? `API request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.payload = {
      ...payload,
      ...(typeof nestedDetail?.code === 'string' ? { code: nestedDetail.code } : {}),
      ...(typeof nestedDetail?.actualRevision === 'number'
        ? {
            actualRevision: nestedDetail.actualRevision,
            currentRevision: nestedDetail.actualRevision,
          }
        : {}),
      ...(typeof nestedDetail?.expectedRevision === 'number'
        ? { expectedRevision: nestedDetail.expectedRevision }
        : {}),
    };
  }
}

export type TokenPair = Omit<components['schemas']['TokenPairOut'], 'user'>;

type TokenReader = () => TokenPair | null;
type TokenWriter = (tokens: TokenPair | null) => void;

function sameTokenGeneration(left: TokenPair | null, right: TokenPair): boolean {
  return left?.accessToken === right.accessToken && left.refreshToken === right.refreshToken;
}

function isAuthoritativeRefreshRejection(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 401;
}

export class ApiClient {
  private refreshFlight: { source: TokenPair; promise: Promise<TokenPair> } | null = null;

  constructor(
    private readonly readTokens: TokenReader,
    private readonly writeTokens: TokenWriter,
  ) {}

  async request<T>(
    path: string,
    init: RequestInit = {},
    options: { authenticated?: boolean; retryAuth?: boolean } = {},
  ): Promise<T> {
    const authenticated = options.authenticated ?? true;
    const tokens = this.readTokens();
    const headers = new Headers(init.headers);
    if (!(init.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    headers.set('Accept', 'application/json');
    if (authenticated && tokens) headers.set('Authorization', `Bearer ${tokens.accessToken}`);

    const response = await fetch(`${API_BASE}${path.startsWith('/') ? path : `/${path}`}`, {
      ...init,
      headers,
    });

    if (response.status === 401 && authenticated && tokens && options.retryAuth !== false) {
      const currentTokens = this.readTokens();
      if (currentTokens) {
        const retryTokens = sameTokenGeneration(currentTokens, tokens)
          ? await this.refresh(currentTokens)
          : currentTokens;
        const retryHeaders = new Headers(headers);
        retryHeaders.set('Authorization', `Bearer ${retryTokens.accessToken}`);
        return this.request<T>(
          path,
          { ...init, headers: retryHeaders },
          { authenticated, retryAuth: false },
        );
      }
    }

    if (!response.ok) {
      const payload = await response
        .json()
        .then((value: unknown) => value as ApiErrorPayload)
        .catch((): ApiErrorPayload => ({ detail: response.statusText }));
      throw new ApiError(response.status, payload);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private refresh(source: TokenPair): Promise<TokenPair> {
    const activeFlight = this.refreshFlight;
    if (activeFlight) {
      if (sameTokenGeneration(activeFlight.source, source)) return activeFlight.promise;
      return activeFlight.promise
        .catch(() => undefined)
        .then(() => {
          const currentTokens = this.readTokens();
          if (!currentTokens) {
            throw new ApiError(401, { detail: 'Authentication is required.' });
          }
          return sameTokenGeneration(currentTokens, source) ? this.refresh(source) : currentTokens;
        });
    }

    const promise = this.request<TokenPair>(
      '/auth/refresh',
      { method: 'POST', body: JSON.stringify({ refreshToken: source.refreshToken }) },
      { authenticated: false, retryAuth: false },
    )
      .then((refreshedTokens) => {
        const currentTokens = this.readTokens();
        if (sameTokenGeneration(currentTokens, source)) {
          this.writeTokens(refreshedTokens);
          return refreshedTokens;
        }
        if (currentTokens) return currentTokens;
        throw new ApiError(401, { detail: 'Authentication session changed during refresh.' });
      })
      .catch((error: unknown) => {
        const currentTokens = this.readTokens();
        if (!sameTokenGeneration(currentTokens, source)) {
          if (currentTokens) return currentTokens;
          throw error;
        }
        if (isAuthoritativeRefreshRejection(error)) this.writeTokens(null);
        throw error;
      })
      .finally(() => {
        if (this.refreshFlight?.promise === promise) this.refreshFlight = null;
      });
    this.refreshFlight = { source, promise };
    return promise;
  }

  refreshAccessToken(rejectedAccessToken?: string): Promise<TokenPair> {
    const currentTokens = this.readTokens();
    if (!currentTokens) {
      return Promise.reject(new ApiError(401, { detail: 'Authentication is required.' }));
    }
    if (rejectedAccessToken && rejectedAccessToken !== currentTokens.accessToken) {
      return Promise.resolve(currentTokens);
    }
    return this.refresh(currentTokens);
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
  }

  delete<T = void>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' });
  }
}
