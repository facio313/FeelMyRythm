import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useAuth } from './lib/auth';
import CalibrationPage from './pages/CalibrationPage';
import DashboardPage from './pages/DashboardPage';
import EditorPage from './pages/EditorPage';
import LoginPage from './pages/LoginPage';
import MetronomePage from './pages/MetronomePage';
import RepertoirePage from './pages/RepertoirePage';
import ScorePage from './pages/ScorePage';
import SessionPage from './pages/SessionPage';
import TunerPage from './pages/TunerPage';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = useAuth((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

const navItems = [
  { to: '/', label: '메트로놈' },
  { to: '/editor', label: '템포맵' },
  { to: '/tuner', label: '튜너' },
  { to: '/calibrate', label: '캘리브레이션' },
  { to: '/dash', label: '그룹' },
];

export default function App() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-4">
      <header className="flex items-center gap-4 border-b py-3" style={{ borderColor: 'var(--border)' }}>
        <span className="text-lg font-semibold" style={{ color: 'var(--accent)' }}>
          FeelMyRythm
        </span>
        <nav className="flex flex-1 gap-1 overflow-x-auto">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className="btn btn-ghost"
              style={({ isActive }) => (isActive ? { color: 'var(--accent)' } : undefined)}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        {user ? (
          <div className="flex items-center gap-2">
            <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {user.displayName}
            </span>
            <button
              className="btn btn-ghost"
              onClick={() => {
                logout();
                navigate('/');
              }}
            >
              로그아웃
            </button>
          </div>
        ) : (
          <NavLink to="/login" className="btn">
            로그인
          </NavLink>
        )}
      </header>

      <main className="flex-1 py-6">
        <Routes>
          <Route path="/" element={<MetronomePage />} />
          <Route path="/editor" element={<EditorPage />} />
          <Route path="/tuner" element={<TunerPage />} />
          <Route path="/calibrate" element={<CalibrationPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/dash"
            element={
              <RequireAuth>
                <DashboardPage />
              </RequireAuth>
            }
          />
          <Route
            path="/repertoire/:id"
            element={
              <RequireAuth>
                <RepertoirePage />
              </RequireAuth>
            }
          />
          <Route
            path="/score/:id"
            element={
              <RequireAuth>
                <ScorePage />
              </RequireAuth>
            }
          />
          <Route
            path="/session/:roomId"
            element={
              <RequireAuth>
                <SessionPage />
              </RequireAuth>
            }
          />
        </Routes>
      </main>
    </div>
  );
}
