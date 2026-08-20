import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@feelmyrythm/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  VISUAL_OFFSET_MAX_MS,
  VISUAL_OFFSET_MIN_MS,
  VISUAL_OFFSET_STORAGE_KEY,
} from '../lib/useMetronome';
import { clearAccountDeletionChallenge } from '../lib/accountDeletionChallenge';
import { storageEstimate } from '../lib/localDb';
import { THEME_COLORS, THEME_STORAGE_KEY } from '../lib/theme';
import { SettingsPage } from './SettingsPage';

vi.mock('../lib/localDb', () => ({
  storageEstimate: vi.fn(),
}));

const mobileState = vi.hoisted(() => ({
  nativeBridge: {
    native: false,
    setSystemBarsTheme: vi.fn(async () => undefined),
  },
}));

vi.mock('@feelmyrythm/mobile', () => mobileState);

vi.mock('../components/GoogleSignInButton', () => ({
  GoogleSignInButton: ({ onCredential }: { onCredential: (idToken: string) => Promise<void> }) => (
    <button type="button" onClick={() => void onCredential('google-delete-id-token')}>
      Google 계정으로 다시 확인
    </button>
  ),
}));

interface MockAuthUser {
  id: string;
  email: string;
  displayName: string;
  hasPassword: boolean;
}

const authState = vi.hoisted(() => ({
  user: {
    id: 'settings-user',
    email: 'settings@example.test',
    displayName: 'Settings Player',
    hasPassword: true,
  } as MockAuthUser | null,
  logout: vi.fn(),
  deleteAccount: vi.fn(async () => ({ localCacheCleared: true })),
  requestAccountDeletionChallenge: vi.fn(async () => undefined),
}));

vi.mock('../lib/auth', () => ({
  useAuth: () => authState,
}));

const storedValues = new Map<string, string>();
const sessionStoredValues = new Map<string, string>();

function memoryStorage(values: Map<string, string>): Storage {
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

const browserStorage = memoryStorage(storedValues);
const browserSessionStorage = memoryStorage(sessionStoredValues);

function LocationProbe() {
  const location = useLocation();
  const accountDeletionRequested =
    typeof location.state === 'object' &&
    location.state !== null &&
    (location.state as { openAccountDeletion?: unknown }).openAccountDeletion === true;
  return (
    <output
      data-testid="settings-location"
      data-pathname={location.pathname}
      data-hash={location.hash}
      data-account-deletion-requested={String(accountDeletionRequested)}
      data-account-deletion-login={String(
        typeof location.state === 'object' &&
          location.state !== null &&
          (location.state as { accountDeletionChallenge?: unknown }).accountDeletionChallenge ===
            true,
      )}
    />
  );
}

function accountDeleteProof(user: Pick<MockAuthUser, 'id' | 'email'>): string {
  const encode = (value: object) =>
    window.btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    typ: 'account_delete',
    sub: user.id,
    email: user.email,
    google_sub: 'google-settings-user',
    gen: 4,
  })}.test-signature`;
}

function renderSettings(initialEntry = '/settings', state?: unknown) {
  return render(
    <MemoryRouter
      initialEntries={state === undefined ? [initialEntry] : [{ pathname: initialEntry, state }]}
    >
      <ToastProvider>
        <LocationProbe />
        <Routes>
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/login" element={<div>로그인 화면</div>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('SettingsPage visual offset', () => {
  beforeEach(() => {
    browserStorage.clear();
    browserSessionStorage.clear();
    vi.stubGlobal('localStorage', browserStorage);
    vi.stubGlobal('sessionStorage', browserSessionStorage);
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'settings-google-client');
    vi.mocked(storageEstimate).mockReset().mockResolvedValue(null);
    mobileState.nativeBridge.native = false;
    mobileState.nativeBridge.setSystemBarsTheme.mockReset().mockResolvedValue(undefined);
    authState.user = {
      id: 'settings-user',
      email: 'settings@example.test',
      displayName: 'Settings Player',
      hasPassword: true,
    };
    clearAccountDeletionChallenge();
    authState.logout.mockReset();
    authState.deleteAccount.mockReset().mockResolvedValue({ localCacheCleared: true });
    authState.requestAccountDeletionChallenge.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    clearAccountDeletionChallenge();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('explains the direction, validates the range, and persists a valid value', () => {
    browserStorage.setItem(VISUAL_OFFSET_STORAGE_KEY, '16');
    renderSettings();

    const input = screen.getByRole('spinbutton', { name: /시각 오프셋 \(ms\)/ });
    const saveButton = screen.getByRole('button', { name: '저장' });
    expect(input).toHaveValue(16);
    expect(input).toHaveAttribute('min', String(VISUAL_OFFSET_MIN_MS));
    expect(input).toHaveAttribute('max', String(VISUAL_OFFSET_MAX_MS));
    expect(input).toHaveAccessibleDescription(
      '양수는 늦게 보이는 박 표시를 앞당기고, 음수는 늦춥니다. 오디오 클릭 시점은 바뀌지 않습니다.',
    );

    fireEvent.change(input, { target: { value: String(VISUAL_OFFSET_MAX_MS + 1) } });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(
      `${VISUAL_OFFSET_MIN_MS}ms에서 ${VISUAL_OFFSET_MAX_MS}ms 사이의 값을 입력하세요.`,
    );
    expect(saveButton).toBeDisabled();
    expect(browserStorage.getItem(VISUAL_OFFSET_STORAGE_KEY)).toBe('16');

    fireEvent.change(input, { target: { value: '-24.5' } });
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);

    expect(browserStorage.getItem(VISUAL_OFFSET_STORAGE_KEY)).toBe('-24.5');
    expect(screen.getByText('연습 설정을 저장했습니다.')).toBeInTheDocument();
  });

  it('keeps account deletion out of the app when portfolio SSO owns the identity', () => {
    vi.stubEnv('VITE_FMR_SSO_ENABLED', 'true');
    renderSettings();

    expect(screen.getByText('Settings Player · settings@example.test')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '계정 삭제' })).not.toBeInTheDocument();
  });

  it('uses roving focus and arrow/Home/End keys for theme radios', () => {
    const themeColorMeta = document.createElement('meta');
    themeColorMeta.name = 'theme-color';
    document.head.append(themeColorMeta);
    renderSettings();
    const dark = screen.getByRole('radio', { name: '다크' });
    const light = screen.getByRole('radio', { name: '라이트' });
    expect(dark).toHaveAttribute('tabindex', '0');
    expect(light).toHaveAttribute('tabindex', '-1');

    dark.focus();
    fireEvent.keyDown(dark, { key: 'ArrowRight' });
    expect(light).toHaveFocus();
    expect(light).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(themeColorMeta.content).toBe(THEME_COLORS.light);
    expect(browserStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(mobileState.nativeBridge.setSystemBarsTheme).toHaveBeenLastCalledWith('light');

    fireEvent.keyDown(light, { key: 'Home' });
    expect(dark).toHaveFocus();
    expect(dark).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(dark, { key: 'End' });
    expect(light).toHaveFocus();
    themeColorMeta.remove();
  });

  it('distinguishes unsupported storage estimates from errors and retries errors', async () => {
    vi.mocked(storageEstimate)
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockResolvedValueOnce(null);
    renderSettings();

    expect(await screen.findByRole('alert')).toHaveTextContent('permission denied');
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(storageEstimate).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText('이 브라우저는 저장 공간 용량 확인을 지원하지 않습니다.'),
    ).toBeInTheDocument();
  });

  it('requires account identity and password before destructive deletion', async () => {
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: '계정 삭제' }));
    const dialog = screen.getByRole('dialog', { name: '계정을 영구 삭제합니다' });
    const confirm = screen.getByRole('button', { name: '계정 영구 삭제' });
    const emailField = screen.getByRole('textbox', { name: /^계정 이메일 확인/ });
    expect(dialog).toHaveTextContent('이 기기의 개인 로컬 연습 데이터는 유지됩니다');
    expect(confirm).toBeDisabled();

    fireEvent.change(emailField, {
      target: { value: 'wrong@example.test' },
    });
    expect(emailField).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(emailField, {
      target: { value: authState.user!.email },
    });
    fireEvent.change(screen.getByLabelText(/^현재 비밀번호/), {
      target: { value: 'password-123' },
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(authState.deleteAccount).toHaveBeenCalledWith(authState.user!.email, {
        currentPassword: 'password-123',
      }),
    );
    expect(await screen.findByText('로그인 화면')).toBeInTheDocument();
  });

  it('keeps logout directly reachable from settings', async () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    expect(authState.logout).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('로그인 화면')).toBeInTheDocument();
  });

  it('requires a fresh Google proof before a browser Google-only account can be deleted', async () => {
    authState.user!.hasPassword = false;
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: '계정 삭제' }));
    expect(screen.queryByLabelText(/^현재 비밀번호/)).not.toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: '계정 영구 삭제' });
    const emailField = screen.getByRole('textbox', { name: /^계정 이메일 확인/ });
    expect(confirm).toBeDisabled();
    expect(screen.getByText(/먼저 Google 또는 이메일 보안 링크로 본인 확인/)).toBeVisible();

    fireEvent.change(emailField, {
      target: { value: 'wrong@example.test' },
    });
    expect(emailField).toHaveAttribute('aria-invalid', 'true');
    expect(confirm).toBeDisabled();
    fireEvent.change(emailField, {
      target: { value: authState.user!.email },
    });
    expect(confirm).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Google 계정으로 다시 확인' }));
    expect(await screen.findByText('Google 계정 확인을 완료했습니다.')).toBeInTheDocument();
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(authState.deleteAccount).toHaveBeenCalledWith(authState.user!.email, {
        googleIdToken: 'google-delete-id-token',
      }),
    );
  });

  it('hides Google reauthentication in the narrow native modal and offers email proof', async () => {
    authState.user!.hasPassword = false;
    mobileState.nativeBridge.native = true;
    vi.stubGlobal('innerWidth', 360);
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: '계정 삭제' }));
    const dialog = screen.getByRole('dialog', { name: '계정을 영구 삭제합니다' });
    const confirm = screen.getByRole('button', { name: '계정 영구 삭제' });
    expect(dialog).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Google 계정으로 다시 확인' })).toBeNull();
    expect(dialog).toHaveTextContent('모바일 앱에서는 탈퇴 확인 이메일의 보안 링크');
    expect(confirm).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '탈퇴 확인 이메일 보내기' }));
    await waitFor(() => expect(authState.requestAccountDeletionChallenge).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(
        '탈퇴 확인 이메일을 보냈습니다. 이 탭에서 메일의 보안 링크를 열어 주세요.',
      ),
    ).toBeVisible();
    expect(confirm).toBeDisabled();
  });

  it('consumes an email proof fragment, keeps it memory-only, and passes it to deletion', async () => {
    authState.user!.hasPassword = false;
    mobileState.nativeBridge.native = true;
    const proof = accountDeleteProof(authState.user!);
    renderSettings(`/settings#accountDeleteToken=${proof}`);

    expect(await screen.findByRole('dialog', { name: '계정을 영구 삭제합니다' })).toBeVisible();
    await waitFor(() =>
      expect(screen.getByTestId('settings-location')).toHaveAttribute('data-hash', ''),
    );
    expect(screen.getByText('이메일 보안 링크로 본인 확인을 완료했습니다.')).toBeVisible();
    expect(JSON.stringify([...sessionStoredValues.entries()])).not.toContain(proof);
    expect([...sessionStoredValues.values()]).toEqual([]);

    fireEvent.change(screen.getByRole('textbox', { name: /^계정 이메일 확인/ }), {
      target: { value: authState.user!.email },
    });
    const confirm = screen.getByRole('button', { name: '계정 영구 삭제' });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(authState.deleteAccount).toHaveBeenCalledWith(authState.user!.email, {
        accountDeleteToken: proof,
      }),
    );
  });

  it('does not restore a proof after a fresh runtime reload', async () => {
    authState.user!.hasPassword = false;
    const proof = accountDeleteProof(authState.user!);
    const firstView = renderSettings(`/settings#accountDeleteToken=${proof}`);

    expect(await screen.findByText('이메일 보안 링크로 본인 확인을 완료했습니다.')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByTestId('settings-location')).toHaveAttribute('data-hash', ''),
    );
    firstView.unmount();
    clearAccountDeletionChallenge();

    renderSettings('/settings');
    expect(screen.queryByRole('dialog', { name: '계정을 영구 삭제합니다' })).toBeNull();
    expect(JSON.stringify([...sessionStoredValues.entries()])).not.toContain(proof);
  });

  it('strips a logged-out arrival and routes to login without persisting the proof', async () => {
    const proof = accountDeleteProof({ id: 'settings-user', email: 'settings@example.test' });
    authState.user = null;

    renderSettings(`/settings#accountDeleteToken=${proof}`);

    expect(await screen.findByText('로그인 화면')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('settings-location')).toHaveAttribute('data-pathname', '/login');
      expect(screen.getByTestId('settings-location')).toHaveAttribute('data-hash', '');
      expect(screen.getByTestId('settings-location')).toHaveAttribute(
        'data-account-deletion-login',
        'true',
      );
    });
    expect(
      JSON.stringify([...storedValues.entries(), ...sessionStoredValues.entries()]),
    ).not.toContain(proof);
  });

  it('does not open the deletion modal for the wrong authenticated account', async () => {
    const proof = accountDeleteProof({ id: 'settings-user', email: 'settings@example.test' });
    authState.user = {
      id: 'other-user',
      email: 'other@example.test',
      displayName: 'Other Player',
      hasPassword: false,
    };

    renderSettings(`/settings#accountDeleteToken=${proof}`);

    expect(await screen.findByText('로그인 화면')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '계정을 영구 삭제합니다' })).toBeNull();
    expect(authState.deleteAccount).not.toHaveBeenCalled();
  });

  it('opens deletion from the public-guide location state and immediately consumes it', async () => {
    renderSettings('/settings', { openAccountDeletion: true });

    expect(await screen.findByRole('dialog', { name: '계정을 영구 삭제합니다' })).toBeVisible();
    await waitFor(() =>
      expect(screen.getByTestId('settings-location')).toHaveAttribute(
        'data-account-deletion-requested',
        'false',
      ),
    );
  });
});
