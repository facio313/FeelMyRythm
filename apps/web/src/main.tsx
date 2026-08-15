import { StrictMode, type ComponentType, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { establishSafePwaRuntime } from './lib/pwaCache';
import { applyStoredTheme } from './lib/theme';
import './index.css';

const securityPageStyle: CSSProperties = {
  minHeight: '100dvh',
  display: 'grid',
  placeItems: 'center',
  padding: '24px',
};

const securityCardStyle: CSSProperties = {
  width: 'min(100%, 520px)',
  display: 'grid',
  gap: '16px',
  padding: 'clamp(24px, 5vw, 40px)',
  border: '1px solid var(--border)',
  borderRadius: '16px',
  background: 'var(--surface)',
  boxShadow: 'var(--shadow-card)',
};

const retryButtonStyle: CSSProperties = {
  minHeight: '44px',
  border: 0,
  borderRadius: '10px',
  padding: '10px 16px',
  color: 'var(--bg)',
  background: 'var(--accent)',
  fontWeight: 700,
  cursor: 'pointer',
};

function SecurityStartup({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  return (
    <main style={securityPageStyle}>
      <section
        style={securityCardStyle}
        role={failed ? 'alert' : 'status'}
        aria-labelledby="pwa-security-heading"
        aria-live={failed ? 'assertive' : 'polite'}
        aria-busy={!failed}
      >
        <h1 id="pwa-security-heading">
          {failed ? '보안 업데이트를 완료하지 못했습니다' : '보안 업데이트 확인 중'}
        </h1>
        <p>
          {failed
            ? '이전 로그인 데이터가 남지 않았는지 확인할 수 없어 앱 시작을 중단했습니다. 다른 탭을 닫은 뒤 다시 확인해 주세요.'
            : '이전 로그인 데이터를 안전하게 정리하고 있습니다. 잠시만 기다려 주세요.'}
        </p>
        {failed ? (
          <button type="button" style={retryButtonStyle} onClick={onRetry}>
            다시 확인
          </button>
        ) : null}
      </section>
    </main>
  );
}

interface BootstrapDependencies {
  establishPwaRuntime?: typeof establishSafePwaRuntime;
  loadApp?: () => Promise<{ App: ComponentType }>;
  pwaEnabled?: boolean;
  reload?: () => void;
}

export async function bootstrap(dependencies: BootstrapDependencies = {}): Promise<void> {
  applyStoredTheme();

  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('Root element was not found');
  const root = createRoot(rootElement);
  const reload = dependencies.reload ?? (() => window.location.reload());
  root.render(<SecurityStartup failed={false} onRetry={reload} />);

  try {
    const establishPwaRuntime = dependencies.establishPwaRuntime ?? establishSafePwaRuntime;
    await establishPwaRuntime({
      enableServiceWorker: dependencies.pwaEnabled ?? (import.meta.env.PROD && __FMR_PWA_ENABLED__),
    });

    const loadApp = dependencies.loadApp ?? (() => import('./App'));
    const { App } = await loadApp();
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } catch (error) {
    console.error('PWA security transition failed', error);
    root.render(<SecurityStartup failed onRetry={reload} />);
  }
}

if (import.meta.env.MODE !== 'test') void bootstrap();
