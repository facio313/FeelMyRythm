import { ToastProvider } from '@feelmyrythm/ui';
import { nativeBridge } from '@feelmyrythm/mobile';
import { lazy, Suspense, useEffect } from 'react';
import {
  createBrowserRouter,
  createRoutesFromElements,
  Navigate,
  Outlet,
  Route,
  RouterProvider,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { AuthProvider, useAuth } from './lib/auth';
import { ROUTER_BASENAME } from './lib/paths';
import { MetronomePage } from './pages/MetronomePage';

const CalibrationPage = lazy(() =>
  import('./pages/CalibrationPage').then((module) => ({ default: module.CalibrationPage })),
);
const DashboardPage = lazy(() =>
  import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })),
);
const EditorPage = lazy(() =>
  import('./pages/EditorPage').then((module) => ({ default: module.EditorPage })),
);
const LoginPage = lazy(() =>
  import('./pages/LoginPage').then((module) => ({ default: module.LoginPage })),
);
const PracticePage = lazy(() =>
  import('./pages/PracticePage').then((module) => ({ default: module.PracticePage })),
);
const PrivacyPage = lazy(() =>
  import('./pages/PrivacyPage').then((module) => ({ default: module.PrivacyPage })),
);
const AccountDeletionPage = lazy(() =>
  import('./pages/AccountDeletionPage').then((module) => ({
    default: module.AccountDeletionPage,
  })),
);
const ScoresPage = lazy(() =>
  import('./pages/ScoresPage').then((module) => ({ default: module.ScoresPage })),
);
const SessionPage = lazy(() =>
  import('./pages/SessionPage').then((module) => ({ default: module.SessionPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((module) => ({ default: module.SettingsPage })),
);
const TunerPage = lazy(() =>
  import('./pages/TunerPage').then((module) => ({ default: module.TunerPage })),
);

export function RouteLoadingFallback() {
  return (
    <div className="loading-panel" role="status" aria-live="polite" aria-busy="true">
      화면을 준비하는 중…
    </div>
  );
}

export function localPracticeRedirect(
  authenticated: boolean,
  repertoireItemId: string | undefined,
): string | null {
  return authenticated && (!repertoireItemId || repertoireItemId === 'local') ? '/dashboard' : null;
}

function PracticeRoute() {
  const { user } = useAuth();
  const { repertoireItemId } = useParams();
  const redirect = localPracticeRedirect(Boolean(user), repertoireItemId);
  return redirect ? <Navigate to={redirect} replace /> : <PracticePage />;
}

function NativeLifecycle() {
  const navigate = useNavigate();
  useEffect(() => {
    let active = true;
    let remove: () => void = () => undefined;
    void nativeBridge
      .onDeepLink((path) => {
        void navigate(path);
      })
      .then((cleanup) => {
        if (!active) {
          cleanup();
          return;
        }
        remove = cleanup;
      })
      .catch((error: unknown) => {
        console.error('Native deep-link listener could not be registered', error);
      });
    return () => {
      active = false;
      remove();
    };
  }, [navigate]);
  return null;
}

function AppProviders() {
  return (
    <AuthProvider>
      <ToastProvider>
        <NativeLifecycle />
        <Suspense fallback={<RouteLoadingFallback />}>
          <Outlet />
        </Suspense>
      </ToastProvider>
    </AuthProvider>
  );
}

export function createAppRouter(basename = ROUTER_BASENAME) {
  return createBrowserRouter(
    createRoutesFromElements(
      <Route element={<AppProviders />}>
        <Route element={<AppShell />}>
          <Route index element={<MetronomePage />} />
          <Route path="editor/:tempoMapId?" element={<EditorPage />} />
          <Route path="session/:roomId?" element={<SessionPage />} />
          <Route path="scores/:scoreId?" element={<ScoresPage />} />
          <Route path="repertoire/:repertoireItemId/scores/:scoreId?" element={<ScoresPage />} />
          <Route path="practice/:repertoireItemId?" element={<PracticeRoute />} />
          <Route path="tuner" element={<TunerPage />} />
          <Route path="calibration" element={<CalibrationPage />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="login" element={<LoginPage />} />
          <Route path="privacy" element={<PrivacyPage />} />
          <Route path="delete-account" element={<AccountDeletionPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>,
    ),
    { basename },
  );
}

let appRouter: ReturnType<typeof createAppRouter> | undefined;

export function App() {
  appRouter ??= createAppRouter();
  return <RouterProvider router={appRouter} />;
}
