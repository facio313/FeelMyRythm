import { platformStorage } from '@feelmyrythm/mobile';
import type { components } from '@feelmyrythm/protocol';
import { Button } from '@feelmyrythm/ui';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiClient, ApiError, type TokenPair } from './api';
import { localDb } from './localDb';
import { portfolioSsoEnabled } from './runtimeMode';

const TOKEN_KEY = 'fmr.auth.tokens.v1';
const USER_KEY = 'fmr.auth.user.v1';
const SESSION_KEY = 'fmr.auth.session.v1';
const LEGACY_AUTH_KEYS = [TOKEN_KEY, USER_KEY, 'fmr-auth'] as const;
const WEB_AUTH_KEYS = [SESSION_KEY, ...LEGACY_AUTH_KEYS] as const;
const SSO_LOGOUT_REVOKE_TIMEOUT_MS = 3_000;

export type AuthUser = components['schemas']['UserOut'];
export interface AccountDeletionProof {
  currentPassword?: string;
  googleIdToken?: string;
  accountDeleteToken?: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  tokens: TokenPair | null;
  client: ApiClient;
  login: (email: string, password: string) => Promise<void>;
  register: (displayName: string, email: string) => Promise<EmailVerificationPending>;
  verifyEmail: (token: string, password: string, passwordConfirmation: string) => Promise<void>;
  resendVerification: (email: string) => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  resetPassword: (token: string, password: string, passwordConfirmation: string) => Promise<void>;
  loginWithGoogle: (idToken: string) => Promise<void>;
  requestAccountDeletionChallenge: () => Promise<void>;
  deleteAccount: (
    email: string,
    proof?: AccountDeletionProof,
  ) => Promise<{ localCacheCleared: boolean }>;
  logout: () => void;
}

type AuthResponse = components['schemas']['TokenPairOut'];
export type EmailVerificationPending = components['schemas']['EmailVerificationPendingOut'];

interface StoredAuthSession {
  tokens: TokenPair;
  user: AuthUser;
}

const parseJson = <T,>(value: string | null): T | null => {
  try {
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
};

const AuthContext = createContext<AuthContextValue | null>(null);

function storedSession(tokens: TokenPair, user: AuthUser): string {
  return JSON.stringify({ tokens, user } satisfies StoredAuthSession);
}

function parseStoredSession(value: string | null): StoredAuthSession | null {
  const parsed = parseJson<Partial<StoredAuthSession>>(value);
  return parsed?.tokens && parsed.user ? { tokens: parsed.tokens, user: parsed.user } : null;
}

function hasCurrentUserEnvelope(user: AuthUser | null): user is AuthUser {
  return Boolean(user && typeof user.hasPassword === 'boolean');
}

function isAuthoritativeSsoRejection(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 401;
}

function ssoBootstrapErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return '중앙 로그인 세션을 확인할 수 없습니다. 중앙 로그인을 확인한 뒤 다시 시도해 주세요.';
    }
    if (error.status === 409) {
      return '중앙 계정과 FeelMyRythm 계정 정보가 충돌합니다. 관리자에게 계정 연결 상태를 확인해 주세요.';
    }
    if (error.status >= 500) {
      return '중앙 로그인 확인 서비스가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해 주세요.';
    }
  }
  return '중앙 로그인 세션을 확인하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.';
}

function tokenPairFromResponse(payload: AuthResponse): TokenPair {
  return {
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    tokenType: payload.tokenType,
    expiresIn: payload.expiresIn,
  };
}

async function removePlatformAuth(): Promise<void> {
  await Promise.all(WEB_AUTH_KEYS.map((key) => platformStorage.removeItem(key)));
}

class AuthRuntime {
  private tokens: TokenPair | null = null;
  private user: AuthUser | null = null;
  private storageQueue = Promise.resolve();

  readonly readTokens = (): TokenPair | null => this.tokens;
  readonly readUser = (): AuthUser | null => this.user;

  setTokens(tokens: TokenPair | null): void {
    this.tokens = tokens;
  }

  setUser(user: AuthUser | null): void {
    this.user = user;
  }

  enqueueStorage(operation: () => Promise<void>): Promise<void> {
    const pending = this.storageQueue.then(operation, operation);
    this.storageQueue = pending.catch((error: unknown) => {
      console.error('Authentication storage operation failed', error);
    });
    return pending;
  }

  waitForStorage(): Promise<void> {
    return this.storageQueue;
  }
}

const authRuntime = new AuthRuntime();

interface AuthBootstrapResult {
  tokens: TokenPair | null;
  user: AuthUser | null;
}

interface SharedSsoBootstrap {
  generation: number;
  promise: Promise<AuthBootstrapResult>;
}

class SupersededSsoBootstrapError extends Error {
  constructor() {
    super('The SSO bootstrap was superseded by a newer authentication generation.');
    this.name = 'SupersededSsoBootstrapError';
  }
}

let ssoBootstrapGeneration = 0;
let sharedSsoBootstrap: SharedSsoBootstrap | null = null;
let ssoRebootstrapPending = false;

function assertCurrentSsoBootstrap(generation: number): void {
  if (generation !== ssoBootstrapGeneration) throw new SupersededSsoBootstrapError();
}

function invalidateSsoBootstrap(): void {
  ssoBootstrapGeneration += 1;
  sharedSsoBootstrap = null;
}

async function initializeSsoSession(generation: number): Promise<AuthBootstrapResult> {
  await authRuntime.waitForStorage();
  assertCurrentSsoBootstrap(generation);
  const atomicSession = parseStoredSession(await platformStorage.getItem(SESSION_KEY));
  assertCurrentSsoBootstrap(generation);
  let nextTokens = atomicSession?.tokens ?? null;
  let nextUser = atomicSession?.user ?? null;

  try {
    let exchangeRequired = atomicSession === null;
    if (atomicSession) {
      authRuntime.setTokens(nextTokens);
      const verificationClient = new ApiClient(authRuntime.readTokens, (verifiedTokens) => {
        assertCurrentSsoBootstrap(generation);
        authRuntime.setTokens(verifiedTokens);
        nextTokens = verifiedTokens;
      });
      try {
        nextUser = await verificationClient.get<AuthUser>('/users/me');
        assertCurrentSsoBootstrap(generation);
        nextTokens = authRuntime.readTokens();
        if (!nextTokens) {
          throw new Error('The verified SSO application session did not retain its tokens.');
        }
      } catch (error: unknown) {
        assertCurrentSsoBootstrap(generation);
        authRuntime.setTokens(null);
        nextTokens = null;
        nextUser = null;
        if (!isAuthoritativeSsoRejection(error)) throw error;
        await authRuntime.enqueueStorage(async () => {
          assertCurrentSsoBootstrap(generation);
          await removePlatformAuth();
        });
        exchangeRequired = true;
      }
    }

    if (exchangeRequired) {
      const ssoClient = new ApiClient(
        () => null,
        () => undefined,
      );
      const payload = await ssoClient.request<AuthResponse>(
        '/auth/sso',
        { method: 'POST' },
        { authenticated: false, retryAuth: false },
      );
      assertCurrentSsoBootstrap(generation);
      nextTokens = tokenPairFromResponse(payload);
      nextUser = payload.user;
    }

    if (!nextTokens || !nextUser) {
      throw new Error('The SSO bootstrap did not produce an application session.');
    }
    const bootstrapTokens = nextTokens;
    const bootstrapUser = nextUser;
    await authRuntime.enqueueStorage(async () => {
      assertCurrentSsoBootstrap(generation);
      await platformStorage.setItem(SESSION_KEY, storedSession(bootstrapTokens, bootstrapUser));
      await Promise.all(LEGACY_AUTH_KEYS.map((key) => platformStorage.removeItem(key)));
    });
    assertCurrentSsoBootstrap(generation);
    authRuntime.setTokens(bootstrapTokens);
    authRuntime.setUser(bootstrapUser);
    return { tokens: bootstrapTokens, user: bootstrapUser };
  } catch (error: unknown) {
    if (generation === ssoBootstrapGeneration) {
      authRuntime.setTokens(null);
      authRuntime.setUser(null);
    }
    throw error;
  }
}

function acquireSsoBootstrap(): SharedSsoBootstrap {
  if (sharedSsoBootstrap) return sharedSsoBootstrap;

  const generation = ++ssoBootstrapGeneration;
  const promise = initializeSsoSession(generation).finally(() => {
    if (sharedSsoBootstrap?.generation === generation) sharedSsoBootstrap = null;
  });
  sharedSsoBootstrap = { generation, promise };
  return sharedSsoBootstrap;
}

async function initializeLocalSession(): Promise<AuthBootstrapResult> {
  await authRuntime.waitForStorage();
  const [sessionValue, legacyTokenValue, legacyUserValue] = await Promise.all([
    platformStorage.getItem(SESSION_KEY),
    platformStorage.getItem(TOKEN_KEY),
    platformStorage.getItem(USER_KEY),
  ]);
  const atomicSession = parseStoredSession(sessionValue);
  let nextTokens = atomicSession?.tokens ?? parseJson<TokenPair>(legacyTokenValue);
  let nextUser = atomicSession?.user ?? parseJson<AuthUser>(legacyUserValue);
  let sessionNeedsUpgrade = !atomicSession;

  if (nextTokens && !hasCurrentUserEnvelope(nextUser)) {
    sessionNeedsUpgrade = true;
    authRuntime.setTokens(nextTokens);
    const recoveryClient = new ApiClient(authRuntime.readTokens, (recoveredTokens) => {
      authRuntime.setTokens(recoveredTokens);
    });
    try {
      nextUser = await recoveryClient.get<AuthUser>('/users/me');
      nextTokens = authRuntime.readTokens();
    } catch {
      nextTokens = null;
      nextUser = null;
      authRuntime.setTokens(null);
    }
  }

  if (nextTokens && nextUser) {
    if (sessionNeedsUpgrade) {
      await platformStorage.setItem(SESSION_KEY, storedSession(nextTokens, nextUser));
    }
    await Promise.all(LEGACY_AUTH_KEYS.map((key) => platformStorage.removeItem(key)));
  } else {
    await removePlatformAuth();
  }

  authRuntime.setTokens(nextTokens);
  authRuntime.setUser(nextUser);
  return { tokens: nextTokens, user: nextUser };
}

interface AuthProviderProps {
  children: ReactNode;
  navigateToCentralLogout?: (url: string) => void;
}

function navigateBrowserToCentralLogout(url: string): void {
  window.location.assign(url);
}

export function AuthProvider({
  children,
  navigateToCentralLogout = navigateBrowserToCentralLogout,
}: AuthProviderProps) {
  const [tokens, setTokensState] = useState<TokenPair | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);
  const [ssoBootstrapError, setSsoBootstrapError] = useState<string | null>(null);
  const [ssoBootstrapAttempt, setSsoBootstrapAttempt] = useState(0);

  const enqueueStorage = useCallback((operation: () => Promise<void>): Promise<void> => {
    return authRuntime.enqueueStorage(operation);
  }, []);

  useEffect(() => {
    let active = true;
    const ssoEnabled = portfolioSsoEnabled();
    if (platformStorage.secure) {
      try {
        for (const key of WEB_AUTH_KEYS) window.localStorage.removeItem(key);
      } catch (error: unknown) {
        console.error('Legacy web authentication storage could not be cleared', error);
      }
    }

    const bootstrap = ssoEnabled ? acquireSsoBootstrap().promise : initializeLocalSession();
    void bootstrap
      .then(({ tokens: nextTokens, user: nextUser }) => {
        if (!active) return;
        setTokensState(nextTokens);
        setUser(nextUser);
      })
      .catch((error: unknown) => {
        if (active) {
          if (!ssoEnabled) {
            authRuntime.setTokens(null);
            authRuntime.setUser(null);
          }
          setTokensState(null);
          setUser(null);
          if (ssoEnabled) setSsoBootstrapError(ssoBootstrapErrorMessage(error));
          console.error('Authentication storage could not be loaded', error);
        }
      })
      .finally(() => {
        if (active) {
          ssoRebootstrapPending = false;
          setReady(true);
        }
      });

    return () => {
      active = false;
    };
  }, [ssoBootstrapAttempt]);

  const writeTokens = useCallback(
    (next: TokenPair | null) => {
      authRuntime.setTokens(next);
      setTokensState(next);
      if (next) {
        const currentUser = authRuntime.readUser();
        if (currentUser) {
          void enqueueStorage(() =>
            platformStorage.setItem(SESSION_KEY, storedSession(next, currentUser)),
          ).catch(() => undefined);
        }
        return;
      }
      authRuntime.setUser(null);
      setUser(null);
      if (!portfolioSsoEnabled()) {
        void enqueueStorage(removePlatformAuth).catch(() => undefined);
        return;
      }
      if (ssoRebootstrapPending) return;

      ssoRebootstrapPending = true;
      invalidateSsoBootstrap();
      setReady(false);
      setSsoBootstrapError(null);
      void enqueueStorage(removePlatformAuth)
        .then(() => {
          setSsoBootstrapAttempt((attempt) => attempt + 1);
        })
        .catch((error: unknown) => {
          ssoRebootstrapPending = false;
          setSsoBootstrapError(ssoBootstrapErrorMessage(error));
          setReady(true);
          console.error('Rejected SSO authentication storage could not be cleared', error);
        });
    },
    [enqueueStorage],
  );

  const client = useMemo(() => new ApiClient(authRuntime.readTokens, writeTokens), [writeTokens]);

  const finishLogin = useCallback(
    async (payload: AuthResponse) => {
      const nextTokens = tokenPairFromResponse(payload);
      await enqueueStorage(() =>
        platformStorage.setItem(SESSION_KEY, storedSession(nextTokens, payload.user)),
      );
      authRuntime.setTokens(nextTokens);
      authRuntime.setUser(payload.user);
      setTokensState(nextTokens);
      setUser(payload.user);
      void enqueueStorage(async () => {
        await Promise.all(LEGACY_AUTH_KEYS.map((key) => platformStorage.removeItem(key)));
      }).catch(() => undefined);
    },
    [enqueueStorage],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const payload = await client.request<AuthResponse>(
        '/auth/login',
        { method: 'POST', body: JSON.stringify({ email, password }) },
        { authenticated: false },
      );
      await finishLogin(payload);
    },
    [client, finishLogin],
  );

  const register = useCallback(
    async (displayName: string, email: string) => {
      return client.request<EmailVerificationPending>(
        '/auth/register',
        { method: 'POST', body: JSON.stringify({ displayName, email }) },
        { authenticated: false },
      );
    },
    [client],
  );

  const verifyEmail = useCallback(
    async (token: string, password: string, passwordConfirmation: string) => {
      const payload = await client.request<AuthResponse>(
        '/auth/verify-email',
        {
          method: 'POST',
          body: JSON.stringify({ token, password, passwordConfirmation }),
        },
        { authenticated: false },
      );
      await finishLogin(payload);
    },
    [client, finishLogin],
  );

  const resendVerification = useCallback(
    async (email: string) => {
      await client.request<components['schemas']['MessageOut']>(
        '/auth/resend-verification',
        { method: 'POST', body: JSON.stringify({ email }) },
        { authenticated: false },
      );
    },
    [client],
  );

  const requestPasswordReset = useCallback(
    async (email: string) => {
      await client.request<components['schemas']['MessageOut']>(
        '/auth/request-password-reset',
        { method: 'POST', body: JSON.stringify({ email }) },
        { authenticated: false },
      );
    },
    [client],
  );

  const resetPassword = useCallback(
    async (token: string, password: string, passwordConfirmation: string) => {
      await client.request<components['schemas']['MessageOut']>(
        '/auth/reset-password',
        {
          method: 'POST',
          body: JSON.stringify({ token, password, passwordConfirmation }),
        },
        { authenticated: false },
      );
    },
    [client],
  );

  const loginWithGoogle = useCallback(
    async (idToken: string) => {
      const payload = await client.request<AuthResponse>(
        '/auth/google',
        { method: 'POST', body: JSON.stringify({ idToken }) },
        { authenticated: false },
      );
      await finishLogin(payload);
    },
    [client, finishLogin],
  );

  const deleteAccount = useCallback(
    async (email: string, proof?: AccountDeletionProof) => {
      const currentUser = authRuntime.readUser();
      if (!currentUser) throw new Error('로그인이 필요합니다.');
      await client.request<void>('/users/me', {
        method: 'DELETE',
        body: JSON.stringify({
          email,
          ...proof,
        }),
      });

      let localCacheCleared = true;
      try {
        await localDb.deleteRemoteCache({ userId: currentUser.id });
      } catch (error) {
        localCacheCleared = false;
        console.error('Deleted account remote cache could not be cleared', error);
      }
      try {
        await enqueueStorage(removePlatformAuth);
      } catch (error) {
        localCacheCleared = false;
        console.error('Deleted account authentication storage could not be cleared', error);
      } finally {
        authRuntime.setTokens(null);
        authRuntime.setUser(null);
        setTokensState(null);
        setUser(null);
      }
      return { localCacheCleared };
    },
    [client, enqueueStorage],
  );

  const requestAccountDeletionChallenge = useCallback(async () => {
    await client.request<components['schemas']['MessageOut']>('/users/me/delete-challenge', {
      method: 'POST',
    });
  }, [client]);

  const logout = useCallback(() => {
    const current = authRuntime.readTokens();
    const ssoEnabled = portfolioSsoEnabled();
    if (ssoEnabled) {
      ssoRebootstrapPending = true;
      invalidateSsoBootstrap();
      setReady(false);
      setSsoBootstrapError(null);
    }
    authRuntime.setTokens(null);
    authRuntime.setUser(null);
    setTokensState(null);
    setUser(null);
    const storageCleanup = enqueueStorage(removePlatformAuth);

    if (!ssoEnabled) {
      if (current) {
        void client
          .request(
            '/auth/logout',
            { method: 'POST', body: JSON.stringify({ refreshToken: current.refreshToken }) },
            { authenticated: false, retryAuth: false },
          )
          .catch(() => undefined);
      }
      void storageCleanup.catch(() => undefined);
      return;
    }

    void (async () => {
      const abortController = new AbortController();
      let timeoutId: number | undefined;
      const revokeSettled = current
        ? client
            .request(
              '/auth/logout',
              {
                method: 'POST',
                body: JSON.stringify({ refreshToken: current.refreshToken }),
                signal: abortController.signal,
              },
              { authenticated: false, retryAuth: false },
            )
            .then(() => undefined)
            .catch(() => undefined)
        : Promise.resolve();
      const timeout = new Promise<void>((resolve) => {
        timeoutId = window.setTimeout(() => {
          abortController.abort();
          resolve();
        }, SSO_LOGOUT_REVOKE_TIMEOUT_MS);
      });
      const localLogoutSettled = Promise.allSettled([revokeSettled, storageCleanup]).then(
        () => undefined,
      );

      await Promise.race([localLogoutSettled, timeout]);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      const returnUrl = `${window.location.origin}/feelmyrythm/`;
      navigateToCentralLogout(`/sso/logout?rd=${encodeURIComponent(returnUrl)}`);
    })();
  }, [client, enqueueStorage, navigateToCentralLogout]);

  const value = useMemo(
    () => ({
      user,
      tokens,
      client,
      login,
      register,
      verifyEmail,
      resendVerification,
      requestPasswordReset,
      resetPassword,
      loginWithGoogle,
      requestAccountDeletionChallenge,
      deleteAccount,
      logout,
    }),
    [
      user,
      tokens,
      client,
      login,
      register,
      verifyEmail,
      resendVerification,
      requestPasswordReset,
      resetPassword,
      loginWithGoogle,
      requestAccountDeletionChallenge,
      deleteAccount,
      logout,
    ],
  );

  if (!ready) {
    return (
      <div className="loading-panel" role="status">
        로그인 상태를 불러오는 중…
      </div>
    );
  }

  if (ssoBootstrapError) {
    return (
      <div className="loading-panel" aria-live="polite">
        <h1>중앙 세션을 확인하지 못했습니다</h1>
        <p role="alert">{ssoBootstrapError}</p>
        <Button
          variant="primary"
          onClick={() => {
            setReady(false);
            setSsoBootstrapError(null);
            setSsoBootstrapAttempt((attempt) => attempt + 1);
          }}
        >
          중앙 세션 다시 확인
        </Button>
      </div>
    );
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
