import {
  AudioLines,
  BookOpen,
  Gauge,
  LayoutDashboard,
  ListMusic,
  Menu,
  Radio,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Tally4,
  UserRound,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Link,
  NavigationType,
  NavLink,
  Outlet,
  useLocation,
  useNavigationType,
} from 'react-router-dom';
import { cn, Modal } from '@feelmyrythm/ui';
import { useAuth } from '../lib/auth';

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

export function AppShell() {
  const { user } = useAuth();
  const location = useLocation();
  const navigationType = useNavigationType();
  const { pathname } = location;
  const [moreOpen, setMoreOpen] = useState(false);
  const scrollPositionsRef = useRef(new Map<string, { left: number; top: number }>());
  const activeLocationKeyRef = useRef<string | null>(null);
  const moreActive =
    pathname.startsWith('/login') ||
    mobileMore.some(({ to }) => isNavigationPathActive(pathname, to)) ||
    legalNavigation.some(({ to }) => isNavigationPathActive(pathname, to));

  useEffect(() => {
    const closeTransientNavigation = () => setMoreOpen(false);
    window.addEventListener('popstate', closeTransientNavigation);
    return () => window.removeEventListener('popstate', closeTransientNavigation);
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
    if (mainContent) {
      mainContent.scrollTop = restored?.top ?? 0;
      mainContent.scrollLeft = restored?.left ?? 0;
    }
    const frame = window.requestAnimationFrame(() => {
      if (restored) {
        mainContent?.focus({ preventScroll: true });
        return;
      }
      const heading = document.querySelector<HTMLElement>('#main-content h1');
      if (heading) {
        if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      } else {
        mainContent?.focus({ preventScroll: true });
      }
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
  }, [location.key, navigationType]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        본문으로 건너뛰기
      </a>
      <header className="topbar">
        <NavLink className="brand" to="/" aria-label="FeelMyRythm 홈">
          <span className="brand__mark" aria-hidden>
            F
          </span>
          <span className="brand__name">FeelMyRythm</span>
        </NavLink>
        <nav className="topbar__actions" aria-label="계정과 설정">
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
          {legalNavigation.map(({ to, label }) => (
            <Link key={to} to={to} aria-current={pathname === to ? 'page' : undefined}>
              {label}
            </Link>
          ))}
        </nav>
      </aside>

      <main id="main-content" className="app-content" tabIndex={-1}>
        <Outlet />
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
        description="편집, 튜닝과 프로젝트 관리 메뉴입니다."
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
          <NavLink
            to={user ? '/dashboard' : '/login'}
            className="mobile-more__link"
            onClick={() => setMoreOpen(false)}
          >
            <UserRound size={22} aria-hidden />
            <span>{user ? `${user.displayName} 계정` : '로그인'}</span>
          </NavLink>
          {legalNavigation.map(({ to, label }) => (
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
