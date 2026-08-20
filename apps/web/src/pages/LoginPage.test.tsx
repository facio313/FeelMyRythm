import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type * as FeelMyRythmUi from '@feelmyrythm/ui';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeState = vi.hoisted(() => ({ native: false }));
interface MockAuthUser {
  id: string;
  email: string;
  displayName: string;
  hasPassword: boolean;
}

const auth = vi.hoisted(() => ({
  user: null as MockAuthUser | null,
  login: vi.fn(),
  register: vi.fn(),
  verifyEmail: vi.fn(),
  resendVerification: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
  loginWithGoogle: vi.fn(),
  logout: vi.fn(),
}));
const notify = vi.hoisted(() => vi.fn());

vi.mock('@feelmyrythm/mobile', () => ({ nativeBridge: nativeState }));

vi.mock('../lib/auth', () => ({
  useAuth: () => auth,
}));

vi.mock('../components/GoogleSignInButton', () => ({
  GoogleSignInButton: ({ clientId }: { clientId: string }) => (
    <button type="button">Google 로그인 ({clientId})</button>
  ),
}));

vi.mock('@feelmyrythm/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof FeelMyRythmUi>();
  return {
    ...actual,
    useToast: () => ({ notify }),
  };
});

import { ApiError } from '../lib/api';
import {
  captureAccountDeletionChallenge,
  clearAccountDeletionChallenge,
} from '../lib/accountDeletionChallenge';
import {
  LoginPage,
  loginReturnTarget,
  validateAuthFields,
  validatePasswordCompletion,
} from './LoginPage';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-hash">{location.hash || 'empty'}</output>;
}

function accountDeleteProof(user: Pick<MockAuthUser, 'id' | 'email'>): string {
  const encode = (value: object) =>
    window.btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    typ: 'account_delete',
    sub: user.id,
    email: user.email,
    google_sub: 'google-delete-user',
    gen: 2,
  })}.test-signature`;
}

describe('LoginPage accessibility and secure email flows', () => {
  beforeEach(() => {
    nativeState.native = false;
    auth.user = null;
    clearAccountDeletionChallenge();
    auth.login.mockReset().mockResolvedValue(undefined);
    auth.register.mockReset().mockResolvedValue({
      email: 'new-player@example.test',
      expiresIn: 1800,
      message: 'Check your email.',
    });
    auth.verifyEmail.mockReset().mockResolvedValue(undefined);
    auth.resendVerification.mockReset().mockResolvedValue(undefined);
    auth.requestPasswordReset.mockReset().mockResolvedValue(undefined);
    auth.resetPassword.mockReset().mockResolvedValue(undefined);
    auth.loginWithGoogle.mockReset().mockResolvedValue(undefined);
    auth.logout.mockReset();
    notify.mockReset();
    window.sessionStorage.clear();
    document.title = 'FeelMyRythm';
  });

  afterEach(() => {
    cleanup();
    clearAccountDeletionChallenge();
    vi.unstubAllEnvs();
    window.sessionStorage.clear();
  });

  it('validates each login field and links its inline error to the input', () => {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    expect(document.title).toBe('로그인 · FeelMyRythm');
    expect(screen.getByRole('status')).toHaveTextContent('Google 로그인이 설정되지 않았습니다');
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));

    const email = screen.getByLabelText(/이메일/);
    const password = screen.getByLabelText(/^비밀번호$/);
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveAttribute('aria-describedby', 'auth-email-description');
    expect(document.getElementById('auth-email-description')).toHaveTextContent(
      '이메일을 입력하세요.',
    );
    expect(password).toHaveAttribute('aria-invalid', 'true');
    expect(password).toHaveAttribute('aria-describedby', 'auth-password-description');
    expect(document.getElementById('auth-password-description')).toHaveTextContent(
      '비밀번호를 입력하세요.',
    );
    expect(email).toHaveFocus();
    expect(auth.login).not.toHaveBeenCalled();
  });

  it('offers only central login in managed-local SSO builds', () => {
    vi.stubEnv('VITE_FMR_MANAGED_LOCAL_SSO', 'true');
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'configured-but-disabled-client');
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    expect(screen.getByText(/중앙 관리자가 만든 통합 로그인 계정/)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: '처음인가요? 계정 만들기' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '비밀번호를 잊으셨나요?' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '인증 메일 다시 보내기' })).not.toBeInTheDocument();
    expect(document.querySelector('.google-sign-in')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '로그인' })).toBeEnabled();
  });

  it('does not request or validate a password during initial registration', async () => {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '처음인가요? 계정 만들기' }));

    expect(screen.queryByLabelText(/^비밀번호$/)).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('이 단계에서는 비밀번호를 받지 않습니다');
    fireEvent.change(screen.getByLabelText(/이름/), { target: { value: 'New Player' } });
    fireEvent.change(screen.getByLabelText(/이메일/), {
      target: { value: 'new-player@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: '계정 만들기' }));

    expect(
      await screen.findByRole('heading', { name: '메일을 확인해 주세요' }),
    ).toBeInTheDocument();
    expect(auth.register).toHaveBeenCalledWith('New Player', 'new-player@example.test');
    expect(screen.getByText(/새 비밀번호를 설정하면/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '인증 메일 다시 보내기' }));
    await waitFor(() => {
      expect(auth.resendVerification).toHaveBeenCalledWith('new-player@example.test');
    });
  });

  it('validates registration identity fields without accepting a preclaim password', () => {
    expect(
      validateAuthFields('register', {
        displayName: ' ',
        email: 'not-an-email',
        password: 'short',
      }),
    ).toEqual({
      displayName: '이름을 입력하세요.',
      email: '올바른 이메일 주소를 입력하세요.',
    });
    expect(
      validatePasswordCompletion({ password: 'password-123', passwordConfirmation: 'different' }),
    ).toEqual({ passwordConfirmation: '비밀번호가 일치하지 않습니다.' });
  });

  it('links a server submit error to both login credential fields', async () => {
    auth.login.mockRejectedValue(new Error('이메일 또는 비밀번호를 확인하세요.'));
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText(/이메일/), {
      target: { value: 'player@example.test' },
    });
    fireEvent.change(screen.getByLabelText(/^비밀번호$/), {
      target: { value: 'password-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '이메일 또는 비밀번호를 확인하세요.',
    );
    await waitFor(() => {
      expect(screen.getByLabelText(/이메일/)).toHaveAttribute(
        'aria-describedby',
        'auth-form-error',
      );
      expect(screen.getByLabelText(/^비밀번호$/)).toHaveAttribute(
        'aria-describedby',
        'auth-password-description auth-form-error',
      );
    });
  });

  it('returns to a same-app invitation route after login and rejects external targets', async () => {
    render(
      <MemoryRouter
        initialEntries={[
          { pathname: '/login', state: { returnTo: '/session/invited-room?from=invite' } },
        ]}
      >
        <Routes>
          <Route path="login" element={<LoginPage />} />
          <Route path="session/:roomId" element={<div>초대 세션으로 복귀</div>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText(/이메일/), {
      target: { value: 'player@example.test' },
    });
    fireEvent.change(screen.getByLabelText(/^비밀번호$/), {
      target: { value: 'password-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));

    expect(await screen.findByText('초대 세션으로 복귀')).toBeInTheDocument();
    expect(loginReturnTarget({ returnTo: '//evil.example' })).toBe('/dashboard');
    expect(loginReturnTarget({ returnTo: 'https://evil.example' })).toBe('/dashboard');
  });

  it('guides a logged-out deletion-link arrival without rendering or persisting its proof', () => {
    const owner = { id: 'delete-owner', email: 'owner@example.test' };
    const proof = accountDeleteProof(owner);
    expect(captureAccountDeletionChallenge(proof)).toBe(true);

    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/login',
            state: { returnTo: '/settings', accountDeletionChallenge: true },
          },
        ]}
      >
        <LoginPage />
      </MemoryRouter>,
    );

    expect(
      screen.getByText('탈퇴 확인 링크를 계속하려면 링크를 요청한 계정으로 로그인해 주세요.'),
    ).toHaveTextContent('탈퇴 확인 링크를 계속하려면 링크를 요청한 계정으로 로그인해 주세요');
    expect(document.body).not.toHaveTextContent(proof);
    expect(window.sessionStorage.getItem('fmr.account-delete-link-consumed.v1')).toBeNull();
  });

  it('requires switching accounts when a deletion link belongs to another user', () => {
    const proof = accountDeleteProof({ id: 'delete-owner', email: 'owner@example.test' });
    expect(captureAccountDeletionChallenge(proof)).toBe(true);
    auth.user = {
      id: 'other-user',
      email: 'other@example.test',
      displayName: 'Other Player',
      hasPassword: false,
    };

    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/login',
            state: { returnTo: '/settings', accountDeletionChallenge: true },
          },
        ]}
      >
        <LoginPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      '현재 로그인한 계정은 탈퇴 확인 링크를 요청한 계정과 다릅니다',
    );
    expect(screen.queryByRole('button', { name: '탈퇴 절차 계속' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '다른 계정으로 로그인' }));
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(document.body).not.toHaveTextContent(proof);
  });

  it('resumes deletion only for the matching authenticated account', async () => {
    const owner = { id: 'delete-owner', email: 'owner@example.test' };
    expect(captureAccountDeletionChallenge(accountDeleteProof(owner))).toBe(true);
    auth.user = {
      ...owner,
      displayName: 'Delete Owner',
      hasPassword: false,
    };

    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/login',
            state: { returnTo: '/settings', accountDeletionChallenge: true },
          },
        ]}
      >
        <Routes>
          <Route path="login" element={<LoginPage />} />
          <Route path="settings" element={<div>계정 삭제 확인 화면</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('status')).toHaveTextContent('올바른 계정을 확인했습니다');
    fireEvent.click(screen.getByRole('button', { name: '탈퇴 절차 계속' }));
    expect(await screen.findByText('계정 삭제 확인 화면')).toBeInTheDocument();
  });

  it('offers resend when login is blocked for an unverified email', async () => {
    auth.login.mockRejectedValue(
      new ApiError(403, {
        detail: {
          code: 'EMAIL_VERIFICATION_REQUIRED',
          message: 'Verify your email before signing in.',
        },
      }),
    );
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText(/이메일/), {
      target: { value: 'pending@example.test' },
    });
    fireEvent.change(screen.getByLabelText(/^비밀번호$/), {
      target: { value: 'password-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));

    expect(
      await screen.findByRole('heading', { name: '메일을 확인해 주세요' }),
    ).toBeInTheDocument();
    expect(screen.getByText('pending@example.test')).toBeInTheDocument();
  });

  it('removes a verification token fragment before the owner sets a new password', async () => {
    render(
      <MemoryRouter initialEntries={['/login#verificationToken=signed-token']}>
        <LocationProbe />
        <Routes>
          <Route path="login" element={<LoginPage />} />
          <Route path="dashboard" element={<div>인증 후 대시보드</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: '계정 비밀번호 설정' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('location-hash')).toHaveTextContent('empty'));
    expect(auth.verifyEmail).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('새 비밀번호'), {
      target: { value: 'owner-password-123' },
    });
    fireEvent.change(screen.getByLabelText('새 비밀번호 확인'), {
      target: { value: 'owner-password-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: '비밀번호 설정하고 계정 만들기' }));

    expect(await screen.findByText('인증 후 대시보드')).toBeInTheDocument();
    expect(auth.verifyEmail).toHaveBeenCalledWith(
      'signed-token',
      'owner-password-123',
      'owner-password-123',
    );
    expect(window.sessionStorage.getItem('fmr.auth.email-completion.v1')).toBeNull();
  });

  it('keeps a completion token in memory when validation or the server rejects it', async () => {
    auth.verifyEmail.mockRejectedValueOnce(new Error('링크가 만료되었습니다.'));
    render(
      <MemoryRouter initialEntries={['/login#verificationToken=signed-token']}>
        <LoginPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: '계정 비밀번호 설정' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('새 비밀번호'), {
      target: { value: 'owner-password-123' },
    });
    fireEvent.change(screen.getByLabelText('새 비밀번호 확인'), {
      target: { value: 'mismatch-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: '비밀번호 설정하고 계정 만들기' }));
    expect(screen.getByText('비밀번호가 일치하지 않습니다.')).toBeInTheDocument();
    expect(auth.verifyEmail).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('새 비밀번호 확인'), {
      target: { value: 'owner-password-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: '비밀번호 설정하고 계정 만들기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('링크가 만료되었습니다.');

    fireEvent.click(screen.getByRole('button', { name: '비밀번호 설정하고 계정 만들기' }));
    await waitFor(() => expect(auth.verifyEmail).toHaveBeenCalledTimes(2));
    expect(auth.verifyEmail).toHaveBeenLastCalledWith(
      'signed-token',
      'owner-password-123',
      'owner-password-123',
    );
  });

  it('uses a generic reset request and completes a one-time reset link', async () => {
    const firstRender = render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '비밀번호를 잊으셨나요?' }));
    fireEvent.change(screen.getByLabelText('재설정 이메일'), {
      target: { value: 'player@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: '재설정 메일 보내기' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      '가입된 계정이라면 메일함과 스팸함을 확인해 주세요',
    );
    expect(auth.requestPasswordReset).toHaveBeenCalledWith('player@example.test');
    firstRender.unmount();

    render(
      <MemoryRouter initialEntries={['/login#passwordResetToken=reset-token']}>
        <LocationProbe />
        <LoginPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: '새 비밀번호 설정' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('location-hash')).toHaveTextContent('empty'));
    fireEvent.change(screen.getByLabelText('새 비밀번호'), {
      target: { value: 'replacement-password' },
    });
    fireEvent.change(screen.getByLabelText('새 비밀번호 확인'), {
      target: { value: 'replacement-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: '새 비밀번호 저장' }));

    await waitFor(() => {
      expect(auth.resetPassword).toHaveBeenCalledWith(
        'reset-token',
        'replacement-password',
        'replacement-password',
      );
    });
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(await screen.findByRole('button', { name: '로그인' })).toBeInTheDocument();
  });

  it('does not restore a secret token after reload and tells the user to reopen the email', () => {
    window.sessionStorage.setItem('fmr.auth.email-completion.v1', 'password-reset');
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      '보안을 위해 비밀번호 재설정 링크는 새로고침 후 복원하지 않습니다',
    );
    expect(window.sessionStorage.getItem('fmr.auth.email-completion.v1')).toBe('password-reset');
  });

  it('hides Google GIS in every native build while keeping it in the browser', () => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'browser-client-id');
    nativeState.native = true;
    const nativeRender = render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: /Google 로그인/ })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      '모바일 앱에서는 이메일 가입과 로그인만 지원합니다',
    );
    nativeRender.unmount();

    nativeState.native = false;
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /Google 로그인/ })).toBeInTheDocument();
  });
});
