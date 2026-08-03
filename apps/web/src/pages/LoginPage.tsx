import type { AuthResponse } from '@feelmyrythm/protocol';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

export default function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const setAuth = useAuth((s) => s.setAuth);
  const navigate = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res =
        mode === 'login'
          ? await api<AuthResponse>('/api/auth/login', { method: 'POST', json: { email, password } })
          : await api<AuthResponse>('/api/auth/register', {
              method: 'POST',
              json: { email, password, displayName },
            });
      setAuth(res.token, res.user);
      navigate('/dash');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm">
      <div className="card">
        <h1 className="section-title">{mode === 'login' ? '로그인' : '회원가입'}</h1>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          {mode === 'register' && (
            <div>
              <label className="label">이름 (앙상블에 표시)</label>
              <input className="input w-full" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
            </div>
          )}
          <div>
            <label className="label">이메일</label>
            <input type="email" className="input w-full" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label className="label">비밀번호 {mode === 'register' && '(8자 이상)'}</label>
            <input
              type="password"
              className="input w-full"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
          </div>
          {error && <div className="text-sm" style={{ color: 'var(--danger)' }}>{error}</div>}
          <button className="btn btn-primary" disabled={busy}>
            {mode === 'login' ? '로그인' : '가입하기'}
          </button>
        </form>
        <button
          className="btn btn-ghost mt-3 w-full"
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
        >
          {mode === 'login' ? '계정이 없어요 → 회원가입' : '이미 계정이 있어요 → 로그인'}
        </button>
      </div>
    </div>
  );
}
