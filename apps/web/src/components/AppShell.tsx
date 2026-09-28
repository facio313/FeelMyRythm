import {
  ArrowLeft,
  AudioLines,
  BookOpen,
  Gauge,
  LayoutDashboard,
  ListMusic,
  Menu,
  Moon,
  Radio,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Tally4,
  UserRound,
} from 'lucide-react';
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Link,
  NavigationType,
  NavLink,
  Outlet,
  useLocation,
  useNavigationType,
} from 'react-router-dom';
import { cn, Modal } from '@feelmyrythm/ui';
import { nativeBridge } from '@feelmyrythm/mobile';
import { useAuth } from '../lib/auth';
import { managedLocalSsoModeEnabled, portfolioSsoEnabled } from '../lib/runtimeMode';
import { applyTheme, readStoredTheme, type AppTheme } from '../lib/theme';
import { TemporaryOperationsNotice } from './TemporaryOperationsNotice';

const navigation = [
  { to: '/', label: '메트로놈', icon: Tally4, end: true },
  { to: '/editor', label: '템포맵', icon: SlidersHorizontal },
  { to: '/session', label: '앙상블', icon: Radio },
  { to: '/scores', label: '악보', icon: BookOpen },
  { to: '/practice', label: '연습', icon: ListMusic },
  { to: '/tuner', label: '튜너', icon: Gauge },
  { to: '/dashboard', label: '프로젝트', icon: LayoutDashboard },
];

const mobilePrimary = navigation.filter(({ to }) =>
  ['/', '/scores', '/session', '/practice'].includes(to),
);

const mobileMore = [
  ...navigation.filter(({ to }) => ['/editor', '/tuner', '/dashboard'].includes(to)),
  { to: '/calibration', label: '출력 보정', icon: AudioLines },
  { to: '/settings', label: '설정', icon: Settings },
];

const legalNavigation = [
  { to: '/privacy', label: '개인정보 처리 안내' },
  { to: '/delete-account', label: '계정 삭제' },
];

export function isNavigationPathActive(pathname: string, destination: string): boolean {
  if (destination === '/') return pathname === '/';
  if (destination === '/scores') {
    return (
      pathname === '/scores' ||
      pathname.startsWith('/scores/') ||
      /^\/repertoire\/[^/]+\/scores(?:\/|$)/.test(pathname)
    );
  }
  return pathname === destination || pathname.startsWith(`${destination}/`);
}

export function navigationDestination(destination: string, authenticated: boolean): string {
  return destination === '/practice' && authenticated ? '/dashboard' : destination;
}

export function RouteLoadingFallback() {
  return (
    <div className="loading-panel" role="status" aria-live="polite" aria-busy="true">
      화면을 준비하는 중…
    </div>
  );
}

function RouteOutlet({ onReady }: { onReady: () => void }) {
  const location = useLocation();

  useEffect(() => {
    onReady();
  }, [location.key, onReady]);

  return <Outlet />;
}

export function AppShell() {
  const { user } = useAuth();
  const location = useLocation();
  const navigationType = useNavigationType();
  const { pathname } = location;
  const [moreOpen, setMoreOpen] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(() => readStoredTheme());
  const themeToggleLabel = theme === 'dark' ? '라이트 테마로 전환' : '다크 테마로 전환';
  const operationsNoticeEnabled = managedLocalSsoModeEnabled();
  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    applyTheme(nextTheme);
  };
  const visibleLegalNavigation = portfolioSsoEnabled()
    ? legalNavigation.filter(({ to }) => to !== '/delete-account')
    : legalNavigation;
  const scrollPositionsRef = useRef(new Map<string, { left: number; top: number }>());
  const activeLocationKeyRef = useRef<string | null>(null);
  const focusHeadingWhenReadyRef = useRef(true);
  const moreActive =
    pathname.startsWith('/login') ||
    mobileMore.some(({ to }) => isNavigationPathActive(pathname, to)) ||
    visibleLegalNavigation.some(({ to }) => isNavigationPathActive(pathname, to));

  useEffect(() => {
    const closeTransientNavigation = () => setMoreOpen(false);
    window.addEventListener('popstate', closeTransientNavigation);
    return () => window.removeEventListener('popstate', closeTransientNavigation);
  }, []);

  useEffect(() => {
    const syncTheme = () => {
      setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    };
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  const focusReadyRoute = useCallback(() => {
    if (!focusHeadingWhenReadyRef.current) return;
    const mainContent = document.getElementById('main-content');
    const heading = mainContent?.querySelector<HTMLElement>('h1');
    if (heading) {
      if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    } else {
      mainContent?.focus({ preventScroll: true });
    }
  }, []);

  useLayoutEffect(() => {
    const mainContent = document.getElementById('main-content');
    const scrollPositions = scrollPositionsRef.current;
    const previousLocationKey = activeLocationKeyRef.current;
    const isEntryChange = previousLocationKey !== null && previousLocationKey !== location.key;
    activeLocationKeyRef.current = location.key;
    const restored =
      navigationType === NavigationType.Pop && isEntryChange
        ? scrollPositions.get(location.key)
        : undefined;
    focusHeadingWhenReadyRef.current = !restored;
    if (mainContent) {
      mainContent.scrollTop = restored?.top ?? 0;
      mainContent.scrollLeft = restored?.left ?? 0;
    }
    const frame = window.requestAnimationFrame(() => {
      if (restored) {
        mainContent?.focus({ preventScroll: true });
        return;
      }
      focusReadyRoute();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (mainContent) {
        scrollPositions.set(location.key, {
          left: mainContent.scrollLeft,
          top: mainContent.scrollTop,
        });
      }
    };
  }, [focusReadyRoute, location.key, navigationType]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        본문으로 건너뛰기
      </a>
      <header className="topbar">
        <div className="topbar__identity">
          <NavLink className="brand" to="/" aria-label="FeelMyRythm 홈">
            <span className="brand__mark" aria-hidden>
              F
            </span>
            <span className="brand__name">FeelMyRythm</span>
          </NavLink>
          {!nativeBridge.native ? (
            <a
              className="bonifacio-return-link"
              href="https://bonifacio.work/"
              aria-label="← Bonifacio"
            >
              <span aria-hidden>←</span>
              <span className="bonifacio-return-link__label" aria-hidden>
                Bonifacio
              </span>
            </a>
          ) : null}
        </div>
        <nav className="topbar__actions" aria-label="계정과 화면 설정">
          <TemporaryOperationsNotice enabled={operationsNoticeEnabled} />
          <button
            type="button"
            className="icon-link app-theme-toggle"
            aria-label={themeToggleLabel}
            title={themeToggleLabel}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? <Sun size={20} aria-hidden /> : <Moon size={20} aria-hidden />}
          </button>
          <NavLink className="icon-link" to="/settings" aria-label="설정">
            <Settings size={20} aria-hidden />
          </NavLink>
          <NavLink className="account-link" to={user ? '/dashboard' : '/login'}>
            <UserRound size={18} aria-hidden />
            <span>{user?.displayName ?? '로그인'}</span>
          </NavLink>
        </nav>
      </header>

      <aside className="sidebar">
        <nav aria-label="주요 메뉴">
          {navigation.map(({ to, label, icon: Icon }) => {
            const isActive = isNavigationPathActive(pathname, to);
            const destination = navigationDestination(to, Boolean(user));
            return (
              <Link
                key={to}
                to={destination}
                aria-current={isActive ? 'page' : undefined}
                className={cn('nav-link', isActive && 'nav-link--active')}
              >
                <Icon size={20} aria-hidden />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
        <nav className="sidebar__legal" aria-label="개인정보와 계정">
          {visibleLegalNavigation.map(({ to, label }) => (
            <Link key={to} to={to} aria-current={pathname === to ? 'page' : undefined}>
              {label}
            </Link>
          ))}
        </nav>
      </aside>

      <main id="main-content" className="app-content" tabIndex={-1}>
        <Suspense fallback={<RouteLoadingFallback />}>
          <RouteOutlet onReady={focusReadyRoute} />
        </Suspense>
      </main>

      <nav className="bottom-nav" aria-label="모바일 주요 메뉴">
        {mobilePrimary.map(({ to, label, icon: Icon }) => {
          const isActive = isNavigationPathActive(pathname, to);
          const destination = navigationDestination(to, Boolean(user));
          return (
            <Link
              key={to}
              to={destination}
              aria-current={isActive ? 'page' : undefined}
              className={cn('bottom-nav__link', isActive && 'bottom-nav__link--active')}
              title={label}
            >
              <Icon size={21} aria-hidden />
              <span>{label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          className={cn('bottom-nav__link', moreActive && 'bottom-nav__link--active')}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          aria-current={moreActive ? 'page' : undefined}
          onClick={() => setMoreOpen(true)}
        >
          <Menu size={21} aria-hidden />
          <span>더보기</span>
        </button>
      </nav>

      <Modal
        open={moreOpen}
        onOpenChange={setMoreOpen}
        title="더보기"
        description="편집, 튜닝, 프로젝트 관리와 계정·화면 설정 메뉴입니다."
      >
        <nav className="mobile-more" aria-label="모바일 전체 메뉴">
          {mobileMore.map(({ to, label, icon: Icon }) => {
            const isActive = isNavigationPathActive(pathname, to);
            return (
              <Link
                key={to}
                to={to}
                aria-current={isActive ? 'page' : undefined}
                className={cn('mobile-more__link', isActive && 'mobile-more__link--active')}
                onClick={() => setMoreOpen(false)}
              >
                <Icon size={22} aria-hidden />
                <span>{label}</span>
              </Link>
            );
          })}
          <button
            type="button"
            className="mobile-more__link mobile-more__theme"
            aria-label={themeToggleLabel}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? <Sun size={22} aria-hidden /> : <Moon size={22} aria-hidden />}
            <span>{themeToggleLabel}</span>
          </button>
          <NavLink
            to={user ? '/dashboard' : '/login'}
            className="mobile-more__link"
            onClick={() => setMoreOpen(false)}
          >
            <UserRound size={22} aria-hidden />
            <span>{user ? `${user.displayName} 계정` : '로그인'}</span>
          </NavLink>
          {!nativeBridge.native ? (
            <a
              className="mobile-more__link mobile-more__portfolio"
              href="https://bonifacio.work/"
              aria-label="← Bonifacio"
              onClick={() => setMoreOpen(false)}
            >
              <ArrowLeft size={22} aria-hidden />
              <span>Bonifacio</span>
            </a>
          ) : null}
          {operationsNoticeEnabled ? (
            <div className="mobile-more__link mobile-more__operations">
              <TemporaryOperationsNotice enabled />
              <span className="mobile-more__operations-label" aria-hidden>
                현재 운영 구성
              </span>
            </div>
          ) : null}
          {visibleLegalNavigation.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              className="mobile-more__link"
              onClick={() => setMoreOpen(false)}
            >
              <ShieldCheck size={22} aria-hidden />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </Modal>
    </div>
  );
}
