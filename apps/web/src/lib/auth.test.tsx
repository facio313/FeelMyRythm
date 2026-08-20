import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const secureStorage = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
});

vi.mock('@feelmyrythm/mobile', () => ({
  platformStorage: {
    secure: true,
    getItem: secureStorage.getItem,
    setItem: secureStorage.setItem,
    removeItem: secureStorage.removeItem,
  },
}));

const remoteCache = vi.hoisted(() => ({
  deleteRemoteCache: vi.fn(async () => undefined),
}));

vi.mock('./localDb', () => ({
  localDb: remoteCache,
}));

import { AuthProvider, useAuth } from './auth';

const tokens = {
  accessToken: 'native-access',
  refreshToken: 'native-refresh',
  tokenType: 'bearer',
  expiresIn: 900,
};
const user = {
  id: 'user-1',
  email: 'player@example.test',
  displayName: 'Native Player',
  hasPassword: true,
};

const legacyValues = new Map<string, string>();
const legacyStorage: Storage = {
  get length() {
    return legacyValues.size;
  },
  clear: () => legacyValues.clear(),
  getItem: (key) => legacyValues.get(key) ?? null,
  key: (index) => [...legacyValues.keys()][index] ?? null,
  removeItem: (key) => legacyValues.delete(key),
  setItem: (key, value) => legacyValues.set(key, value),
};

function AuthProbe() {
  const auth = useAuth();
  const [loginError, setLoginError] = useState('');
  const [registrationEmail, setRegistrationEmail] = useState('');
  const [accountDeletionResult, setAccountDeletionResult] = useState('');
  const [recoveryResult, setRecoveryResult] = useState('');
  return (
    <div>
      <span>{auth.user?.displayName ?? 'anonymous'}</span>
      <span>{auth.tokens?.accessToken ?? 'no-token'}</span>
      <button type="button" onClick={auth.logout}>
        로그아웃
      </button>
      <button
        type="button"
        onClick={() => {
          void auth.login('player@example.test', 'password-123').catch(() => {
            setLoginError('login-storage-failed');
          });
        }}
      >
        테스트 로그인
      </button>
      <span>{loginError}</span>
      <button
        type="button"
        onClick={() => {
          void auth
            .register('Native Player', 'player@example.test')
            .then((pending) => setRegistrationEmail(pending.email));
        }}
      >
        테스트 가입
      </button>
      <button
        type="button"
        onClick={() =>
          void auth.verifyEmail('verification-token', 'owner-password-123', 'owner-password-123')
        }
      >
        이메일 인증
      </button>
      <button
        type="button"
        onClick={() => {
          void auth
            .requestPasswordReset('player@example.test')
            .then(() => setRecoveryResult('reset-requested'));
        }}
      >
        재설정 요청
      </button>
      <button
        type="button"
        onClick={() => {
          void auth
            .resetPassword('reset-token', 'replacement-password', 'replacement-password')
            .then(() => setRecoveryResult('password-reset'));
        }}
      >
        재설정 완료
      </button>
      <button
        type="button"
        onClick={() => {
          void auth
            .requestAccountDeletionChallenge()
            .then(() => setRecoveryResult('delete-challenge-requested'));
        }}
      >
        탈퇴 확인 요청
      </button>
      <button
        type="button"
        onClick={() => {
          void auth
            .deleteAccount('player@example.test', { currentPassword: 'password-123' })
            .then((result) =>
              setAccountDeletionResult(result.localCacheCleared ? 'cleared' : 'retained'),
            );
        }}
      >
        계정 삭제
      </button>
      <span>{registrationEmail}</span>
      <span>{accountDeletionResult}</span>
      <span>{recoveryResult}</span>
    </div>
  );
}

beforeEach(() => {
  secureStorage.values.clear();
  secureStorage.getItem.mockClear();
  secureStorage.setItem.mockReset().mockImplementation(async (key: string, value: string) => {
    secureStorage.values.set(key, value);
  });
  secureStorage.removeItem.mockReset().mockImplementation(async (key: string) => {
    secureStorage.values.delete(key);
  });
  remoteCache.deleteRemoteCache.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: legacyStorage,
  });
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('AuthProvider native storage', () => {
  it('exchanges the trusted portfolio identity before exposing the SSO session', async () => {
    vi.stubEnv('VITE_FMR_SSO_ENABLED', 'true');
    const ssoUser = { ...user, displayName: 'Portfolio Owner' };
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
      if (url.endsWith('/auth/sso')) {
        return new Response(JSON.stringify({ ...tokens, user: ssoUser }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    expect(await screen.findByText('Portfolio Owner')).toBeInTheDocument();
    expect(screen.getByText(tokens.accessToken)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/auth\/sso$/),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(secureStorage.values.get('fmr.auth.session.v1') ?? '')).toEqual({
      tokens,
      user: ssoUser,
    });
  });

  it('migrates a complete legacy pair into one atomic envelope and removes it on logout', async () => {
    secureStorage.values.set('fmr.auth.tokens.v1', JSON.stringify(tokens));
    secureStorage.values.set('fmr.auth.user.v1', JSON.stringify(user));
    window.localStorage.setItem('fmr.auth.tokens.v1', 'legacy-token');
    window.localStorage.setItem('fmr.auth.user.v1', 'legacy-user');
    window.localStorage.setItem('fmr-auth', 'legacy-zustand-session');

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    expect(screen.getByRole('status')).toHaveTextContent('로그인 상태를 불러오는 중');
    expect(await screen.findByText(user.displayName)).toBeInTheDocument();
    expect(screen.getByText(tokens.accessToken)).toBeInTheDocument();
    expect(window.localStorage.getItem('fmr.auth.tokens.v1')).toBeNull();
    expect(window.localStorage.getItem('fmr.auth.user.v1')).toBeNull();
    expect(window.localStorage.getItem('fmr-auth')).toBeNull();
    expect(JSON.parse(secureStorage.values.get('fmr.auth.session.v1') ?? '')).toEqual({
      tokens,
      user,
    });

    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }));

    await waitFor(() => {
      expect(secureStorage.removeItem).toHaveBeenCalledWith('fmr.auth.session.v1');
    });
    expect(screen.getByText('anonymous')).toBeInTheDocument();
    expect(screen.getByText('no-token')).toBeInTheDocument();
  });

  it('recovers a legacy tokens-only session through users/me and stores an atomic envelope', async () => {
    secureStorage.values.set('fmr.auth.tokens.v1', JSON.stringify(tokens));
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
      if (url.endsWith('/users/me')) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer native-access');
        return new Response(JSON.stringify(user), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    expect(await screen.findByText(user.displayName)).toBeInTheDocument();
    expect(JSON.parse(secureStorage.values.get('fmr.auth.session.v1') ?? '')).toEqual({
      tokens,
      user,
    });
    expect(secureStorage.values.has('fmr.auth.tokens.v1')).toBe(false);
  });

  it('refreshes an old atomic user envelope that predates hasPassword', async () => {
    const oldUser = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
    };
    secureStorage.values.set('fmr.auth.session.v1', JSON.stringify({ tokens, user: oldUser }));
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
      if (url.endsWith('/users/me')) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer native-access');
        return new Response(JSON.stringify(user), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    expect(await screen.findByText(user.displayName)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(secureStorage.values.get('fmr.auth.session.v1') ?? '')).toEqual({
      tokens,
      user,
    });
  });

  it('clears a legacy tokens-only session when users/me and refresh both reject it', async () => {
    secureStorage.values.set('fmr.auth.tokens.v1', JSON.stringify(tokens));
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ detail: 'expired' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(screen.getByText('no-token')).toBeInTheDocument();
    expect(secureStorage.values.has('fmr.auth.tokens.v1')).toBe(false);
    expect(secureStorage.values.has('fmr.auth.session.v1')).toBe(false);
  });

  it('does not expose a logged-in in-memory session when atomic persistence fails', async () => {
    const payload = { ...tokens, user };
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    secureStorage.setItem.mockRejectedValueOnce(new Error('secure storage unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    await screen.findByText('anonymous');
    fireEvent.click(screen.getByRole('button', { name: '테스트 로그인' }));

    expect(await screen.findByText('login-storage-failed')).toBeInTheDocument();
    expect(screen.getByText('anonymous')).toBeInTheDocument();
    expect(screen.getByText('no-token')).toBeInTheDocument();
  });

  it('does not persist a registration session before verification succeeds', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
      if (url.endsWith('/auth/register')) {
        return new Response(
          JSON.stringify({
            email: 'player@example.test',
            expiresIn: 1800,
            message: 'Check your email.',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/auth/verify-email')) {
        return new Response(JSON.stringify({ ...tokens, user }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    await screen.findByText('anonymous');
    fireEvent.click(screen.getByRole('button', { name: '테스트 가입' }));

    expect(await screen.findByText('player@example.test')).toBeInTheDocument();
    expect(screen.getByText('anonymous')).toBeInTheDocument();
    expect(screen.getByText('no-token')).toBeInTheDocument();
    expect(secureStorage.values.has('fmr.auth.session.v1')).toBe(false);
    const registrationCall = fetchMock.mock.calls.find(([input]) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
      return url.endsWith('/auth/register');
    });
    expect(registrationCall?.[1]?.body).toBe(
      JSON.stringify({ displayName: 'Native Player', email: 'player@example.test' }),
    );

    fireEvent.click(screen.getByRole('button', { name: '이메일 인증' }));
    expect(await screen.findByText(user.displayName)).toBeInTheDocument();
    const verificationCall = fetchMock.mock.calls.find(([input]) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
      return url.endsWith('/auth/verify-email');
    });
    expect(verificationCall?.[1]?.body).toBe(
      JSON.stringify({
        token: 'verification-token',
        password: 'owner-password-123',
        passwordConfirmation: 'owner-password-123',
      }),
    );
    expect(JSON.parse(secureStorage.values.get('fmr.auth.session.v1') ?? '')).toEqual({
      tokens,
      user,
    });
  });

  it('uses the recovery and account-deletion challenge API contracts', async () => {
    secureStorage.values.set('fmr.auth.session.v1', JSON.stringify({ tokens, user }));
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify({ message: 'accepted' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    expect(await screen.findByText(user.displayName)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '재설정 요청' }));
    expect(await screen.findByText('reset-requested')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/auth\/request-password-reset$/),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'player@example.test' }),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: '재설정 완료' }));
    expect(await screen.findByText('password-reset')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/auth\/reset-password$/),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          token: 'reset-token',
          password: 'replacement-password',
          passwordConfirmation: 'replacement-password',
        }),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: '탈퇴 확인 요청' }));
    expect(await screen.findByText('delete-challenge-requested')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/users\/me\/delete-challenge$/),
      expect.objectContaining({ method: 'POST' }),
    );
    const lastCall = fetchMock.mock.calls.at(-1);
    expect(new Headers(lastCall?.[1]?.headers).get('Authorization')).toBe('Bearer native-access');
  });

  it('deletes the server account, its scoped remote cache, and secure session together', async () => {
    secureStorage.values.set('fmr.auth.session.v1', JSON.stringify({ tokens, user }));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    expect(await screen.findByText(user.displayName)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '계정 삭제' }));

    expect(await screen.findByText('cleared')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/users\/me$/),
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({
          email: user.email,
          currentPassword: 'password-123',
        }),
      }),
    );
    expect(remoteCache.deleteRemoteCache).toHaveBeenCalledWith({ userId: user.id });
    expect(secureStorage.values.has('fmr.auth.session.v1')).toBe(false);
    expect(screen.getByText('anonymous')).toBeInTheDocument();
    expect(screen.getByText('no-token')).toBeInTheDocument();
  });

  it('still clears credentials and reports manual cleanup when remote cache removal fails', async () => {
    secureStorage.values.set('fmr.auth.session.v1', JSON.stringify({ tokens, user }));
    remoteCache.deleteRemoteCache.mockRejectedValueOnce(new Error('IndexedDB unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    expect(await screen.findByText(user.displayName)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '계정 삭제' }));

    expect(await screen.findByText('retained')).toBeInTheDocument();
    expect(screen.getByText('anonymous')).toBeInTheDocument();
    expect(screen.getByText('no-token')).toBeInTheDocument();
    expect(secureStorage.values.has('fmr.auth.session.v1')).toBe(false);
  });

  it('ends the in-memory session when secure storage removal fails after server deletion', async () => {
    secureStorage.values.set('fmr.auth.session.v1', JSON.stringify({ tokens, user }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    expect(await screen.findByText(user.displayName)).toBeInTheDocument();
    secureStorage.removeItem.mockRejectedValueOnce(new Error('Keychain unavailable'));
    fireEvent.click(screen.getByRole('button', { name: '계정 삭제' }));

    expect(await screen.findByText('retained')).toBeInTheDocument();
    expect(screen.getByText('anonymous')).toBeInTheDocument();
    expect(screen.getByText('no-token')).toBeInTheDocument();
  });
});
