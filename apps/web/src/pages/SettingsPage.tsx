import { nativeBridge } from '@feelmyrythm/mobile';
import { Button, Card, Field, Modal, StatusBadge, useToast } from '@feelmyrythm/ui';
import { LogOut, MailCheck, Moon, Palette, Sun, Trash2, UserRound, WifiOff } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { GoogleSignInButton } from '../components/GoogleSignInButton';
import { PageHeader } from '../components/PageHeader';
import {
  accountDeletionChallengeStatus,
  captureAccountDeletionChallenge,
  clearAccountDeletionChallenge,
} from '../lib/accountDeletionChallenge';
import { useAuth } from '../lib/auth';
import { storageEstimate } from '../lib/localDb';
import { applyTheme, readStoredTheme, type AppTheme } from '../lib/theme';
import {
  parseVisualOffsetMs,
  readVisualOffsetMs,
  VISUAL_OFFSET_MAX_MS,
  VISUAL_OFFSET_MIN_MS,
  VISUAL_OFFSET_STORAGE_KEY,
} from '../lib/useMetronome';

type StorageEstimateState =
  | { status: 'loading' }
  | { status: 'unsupported' }
  | { status: 'ready'; usage: number; quota: number }
  | { status: 'error'; message: string };

const themes: AppTheme[] = ['dark', 'light'];

export function SettingsPage() {
  const { notify } = useToast();
  const { user, logout, deleteAccount, requestAccountDeletionChallenge } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [theme, setTheme] = useState<AppTheme>(() => readStoredTheme());
  const [countIn, setCountIn] = useState(() =>
    Number(localStorage.getItem('fmr.countInMeasures') ?? 1),
  );
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('fmr.volume') ?? 0.75));
  const [visualOffsetInput, setVisualOffsetInput] = useState(() => String(readVisualOffsetMs()));
  const [storageState, setStorageState] = useState<StorageEstimateState>({ status: 'loading' });
  const [storageCheckAttempt, setStorageCheckAttempt] = useState(0);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteEmail, setDeleteEmail] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteGoogleIdToken, setDeleteGoogleIdToken] = useState<string>();
  const [deleteAccountToken, setDeleteAccountToken] = useState<string>();
  const [deleteChallengeSent, setDeleteChallengeSent] = useState(false);
  const [requestingDeleteChallenge, setRequestingDeleteChallenge] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [deleteChallengeError, setDeleteChallengeError] = useState<string>();
  const themeRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const processedAccountDeleteTokenRef = useRef<string | null>(null);
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim();
  const visualOffsetMs = parseVisualOffsetMs(visualOffsetInput);
  const visualOffsetError =
    visualOffsetInput.trim() === ''
      ? '시각 오프셋을 입력하세요.'
      : visualOffsetMs === null
        ? `${VISUAL_OFFSET_MIN_MS}ms에서 ${VISUAL_OFFSET_MAX_MS}ms 사이의 값을 입력하세요.`
        : undefined;
  const deleteEmailMatches =
    Boolean(user) && deleteEmail.trim().toLowerCase() === user?.email.toLowerCase();
  const deletePasswordMissing = Boolean(user?.hasPassword && !deletePassword);
  const deleteIdentityProofMissing = Boolean(
    user && !user.hasPassword && !deleteGoogleIdToken && !deleteAccountToken,
  );

  useLayoutEffect(() => {
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
    const entries = [...fragment.entries()];
    if (!entries.some(([key]) => key === 'accountDeleteToken')) return;
    const [key, proof] = entries[0] ?? [];
    const exactProof = entries.length === 1 && key === 'accountDeleteToken' && proof ? proof : null;
    processedAccountDeleteTokenRef.current = null;
    if (!exactProof || !captureAccountDeletionChallenge(exactProof)) {
      clearAccountDeletionChallenge();
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
      // React Router also removes the fragment as soon as its navigation effect is active.
    }
    void navigate(`${location.pathname}${location.search}`, {
      replace: true,
      state: location.state as unknown,
    });
  }, [location.hash, location.pathname, location.search, location.state, navigate]);

  useEffect(() => {
    const openRequested =
      typeof location.state === 'object' &&
      location.state !== null &&
      (location.state as { openAccountDeletion?: unknown }).openAccountDeletion === true;
    const challenge = accountDeletionChallengeStatus(user);
    if (challenge.kind === 'login-required' || challenge.kind === 'wrong-account') {
      void navigate('/login', {
        replace: true,
        state: { returnTo: '/settings', accountDeletionChallenge: true },
      });
      return;
    }

    if (challenge.kind === 'ready' && processedAccountDeleteTokenRef.current !== challenge.proof) {
      processedAccountDeleteTokenRef.current = challenge.proof;
      void navigate(`${location.pathname}${location.search}`, {
        replace: true,
        state: openRequested ? null : (location.state as unknown),
      });
      setDeleteAccountToken(user?.hasPassword ? undefined : challenge.proof);
      setDeleteGoogleIdToken(undefined);
      setDeleteChallengeSent(false);
      setDeleteEmail('');
      setDeletePassword('');
      setDeleteError(undefined);
      setDeleteChallengeError(undefined);
      setDeleteOpen(true);
      return;
    }

    if (user && openRequested) {
      clearAccountDeletionChallenge();
      void navigate(
        { pathname: location.pathname, search: location.search, hash: '' },
        { replace: true, state: null },
      );
      void Promise.resolve().then(() => {
        setDeleteEmail('');
        setDeletePassword('');
        setDeleteGoogleIdToken(undefined);
        setDeleteAccountToken(undefined);
        setDeleteChallengeSent(false);
        setDeleteError(undefined);
        setDeleteChallengeError(undefined);
        setDeleteOpen(true);
      });
    }
  }, [location.hash, location.pathname, location.search, location.state, navigate, user]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    void storageEstimate()
      .then((estimate) => {
        if (cancelled) return;
        setStorageState(
          estimate
            ? { status: 'ready', usage: estimate.usage, quota: estimate.quota }
            : { status: 'unsupported' },
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setStorageState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [storageCheckAttempt]);

  const handleThemeKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | undefined;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (index - 1 + themes.length) % themes.length;
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (index + 1) % themes.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = themes.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const nextTheme = themes[nextIndex];
    if (!nextTheme) return;
    setTheme(nextTheme);
    themeRefs.current[nextIndex]?.focus();
  };

  const save = () => {
    if (visualOffsetMs === null) return;
    localStorage.setItem('fmr.countInMeasures', String(countIn));
    localStorage.setItem('fmr.volume', String(volume));
    localStorage.setItem(VISUAL_OFFSET_STORAGE_KEY, String(visualOffsetMs));
    notify({ title: '연습 설정을 저장했습니다.', tone: 'success' });
  };

  const closeDeleteDialog = () => {
    if (deletingAccount) return;
    clearAccountDeletionChallenge();
    processedAccountDeleteTokenRef.current = null;
    setDeleteOpen(false);
    setDeleteEmail('');
    setDeletePassword('');
    setDeleteGoogleIdToken(undefined);
    setDeleteAccountToken(undefined);
    setDeleteChallengeSent(false);
    setDeleteError(undefined);
    setDeleteChallengeError(undefined);
  };

  const openDeleteDialog = () => {
    clearAccountDeletionChallenge();
    processedAccountDeleteTokenRef.current = null;
    setDeleteEmail('');
    setDeletePassword('');
    setDeleteGoogleIdToken(undefined);
    setDeleteAccountToken(undefined);
    setDeleteChallengeSent(false);
    setDeleteError(undefined);
    setDeleteChallengeError(undefined);
    setDeleteOpen(true);
  };

  const acceptGoogleDeleteProof = (idToken: string): Promise<void> => {
    clearAccountDeletionChallenge();
    processedAccountDeleteTokenRef.current = null;
    setDeleteGoogleIdToken(idToken);
    setDeleteAccountToken(undefined);
    setDeleteChallengeError(undefined);
    return Promise.resolve();
  };

  const requestDeleteChallenge = async () => {
    setRequestingDeleteChallenge(true);
    setDeleteChallengeError(undefined);
    try {
      await requestAccountDeletionChallenge();
      setDeleteChallengeSent(true);
    } catch (error) {
      setDeleteChallengeError(error instanceof Error ? error.message : String(error));
    } finally {
      setRequestingDeleteChallenge(false);
    }
  };

  const removeAccount = async () => {
    if (!user || !deleteEmailMatches || deletePasswordMissing || deleteIdentityProofMissing) return;
    const proof = user.hasPassword
      ? { currentPassword: deletePassword }
      : deleteGoogleIdToken
        ? { googleIdToken: deleteGoogleIdToken }
        : deleteAccountToken
          ? { accountDeleteToken: deleteAccountToken }
          : undefined;
    if (!proof) return;
    setDeletingAccount(true);
    setDeleteError(undefined);
    try {
      const result = await deleteAccount(deleteEmail.trim(), proof);
      notify({
        title: '계정을 삭제했습니다.',
        description: result.localCacheCleared
          ? '이 기기의 로그인 전용 오프라인 사본도 삭제했습니다.'
          : '서버 계정은 삭제됐지만 이 기기의 사이트 데이터를 수동으로 지워 주세요.',
        tone: result.localCacheCleared ? 'success' : 'info',
      });
      clearAccountDeletionChallenge();
      processedAccountDeleteTokenRef.current = null;
      setDeleteOpen(false);
      void navigate('/login', { replace: true });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingAccount(false);
    }
  };

  return (
    <div className="page page--narrow">
      <PageHeader
        eyebrow="Preferences"
        title="설정"
        description="이 기기의 연습 환경과 오프라인 저장 공간을 관리합니다."
      />
      <div className="stack">
        <Card>
          <div className="settings-heading">
            <Palette aria-hidden />
            <div>
              <h2>화면 테마</h2>
              <p className="subtle">기본값은 어두운 연습실에 맞춘 다크 테마입니다.</p>
            </div>
          </div>
          <div className="theme-picker" role="radiogroup" aria-label="화면 테마">
            <Button
              ref={(element) => {
                themeRefs.current[0] = element;
              }}
              role="radio"
              aria-checked={theme === 'dark'}
              tabIndex={theme === 'dark' ? 0 : -1}
              variant={theme === 'dark' ? 'primary' : 'secondary'}
              onClick={() => setTheme('dark')}
              onKeyDown={(event) => handleThemeKeyDown(event, 0)}
            >
              <Moon size={18} aria-hidden /> 다크
            </Button>
            <Button
              ref={(element) => {
                themeRefs.current[1] = element;
              }}
              role="radio"
              aria-checked={theme === 'light'}
              tabIndex={theme === 'light' ? 0 : -1}
              variant={theme === 'light' ? 'primary' : 'secondary'}
              onClick={() => setTheme('light')}
              onKeyDown={(event) => handleThemeKeyDown(event, 1)}
            >
              <Sun size={18} aria-hidden /> 라이트
            </Button>
          </div>
        </Card>

        <Card>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <h2>메트로놈 기본값</h2>
            <Field
              label="예비박 마디"
              type="number"
              min={1}
              max={2}
              value={countIn}
              onChange={(event) => setCountIn(Number(event.target.value))}
            />
            <label className="range-field">
              <span>볼륨</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(event) => setVolume(Number(event.target.value))}
              />
              <output className="fmr-tabular">{Math.round(volume * 100)}%</output>
            </label>
            <Field
              label="시각 오프셋 (ms)"
              type="number"
              min={VISUAL_OFFSET_MIN_MS}
              max={VISUAL_OFFSET_MAX_MS}
              step={0.1}
              value={visualOffsetInput}
              onChange={(event) => setVisualOffsetInput(event.target.value)}
              hint="양수는 늦게 보이는 박 표시를 앞당기고, 음수는 늦춥니다. 오디오 클릭 시점은 바뀌지 않습니다."
              {...(visualOffsetError ? { error: visualOffsetError } : {})}
            />
            <Button variant="primary" type="submit" disabled={visualOffsetMs === null}>
              저장
            </Button>
          </form>
        </Card>

        <Card>
          <div className="settings-heading">
            <WifiOff aria-hidden />
            <div>
              <h2>오프라인 데이터</h2>
              <p className="subtle">
                템포맵과 악보는 이 기기에 저장되어 네트워크 없이도 솔로 연습할 수 있습니다.
              </p>
            </div>
          </div>
          {storageState.status === 'loading' ? (
            <div role="status" aria-live="polite" aria-busy="true">
              <StatusBadge>저장 공간 확인 중…</StatusBadge>
            </div>
          ) : storageState.status === 'ready' ? (
            <div role="status">
              <StatusBadge tone="info">
                {(storageState.usage / 1024 / 1024).toFixed(1)}MB /{' '}
                {(storageState.quota / 1024 / 1024).toFixed(0)}MB 사용
              </StatusBadge>
            </div>
          ) : storageState.status === 'unsupported' ? (
            <div role="status">
              <StatusBadge>이 브라우저는 저장 공간 용량 확인을 지원하지 않습니다.</StatusBadge>
            </div>
          ) : (
            <div className="settings-storage-error" role="alert">
              <span>저장 공간 정보를 확인하지 못했습니다: {storageState.message}</span>
              <Button
                size="compact"
                variant="ghost"
                onClick={() => {
                  setStorageState({ status: 'loading' });
                  setStorageCheckAttempt((attempt) => attempt + 1);
                }}
              >
                다시 시도
              </Button>
            </div>
          )}
        </Card>

        {user ? (
          <Card>
            <div className="settings-heading">
              <UserRound aria-hidden />
              <div>
                <h2>계정</h2>
                <p className="subtle">
                  {user.displayName} · {user.email}
                </p>
              </div>
            </div>
            <div className="cluster">
              <Button
                onClick={() => {
                  logout();
                  void navigate('/login', { replace: true });
                }}
              >
                <LogOut size={18} aria-hidden /> 로그아웃
              </Button>
              <Button variant="danger" onClick={openDeleteDialog}>
                <Trash2 size={18} aria-hidden /> 계정 삭제
              </Button>
            </div>
          </Card>
        ) : null}
      </div>

      <Modal
        open={Boolean(user && deleteOpen)}
        onOpenChange={(open) => {
          if (!open) closeDeleteDialog();
        }}
        title="계정을 영구 삭제합니다"
        description="이 작업은 되돌릴 수 없습니다. 소유한 그룹·프로젝트·악보 원본과 개인 필기·연습 기록·보정값이 삭제되며, 다른 그룹의 공유 이력에는 익명 작성자만 남습니다. 이 기기의 개인 로컬 연습 데이터는 유지됩니다."
      >
        {user && !user.hasPassword && !nativeBridge.native ? (
          <div className="stack">
            <p className="subtle">Google 계정으로 다시 확인하거나 이메일 보안 링크를 여세요.</p>
            {googleClientId ? (
              <GoogleSignInButton
                clientId={googleClientId}
                onCredential={acceptGoogleDeleteProof}
              />
            ) : (
              <p className="subtle" role="status">
                현재 배포에서는 Google 재인증을 사용할 수 없습니다. 이메일 보안 링크를 이용해
                주세요.
              </p>
            )}
            {deleteGoogleIdToken ? (
              <p role="status" aria-live="polite">
                Google 계정 확인을 완료했습니다.
              </p>
            ) : null}
          </div>
        ) : null}
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void removeAccount();
          }}
        >
          <Field
            label="계정 이메일 확인"
            type="email"
            autoComplete="email"
            value={deleteEmail}
            onChange={(event) => setDeleteEmail(event.target.value)}
            {...(user ? { hint: `${user.email}을(를) 정확히 입력하세요.` } : {})}
            {...(deleteEmail && !deleteEmailMatches
              ? { error: '현재 계정 이메일과 일치하지 않습니다.' }
              : {})}
          />
          {user?.hasPassword ? (
            <Field
              label="현재 비밀번호"
              type="password"
              autoComplete="current-password"
              value={deletePassword}
              onChange={(event) => setDeletePassword(event.target.value)}
              {...(deletePasswordMissing && deleteEmailMatches
                ? { error: '현재 비밀번호를 입력하세요.' }
                : {})}
            />
          ) : (
            <div className="stack">
              {nativeBridge.native ? (
                <p className="subtle">
                  모바일 앱에서는 탈퇴 확인 이메일의 보안 링크로 본인 확인을 완료해야 합니다.
                </p>
              ) : null}
              {deleteAccountToken ? (
                <p role="status" aria-live="polite">
                  이메일 보안 링크로 본인 확인을 완료했습니다.
                </p>
              ) : deleteIdentityProofMissing ? (
                <p className="subtle">
                  계정을 삭제하려면 먼저 Google 또는 이메일 보안 링크로 본인 확인을 완료하세요.
                </p>
              ) : null}
              <Button
                type="button"
                onClick={() => void requestDeleteChallenge()}
                disabled={requestingDeleteChallenge || deletingAccount}
              >
                <MailCheck size={18} aria-hidden />
                {requestingDeleteChallenge
                  ? '전송 중…'
                  : deleteChallengeSent
                    ? '탈퇴 확인 이메일 다시 보내기'
                    : '탈퇴 확인 이메일 보내기'}
              </Button>
              {deleteChallengeSent ? (
                <p role="status" aria-live="polite">
                  탈퇴 확인 이메일을 보냈습니다. 이 탭에서 메일의 보안 링크를 열어 주세요.
                </p>
              ) : null}
              {deleteChallengeError ? (
                <p role="alert" className="field-error">
                  탈퇴 확인 이메일을 보내지 못했습니다: {deleteChallengeError}
                </p>
              ) : null}
            </div>
          )}
          {deleteError ? (
            <p role="alert" className="field-error">
              계정을 삭제하지 못했습니다: {deleteError}
            </p>
          ) : null}
          <div className="conflict-actions">
            <Button
              type="submit"
              variant="danger"
              disabled={
                !deleteEmailMatches ||
                deletePasswordMissing ||
                deleteIdentityProofMissing ||
                deletingAccount
              }
            >
              <Trash2 size={18} aria-hidden />
              {deletingAccount ? '삭제 중…' : '계정 영구 삭제'}
            </Button>
            <Button type="button" onClick={closeDeleteDialog} disabled={deletingAccount}>
              취소
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
