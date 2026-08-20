import { platformStorage } from '@feelmyrythm/mobile';
import type { components } from '@feelmyrythm/protocol';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiClient, type TokenPair } from './api';
import { localDb } from './localDb';
import { portfolioSsoEnabled } from './runtimeMode';

const TOKEN_KEY = 'fmr.auth.tokens.v1';
const USER_KEY = 'fmr.auth.user.v1';
const SESSION_KEY = 'fmr.auth.session.v1';
const LEGACY_AUTH_KEYS = [TOKEN_KEY, USER_KEY, 'fmr-auth'] as const;
const WEB_AUTH_KEYS = [SESSION_KEY, ...LEGACY_AUTH_KEYS] as const;

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
}

const authRuntime = new AuthRuntime();

export function AuthProvider({ children }: { children: ReactNode }) {
  const [tokens, setTokensState] = useState<TokenPair | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);

  const enqueueStorage = useCallback((operation: () => Promise<void>): Promise<void> => {
    return authRuntime.enqueueStorage(operation);
  }, []);

  useEffect(() => {
    let active = true;
    if (platformStorage.secure) {
      try {
        for (const key of WEB_AUTH_KEYS) window.localStorage.removeItem(key);
      } catch (error: unknown) {
        console.error('Legacy web authentication storage could not be cleared', error);
      }
    }

    void (async () => {
      const [sessionValue, legacyTokenValue, legacyUserValue] = await Promise.all([
        platformStorage.getItem(SESSION_KEY),
        platformStorage.getItem(TOKEN_KEY),
        platformStorage.getItem(USER_KEY),
      ]);
      const atomicSession = parseStoredSession(sessionValue);
      let nextTokens = atomicSession?.tokens ?? parseJson<TokenPair>(legacyTokenValue);
      let nextUser = atomicSession?.user ?? parseJson<AuthUser>(legacyUserValue);
      let sessionNeedsUpgrade = !atomicSession;

      if (portfolioSsoEnabled()) {
        const ssoClient = new ApiClient(
          () => null,
          () => undefined,
        );
        const payload = await ssoClient.request<AuthResponse>(
          '/auth/sso',
          { method: 'POST' },
          { authenticated: false, retryAuth: false },
        );
        nextTokens = tokenPairFromResponse(payload);
        nextUser = payload.user;
        sessionNeedsUpgrade = true;
      }

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

      if (!active) return;
      authRuntime.setTokens(nextTokens);
      authRuntime.setUser(nextUser);
      setTokensState(nextTokens);
      setUser(nextUser);
    })()
      .catch((error: unknown) => {
        if (active) {
          authRuntime.setTokens(null);
          authRuntime.setUser(null);
          setTokensState(null);
          setUser(null);
          console.error('Authentication storage could not be loaded', error);
        }
      })
      .finally(() => {
        if (active) setReady(true);
      });

    return () => {
      active = false;
    };
  }, []);

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
      void enqueueStorage(removePlatformAuth).catch(() => undefined);
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
    if (current) {
      void client
        .request(
          '/auth/logout',
          { method: 'POST', body: JSON.stringify({ refreshToken: current.refreshToken }) },
          { authenticated: false, retryAuth: false },
        )
        .catch(() => undefined);
    }
    writeTokens(null);
    authRuntime.setUser(null);
    setUser(null);
    if (portfolioSsoEnabled()) {
      const returnUrl = `${window.location.origin}/feelmyrythm/`;
      window.location.assign(`/sso/logout?rd=${encodeURIComponent(returnUrl)}`);
    }
  }, [client, writeTokens]);

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

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
