import { Button, Card, Field, useToast } from '@feelmyrythm/ui';
import { nativeBridge } from '@feelmyrythm/mobile';
import { KeyRound, LogIn, MailCheck, Music2, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { GoogleSignInButton } from '../components/GoogleSignInButton';
import {
  accountDeletionChallengeStatus,
  clearAccountDeletionChallenge,
} from '../lib/accountDeletionChallenge';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

interface AuthFieldErrors {
  displayName?: string;
  email?: string;
  password?: string;
  passwordConfirmation?: string;
}

type PasswordCompletionKind = 'registration' | 'password-reset';

const EMAIL_COMPLETION_MARKER = 'fmr.auth.email-completion.v1';

function readCompletionMarker(): PasswordCompletionKind | null {
  try {
    const value = window.sessionStorage.getItem(EMAIL_COMPLETION_MARKER);
    return value === 'registration' || value === 'password-reset' ? value : null;
  } catch {
    return null;
  }
}

function writeCompletionMarker(kind: PasswordCompletionKind | null): void {
  try {
    if (kind) window.sessionStorage.setItem(EMAIL_COMPLETION_MARKER, kind);
    else window.sessionStorage.removeItem(EMAIL_COMPLETION_MARKER);
  } catch {
    // The marker contains no credential; private storage failure only removes reload guidance.
  }
}

export function validateAuthFields(
  mode: 'login' | 'register',
  values: { displayName: string; email: string; password: string },
): AuthFieldErrors {
  const errors: AuthFieldErrors = {};
  if (mode === 'register' && !values.displayName.trim()) {
    errors.displayName = '이름을 입력하세요.';
  }
  const email = values.email.trim();
  if (!email) errors.email = '이메일을 입력하세요.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = '올바른 이메일 주소를 입력하세요.';
  }
  if (mode === 'login') {
    if (!values.password) errors.password = '비밀번호를 입력하세요.';
    else if (values.password.length < 8) errors.password = '비밀번호는 8자 이상 입력하세요.';
  }
  return errors;
}

export function validatePasswordCompletion(values: {
  password: string;
  passwordConfirmation: string;
}): Pick<AuthFieldErrors, 'password' | 'passwordConfirmation'> {
  const errors: Pick<AuthFieldErrors, 'password' | 'passwordConfirmation'> = {};
  if (!values.password) errors.password = '새 비밀번호를 입력하세요.';
  else if (values.password.length < 8) errors.password = '비밀번호는 8자 이상 입력하세요.';
  else if (values.password.length > 128) errors.password = '비밀번호는 128자 이하로 입력하세요.';
  if (!values.passwordConfirmation) {
    errors.passwordConfirmation = '새 비밀번호를 한 번 더 입력하세요.';
  } else if (values.password !== values.passwordConfirmation) {
    errors.passwordConfirmation = '비밀번호가 일치하지 않습니다.';
  }
  return errors;
}

function descriptionIds(
  fieldId: string,
  hasFieldDescription: boolean,
  hasSubmitError: boolean,
): string | undefined {
  const ids = [
    hasFieldDescription ? `${fieldId}-description` : undefined,
    hasSubmitError ? 'auth-form-error' : undefined,
  ].filter((value): value is string => Boolean(value));
  return ids.length > 0 ? ids.join(' ') : undefined;
}

function withoutFieldError(errors: AuthFieldErrors, field: keyof AuthFieldErrors): AuthFieldErrors {
  const next = { ...errors };
  delete next[field];
  return next;
}

export function loginReturnTarget(state: unknown): string {
  if (typeof state !== 'object' || state === null) return '/dashboard';
  const returnTo = (state as { returnTo?: unknown }).returnTo;
  return typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//')
    ? returnTo
    : '/dashboard';
}

export function LoginPage() {
  const {
    user,
    login,
    register,
    verifyEmail,
    resendVerification,
    requestPasswordReset,
    resetPassword,
    loginWithGoogle,
    logout,
  } = useAuth();
  const { notify } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = loginReturnTarget(location.state);
  const accountDeletionRequested =
    typeof location.state === 'object' &&
    location.state !== null &&
    (location.state as { accountDeletionChallenge?: unknown }).accountDeletionChallenge === true;
  const accountDeletionChallenge = accountDeletionRequested
    ? accountDeletionChallengeStatus(user)
    : { kind: 'none' as const };
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const [verificationEmail, setVerificationEmail] = useState<string>();
  const [resetRequestOpen, setResetRequestOpen] = useState(false);
  const [resetRequestSent, setResetRequestSent] = useState(false);
  const [passwordCompletion, setPasswordCompletion] = useState<{
    kind: PasswordCompletionKind;
    token: string;
  }>();
  const [completionNeedsReopen, setCompletionNeedsReopen] = useState<PasswordCompletionKind | null>(
    () => readCompletionMarker(),
  );
  const [fieldErrors, setFieldErrors] = useState<AuthFieldErrors>({});
  const displayNameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const passwordConfirmationRef = useRef<HTMLInputElement>(null);
  const processedCompletionTokenRef = useRef<string | null>(null);
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim();

  useEffect(() => {
    document.title = '로그인 · FeelMyRythm';
  }, []);

  useLayoutEffect(() => {
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
    const verificationToken = fragment.get('verificationToken');
    const passwordResetToken = fragment.get('passwordResetToken');
    if (!verificationToken && !passwordResetToken) {
      processedCompletionTokenRef.current = null;
      return;
    }

    try {
      if (window.location.hash) {
        window.history.replaceState(
          window.history.state,
          '',
          `${window.location.pathname}${window.location.search}`,
        );
      }
    } catch {
      // React Router removes the fragment immediately below when History is unavailable.
    }
    void navigate(`${location.pathname}${location.search}`, {
      replace: true,
      state: location.state as unknown,
    });

    if ((verificationToken && passwordResetToken) || (!verificationToken && !passwordResetToken)) {
      void Promise.resolve().then(() => {
        writeCompletionMarker(null);
        setPasswordCompletion(undefined);
        setCompletionNeedsReopen(null);
        setSubmitError('유효한 링크를 다시 열어 주세요.');
      });
      return;
    }

    const kind: PasswordCompletionKind = verificationToken ? 'registration' : 'password-reset';
    const token = verificationToken ?? passwordResetToken;
    if (!token || processedCompletionTokenRef.current === `${kind}:${token}`) return;
    processedCompletionTokenRef.current = `${kind}:${token}`;
    writeCompletionMarker(kind);
    void Promise.resolve().then(() => {
      setPasswordCompletion({ kind, token });
      setCompletionNeedsReopen(null);
      setVerificationEmail(undefined);
      setResetRequestOpen(false);
      setResetRequestSent(false);
      setPassword('');
      setPasswordConfirmation('');
      setFieldErrors({});
      setSubmitError(undefined);
    });
  }, [location.hash, location.pathname, location.search, location.state, navigate]);

  useEffect(() => {
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (!fragment.has('verificationToken') && !fragment.has('passwordResetToken')) return;
    void navigate(`${location.pathname}${location.search}`, {
      replace: true,
      state: location.state as unknown,
    });
  }, [location.hash, location.pathname, location.search, location.state, navigate]);

  const submitGoogleCredential = useCallback(
    async (idToken: string) => {
      try {
        await loginWithGoogle(idToken);
        notify({ title: 'Google 계정으로 로그인했습니다.', tone: 'success' });
        void navigate(returnTo, { replace: true });
      } catch (error) {
        notify({
          title: 'Google 계정으로 로그인하지 못했습니다.',
          description: error instanceof Error ? error.message : String(error),
          tone: 'danger',
        });
        throw error;
      }
    },
    [loginWithGoogle, navigate, notify, returnTo],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    const errors = validateAuthFields(mode, { displayName, email, password });
    setFieldErrors(errors);
    const firstInvalid =
      (errors.displayName ? displayNameRef.current : null) ??
      (errors.email ? emailRef.current : null) ??
      (errors.password ? passwordRef.current : null);
    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      if (mode === 'login') {
        await login(email.trim(), password);
        notify({ title: '로그인했습니다.', tone: 'success' });
        void navigate(returnTo, { replace: true });
      } else {
        const pending = await register(displayName.trim(), email.trim());
        setVerificationEmail(pending.email);
        setPassword('');
        notify({
          title: '인증 메일을 보냈습니다.',
          description: `${pending.email} 받은편지함을 확인해 주세요.`,
          tone: 'success',
        });
      }
    } catch (error) {
      if (
        mode === 'login' &&
        error instanceof ApiError &&
        error.status === 403 &&
        error.payload.code === 'EMAIL_VERIFICATION_REQUIRED'
      ) {
        setVerificationEmail(email.trim().toLowerCase());
        setPassword('');
        notify({ title: '로그인 전에 이메일 인증이 필요합니다.' });
        return;
      }
      const description = error instanceof Error ? error.message : String(error);
      setSubmitError(description);
      notify({
        title: mode === 'login' ? '로그인하지 못했습니다.' : '계정을 만들지 못했습니다.',
        description,
        tone: 'danger',
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function completePassword(event: FormEvent) {
    event.preventDefault();
    if (!passwordCompletion) return;
    const errors = validatePasswordCompletion({ password, passwordConfirmation });
    setFieldErrors(errors);
    const firstInvalid =
      (errors.password ? passwordRef.current : null) ??
      (errors.passwordConfirmation ? passwordConfirmationRef.current : null);
    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }

    setSubmitting(true);
    setSubmitError(undefined);
    try {
      if (passwordCompletion.kind === 'registration') {
        await verifyEmail(passwordCompletion.token, password, passwordConfirmation);
        writeCompletionMarker(null);
        setCompletionNeedsReopen(null);
        setPasswordCompletion(undefined);
        notify({ title: '이메일 확인과 비밀번호 설정을 완료했습니다.', tone: 'success' });
        void navigate(returnTo, { replace: true });
      } else {
        await resetPassword(passwordCompletion.token, password, passwordConfirmation);
        logout();
        writeCompletionMarker(null);
        setCompletionNeedsReopen(null);
        setPasswordCompletion(undefined);
        setPassword('');
        setPasswordConfirmation('');
        setMode('login');
        notify({
          title: '새 비밀번호를 저장했습니다.',
          description: '새 비밀번호로 로그인해 주세요.',
          tone: 'success',
        });
      }
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error);
      setSubmitError(description);
      notify({
        title:
          passwordCompletion.kind === 'registration'
            ? '계정 생성을 완료하지 못했습니다.'
            : '비밀번호를 재설정하지 못했습니다.',
        description,
        tone: 'danger',
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function requestReset(event: FormEvent) {
    event.preventDefault();
    const errors = validateAuthFields('register', { displayName: 'reset', email, password: '' });
    const emailError = errors.email;
    setFieldErrors(emailError ? { email: emailError } : {});
    if (emailError) {
      emailRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      await requestPasswordReset(email.trim());
      setResetRequestSent(true);
      notify({
        title: '비밀번호 재설정 메일을 요청했습니다.',
        description: '가입된 계정이라면 받은편지함에 안내가 도착합니다.',
        tone: 'success',
      });
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error);
      setSubmitError(description);
      notify({ title: '재설정 메일을 요청하지 못했습니다.', description, tone: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  async function resend(targetEmail = verificationEmail ?? email.trim()) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
      setFieldErrors((current) => ({ ...current, email: '올바른 이메일 주소를 입력하세요.' }));
      emailRef.current?.focus();
      return;
    }
    setResending(true);
    setSubmitError(undefined);
    try {
      await resendVerification(targetEmail);
      notify({
        title: '인증 메일 전송을 요청했습니다.',
        description: '메일이 오지 않으면 스팸함도 확인해 주세요.',
        tone: 'success',
      });
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error);
      setSubmitError(description);
      notify({ title: '인증 메일을 요청하지 못했습니다.', description, tone: 'danger' });
    } finally {
      setResending(false);
    }
  }

  if (passwordCompletion) {
    const isRegistration = passwordCompletion.kind === 'registration';
    return (
      <div className="page page--narrow auth-page">
        <Card className="auth-card">
          <KeyRound className="auth-card__icon" size={40} aria-hidden />
          <h1>{isRegistration ? '계정 비밀번호 설정' : '새 비밀번호 설정'}</h1>
          <p className="subtle" role="status">
            {isRegistration
              ? '메일 링크를 연 본인이 사용할 새 비밀번호를 정하면 계정 생성과 이메일 확인이 완료됩니다.'
              : '새 비밀번호를 저장하면 다른 기기의 로그인 세션도 모두 만료됩니다.'}
          </p>
          <form
            className="stack"
            aria-describedby={submitError ? 'auth-form-error' : undefined}
            noValidate
            onSubmit={(event) => void completePassword(event)}
          >
            <Field
              ref={passwordRef}
              id="auth-new-password"
              label="새 비밀번호"
              aria-label="새 비밀번호"
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setFieldErrors((current) => withoutFieldError(current, 'password'));
                setSubmitError(undefined);
              }}
              autoComplete="new-password"
              hint="8자 이상 128자 이하로 입력하세요."
              {...(fieldErrors.password ? { error: fieldErrors.password } : {})}
              aria-describedby={descriptionIds('auth-new-password', true, Boolean(submitError))}
            />
            <Field
              ref={passwordConfirmationRef}
              id="auth-password-confirmation"
              label="새 비밀번호 확인"
              aria-label="새 비밀번호 확인"
              type="password"
              value={passwordConfirmation}
              onChange={(event) => {
                setPasswordConfirmation(event.target.value);
                setFieldErrors((current) => withoutFieldError(current, 'passwordConfirmation'));
                setSubmitError(undefined);
              }}
              autoComplete="new-password"
              {...(fieldErrors.passwordConfirmation
                ? { error: fieldErrors.passwordConfirmation }
                : {})}
              aria-describedby={descriptionIds(
                'auth-password-confirmation',
                Boolean(fieldErrors.passwordConfirmation),
                Boolean(submitError),
              )}
            />
            <Button variant="primary" type="submit" disabled={submitting}>
              <KeyRound size={18} aria-hidden />
              {submitting
                ? '저장 중…'
                : isRegistration
                  ? '비밀번호 설정하고 계정 만들기'
                  : '새 비밀번호 저장'}
            </Button>
            <Button
              type="button"
              disabled={submitting}
              onClick={() => {
                writeCompletionMarker(null);
                setCompletionNeedsReopen(null);
                setPasswordCompletion(undefined);
                setPassword('');
                setPasswordConfirmation('');
                setFieldErrors({});
                setSubmitError(undefined);
              }}
            >
              취소하고 로그인으로 돌아가기
            </Button>
            {submitError ? (
              <p id="auth-form-error" className="auth-form-error" role="alert">
                {submitError}
              </p>
            ) : null}
          </form>
        </Card>
      </div>
    );
  }

  if (user) {
    const wrongDeletionAccount =
      accountDeletionRequested && accountDeletionChallenge.kind === 'wrong-account';
    const readyDeletionAccount =
      accountDeletionRequested && accountDeletionChallenge.kind === 'ready';
    return (
      <div className="page page--narrow auth-page">
        <Card className="auth-card">
          <Music2 className="auth-card__icon" size={36} aria-hidden />
          <h1>{user.displayName}님</h1>
          <p className="subtle">{user.email} 계정으로 로그인되어 있습니다.</p>
          {wrongDeletionAccount ? (
            <p className="auth-form-error" role="alert">
              현재 로그인한 계정은 탈퇴 확인 링크를 요청한 계정과 다릅니다. 링크를 요청한 계정으로
              다시 로그인해 주세요.
            </p>
          ) : readyDeletionAccount ? (
            <p role="status">올바른 계정을 확인했습니다. 계정 삭제 확인으로 계속할 수 있습니다.</p>
          ) : accountDeletionRequested ? (
            <p className="auth-form-error" role="alert">
              보안을 위해 탈퇴 확인 링크는 새로고침 후 복원하지 않습니다. 받은 메일의 링크를 다시
              열어 주세요.
            </p>
          ) : null}
          <div className="cluster auth-card__actions">
            {wrongDeletionAccount ? (
              <Button
                variant="primary"
                onClick={() => {
                  logout();
                  notify({ title: '다른 계정으로 로그인해 주세요.' });
                }}
              >
                다른 계정으로 로그인
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => {
                  void navigate(returnTo, { replace: true });
                }}
              >
                {readyDeletionAccount ? '탈퇴 절차 계속' : '프로젝트 열기'}
              </Button>
            )}
            {wrongDeletionAccount ? (
              <Button
                onClick={() => {
                  clearAccountDeletionChallenge();
                  void navigate('/dashboard', { replace: true });
                }}
              >
                탈퇴 취소
              </Button>
            ) : (
              <Button
                onClick={() => {
                  if (accountDeletionRequested) clearAccountDeletionChallenge();
                  logout();
                  notify({ title: '로그아웃했습니다.' });
                }}
              >
                로그아웃
              </Button>
            )}
          </div>
        </Card>
      </div>
    );
  }

  if (verificationEmail) {
    return (
      <div className="page page--narrow auth-page">
        <Card className="auth-card">
          <MailCheck className="auth-card__icon" size={40} aria-hidden />
          <h1>메일을 확인해 주세요</h1>
          <p className="subtle" role="status">
            <strong>{verificationEmail}</strong> 주소로 보낸 링크를 열고 새 비밀번호를 설정하면 계정
            생성이 완료됩니다.
          </p>
          <div className="stack auth-card__actions">
            <Button type="button" disabled={resending} onClick={() => void resend()}>
              <RotateCw size={18} aria-hidden />
              {resending ? '전송 중…' : '인증 메일 다시 보내기'}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setVerificationEmail(undefined);
                setMode('login');
                setSubmitError(undefined);
              }}
            >
              로그인으로 돌아가기
            </Button>
          </div>
          {submitError ? (
            <p className="auth-form-error" role="alert">
              {submitError}
            </p>
          ) : null}
        </Card>
      </div>
    );
  }

  if (resetRequestOpen) {
    return (
      <div className="page page--narrow auth-page">
        <Card className="auth-card">
          <KeyRound className="auth-card__icon" size={40} aria-hidden />
          <h1>비밀번호 재설정</h1>
          <p className="subtle">
            이메일을 입력하면 가입된 계정에만 재설정 링크를 보냅니다. 계정 존재 여부와 관계없이 같은
            안내가 표시됩니다.
          </p>
          {resetRequestSent ? (
            <p className="auth-card__google-note" role="status">
              요청을 접수했습니다. 가입된 계정이라면 메일함과 스팸함을 확인해 주세요.
            </p>
          ) : null}
          <form
            className="stack"
            aria-describedby={submitError ? 'auth-form-error' : undefined}
            noValidate
            onSubmit={(event) => void requestReset(event)}
          >
            <Field
              ref={emailRef}
              id="auth-reset-email"
              label="이메일"
              aria-label="재설정 이메일"
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setFieldErrors((current) => withoutFieldError(current, 'email'));
                setSubmitError(undefined);
                setResetRequestSent(false);
              }}
              autoComplete="email"
              {...(fieldErrors.email ? { error: fieldErrors.email } : {})}
              aria-describedby={descriptionIds(
                'auth-reset-email',
                Boolean(fieldErrors.email),
                Boolean(submitError),
              )}
            />
            <Button variant="primary" type="submit" disabled={submitting}>
              <MailCheck size={18} aria-hidden />
              {submitting ? '요청 중…' : '재설정 메일 보내기'}
            </Button>
            <Button
              type="button"
              disabled={submitting}
              onClick={() => {
                setResetRequestOpen(false);
                setResetRequestSent(false);
                setFieldErrors({});
                setSubmitError(undefined);
              }}
            >
              로그인으로 돌아가기
            </Button>
            {submitError ? (
              <p id="auth-form-error" className="auth-form-error" role="alert">
                {submitError}
              </p>
            ) : null}
          </form>
        </Card>
      </div>
    );
  }

  return (
    <div className="page page--narrow auth-page">
      <Card className="auth-card">
        <div className="auth-card__heading">
          <span className="brand__mark" aria-hidden>
            F
          </span>
          <div>
            <span className="eyebrow">Ensemble workspace</span>
            <h1>{mode === 'login' ? '다시 연습을 시작하세요' : '앙상블 공간 만들기'}</h1>
          </div>
        </div>
        <p className="subtle">
          솔로 메트로놈은 로그인 없이 쓸 수 있습니다. 그룹 공유와 동기 세션에는 계정이 필요합니다.
        </p>
        {accountDeletionRequested ? (
          accountDeletionChallenge.kind === 'login-required' ? (
            <p role="status">탈퇴 확인 링크를 계속하려면 링크를 요청한 계정으로 로그인해 주세요.</p>
          ) : (
            <p className="auth-form-error" role="alert">
              보안을 위해 탈퇴 확인 링크는 새로고침 후 복원하지 않습니다. 받은 메일의 링크를 다시
              열어 주세요.
            </p>
          )
        ) : null}
        {completionNeedsReopen ? (
          <p className="auth-form-error" role="alert">
            보안을 위해 {completionNeedsReopen === 'registration' ? '계정 설정' : '비밀번호 재설정'}{' '}
            링크는 새로고침 후 복원하지 않습니다. 받은 메일의 링크를 다시 열어 주세요.
          </p>
        ) : null}
        {googleClientId && !nativeBridge.native ? (
          <GoogleSignInButton clientId={googleClientId} onCredential={submitGoogleCredential} />
        ) : (
          <p className="auth-card__google-note" role="status">
            {nativeBridge.native
              ? '모바일 앱에서는 이메일 가입과 로그인만 지원합니다.'
              : '현재 배포에서는 Google 로그인이 설정되지 않았습니다. 아래 이메일 로그인을 이용해 주세요.'}
          </p>
        )}
        {googleClientId && !nativeBridge.native ? (
          <div className="auth-card__divider" aria-hidden>
            <span>또는</span>
          </div>
        ) : null}
        {mode === 'register' ? (
          <p className="subtle" role="note">
            이 단계에서는 비밀번호를 받지 않습니다. 메일 링크를 연 뒤 새 비밀번호를 설정합니다.
          </p>
        ) : null}
        <form
          className="stack"
          aria-describedby={submitError ? 'auth-form-error' : undefined}
          noValidate
          onSubmit={(event) => void submit(event)}
        >
          {mode === 'register' ? (
            <Field
              ref={displayNameRef}
              id="auth-display-name"
              label="이름"
              aria-label="이름"
              value={displayName}
              onChange={(event) => {
                setDisplayName(event.target.value);
                setFieldErrors((current) => withoutFieldError(current, 'displayName'));
                setSubmitError(undefined);
              }}
              autoComplete="name"
              {...(fieldErrors.displayName ? { error: fieldErrors.displayName } : {})}
              aria-describedby={descriptionIds(
                'auth-display-name',
                Boolean(fieldErrors.displayName),
                Boolean(submitError),
              )}
            />
          ) : null}
          <Field
            ref={emailRef}
            id="auth-email"
            label="이메일"
            aria-label="이메일"
            type="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setFieldErrors((current) => withoutFieldError(current, 'email'));
              setSubmitError(undefined);
            }}
            autoComplete="email"
            {...(fieldErrors.email ? { error: fieldErrors.email } : {})}
            aria-describedby={descriptionIds(
              'auth-email',
              Boolean(fieldErrors.email),
              Boolean(submitError),
            )}
          />
          {mode === 'login' ? (
            <Field
              ref={passwordRef}
              id="auth-password"
              label="비밀번호"
              aria-label="비밀번호"
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setFieldErrors((current) => withoutFieldError(current, 'password'));
                setSubmitError(undefined);
              }}
              autoComplete="current-password"
              hint="8자 이상 입력하세요."
              {...(fieldErrors.password ? { error: fieldErrors.password } : {})}
              aria-describedby={descriptionIds('auth-password', true, Boolean(submitError))}
            />
          ) : null}
          <Button variant="primary" type="submit" disabled={submitting}>
            <LogIn size={18} aria-hidden />
            {submitting ? '처리 중…' : mode === 'login' ? '로그인' : '계정 만들기'}
          </Button>
          {mode === 'login' ? (
            <>
              <Button
                type="button"
                onClick={() => {
                  setResetRequestOpen(true);
                  setResetRequestSent(false);
                  setFieldErrors({});
                  setSubmitError(undefined);
                }}
              >
                <KeyRound size={18} aria-hidden />
                비밀번호를 잊으셨나요?
              </Button>
              <Button type="button" disabled={resending} onClick={() => void resend()}>
                <RotateCw size={18} aria-hidden />
                {resending ? '전송 중…' : '인증 메일 다시 보내기'}
              </Button>
            </>
          ) : null}
          {submitError ? (
            <p id="auth-form-error" className="auth-form-error" role="alert">
              {submitError}
            </p>
          ) : null}
        </form>
        <button
          className="auth-card__mode"
          type="button"
          onClick={() => {
            setMode((current) => (current === 'login' ? 'register' : 'login'));
            setPassword('');
            setFieldErrors({});
            setSubmitError(undefined);
          }}
        >
          {mode === 'login' ? '처음인가요? 계정 만들기' : '이미 계정이 있나요? 로그인'}
        </button>
      </Card>
    </div>
  );
}
