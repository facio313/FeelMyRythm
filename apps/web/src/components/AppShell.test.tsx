import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';
import { PageHeader } from './PageHeader';

const authState = vi.hoisted(() => ({ user: null as null | { displayName: string } }));

function BackButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(-1)}>
      이전 화면
    </button>
  );
}

vi.mock('../lib/auth', () => ({
  useAuth: () => authState,
}));

describe('AppShell', () => {
  beforeEach(() => {
    authState.user = null;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it('keeps five primary mobile destinations and exposes the rest in a focus-trapped dialog', () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route
              path="settings"
              element={<PageHeader title="설정" description="테스트 설정" />}
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: '본문으로 건너뛰기' })).toHaveAttribute(
      'href',
      '#main-content',
    );

    const mobileNavigation = screen.getByRole('navigation', { name: '모바일 주요 메뉴' });
    expect(within(mobileNavigation).getAllByRole('link')).toHaveLength(4);
    expect(within(mobileNavigation).getByRole('link', { name: '메트로놈' })).toBeInTheDocument();
    expect(within(mobileNavigation).getByRole('link', { name: '악보' })).toBeInTheDocument();
    expect(within(mobileNavigation).getByRole('link', { name: '앙상블' })).toBeInTheDocument();
    expect(within(mobileNavigation).getByRole('link', { name: '연습' })).toBeInTheDocument();

    const moreButton = within(mobileNavigation).getByRole('button', { name: '더보기' });
    expect(moreButton).toHaveAttribute('aria-expanded', 'false');
    expect(moreButton).toHaveAttribute('aria-current', 'page');
    fireEvent.click(moreButton);

    const dialog = screen.getByRole('dialog', { name: '더보기' });
    expect(moreButton).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog).getByRole('link', { name: '템포맵' })).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: '튜너' })).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: '프로젝트' })).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: '출력 보정' })).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: '설정' })).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: '로그인' })).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: '개인정보 처리 안내' })).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: '계정 삭제' })).toBeInTheDocument();

    fireEvent(window, new PopStateEvent('popstate'));
    expect(screen.queryByRole('dialog', { name: '더보기' })).not.toBeInTheDocument();
  });

  it('marks the score destination current on repertoire-scoped score routes', () => {
    render(
      <MemoryRouter initialEntries={['/repertoire/repertoire-1/scores/score-1']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route
              path="repertoire/:repertoireItemId/scores/:scoreId"
              element={<PageHeader title="악보" description="원격 악보" />}
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const scoreLinks = screen.getAllByRole('link', { name: '악보' });
    expect(scoreLinks).toHaveLength(2);
    for (const link of scoreLinks) {
      expect(link).toHaveAttribute('aria-current', 'page');
    }
    expect(screen.getByRole('button', { name: '더보기' })).not.toHaveAttribute('aria-current');
  });

  it('removes app-local account deletion navigation in portfolio SSO mode', () => {
    vi.stubEnv('VITE_FMR_SSO_ENABLED', 'true');
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="settings" element={<PageHeader title="설정" description="테스트" />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByRole('link', { name: '계정 삭제' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '더보기' }));
    expect(
      within(screen.getByRole('dialog', { name: '더보기' })).queryByRole('link', {
        name: '계정 삭제',
      }),
    ).not.toBeInTheDocument();
  });

  it('sends signed-in users to the project repertoire picker instead of local practice', () => {
    authState.user = { displayName: 'Player' };
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<PageHeader title="메트로놈" description="테스트" />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    for (const link of screen.getAllByRole('link', { name: '연습' })) {
      expect(link).toHaveAttribute('href', '/dashboard');
    }
  });

  it('returns the persistent content scroller to the top when the route changes', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<PageHeader title="메트로놈" description="첫 화면" />} />
            <Route
              path="editor"
              element={
                <>
                  <PageHeader title="템포맵 편집기" description="다음 화면" />
                  <BackButton />
                </>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const content = document.getElementById('main-content');
    expect(content).not.toBeNull();
    if (!content) return;
    content.scrollTop = 640;
    content.scrollLeft = 80;

    fireEvent.click(screen.getAllByRole('link', { name: '템포맵' })[0]!);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '템포맵 편집기' })).toHaveFocus();
      expect(content.scrollTop).toBe(0);
      expect(content.scrollLeft).toBe(0);
    });

    content.scrollTop = 240;
    fireEvent.click(screen.getByRole('button', { name: '이전 화면' }));

    await waitFor(() => {
      expect(content).toHaveFocus();
      expect(content.scrollTop).toBe(640);
      expect(content.scrollLeft).toBe(80);
    });
  });

  it('does not mistake the initial StrictMode effect replay for a restored POP entry', async () => {
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<PageHeader title="메트로놈" description="첫 화면" />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '메트로놈' })).toHaveFocus();
    });
  });
});
