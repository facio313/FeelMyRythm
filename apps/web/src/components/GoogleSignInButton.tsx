import { Button } from '@feelmyrythm/ui';
import { useEffect, useRef, useState } from 'react';

const GOOGLE_IDENTITY_SCRIPT = 'https://accounts.google.com/gsi/client';

interface GoogleCredentialResponse {
  credential?: string;
}

interface GoogleIdentityClient {
  initialize(options: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
    cancel_on_tap_outside?: boolean;
  }): void;
  renderButton(
    parent: HTMLElement,
    options: {
      theme: 'outline';
      size: 'large';
      shape: 'rectangular';
      text: 'continue_with';
      width: number;
    },
  ): void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: GoogleIdentityClient;
      };
    };
  }
}

let googleIdentityPromise: Promise<GoogleIdentityClient> | null = null;

export function googleButtonWidth(availableWidth: number): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return 400;
  return Math.min(400, Math.max(1, Math.floor(availableWidth)));
}

function loadGoogleIdentity(): Promise<GoogleIdentityClient> {
  if (window.google?.accounts.id) return Promise.resolve(window.google.accounts.id);
  if (googleIdentityPromise) return googleIdentityPromise;

  const pending = new Promise<GoogleIdentityClient>((resolve, reject) => {
    let scriptElement: HTMLScriptElement | null = null;
    const finish = () => {
      const identity = window.google?.accounts.id;
      if (identity) resolve(identity);
      else {
        scriptElement?.remove();
        reject(new Error('Google 로그인 라이브러리를 초기화하지 못했습니다.'));
      }
    };
    const fail = () => {
      scriptElement?.remove();
      reject(new Error('Google 로그인 라이브러리를 불러오지 못했습니다.'));
    };
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${GOOGLE_IDENTITY_SCRIPT}"]`,
    );

    if (existing) {
      scriptElement = existing;
      existing.addEventListener('load', finish, { once: true });
      existing.addEventListener('error', fail, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = GOOGLE_IDENTITY_SCRIPT;
    script.async = true;
    script.defer = true;
    scriptElement = script;
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', fail, { once: true });
    document.head.append(script);
  });
  googleIdentityPromise = pending.catch((error: unknown) => {
    googleIdentityPromise = null;
    throw error;
  });
  return googleIdentityPromise;
}

export function GoogleSignInButton({
  clientId,
  onCredential,
}: {
  clientId: string;
  onCredential: (idToken: string) => Promise<void>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onCredentialRef = useRef(onCredential);
  const authenticatingRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [authenticating, setAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    onCredentialRef.current = onCredential;
  }, [onCredential]);

  useEffect(() => {
    let active = true;
    const container = containerRef.current;
    if (!container) return undefined;

    void loadGoogleIdentity()
      .then((identity) => {
        if (!active) return;
        identity.initialize({
          client_id: clientId,
          cancel_on_tap_outside: true,
          callback: (response) => {
            if (!active || authenticatingRef.current) return;
            if (!response.credential) {
              setError('Google에서 로그인 정보를 받지 못했습니다. 다시 시도해 주세요.');
              return;
            }

            authenticatingRef.current = true;
            setAuthenticating(true);
            setError(null);
            void onCredentialRef
              .current(response.credential)
              .catch((reason: unknown) => {
                if (active) {
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : 'Google 계정으로 로그인하지 못했습니다.',
                  );
                }
              })
              .finally(() => {
                authenticatingRef.current = false;
                if (active) setAuthenticating(false);
              });
          },
        });
        container.replaceChildren();
        identity.renderButton(container, {
          theme: 'outline',
          size: 'large',
          shape: 'rectangular',
          text: 'continue_with',
          width: googleButtonWidth(
            container.getBoundingClientRect().width || container.clientWidth,
          ),
        });
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setLoading(false);
        setError(reason instanceof Error ? reason.message : 'Google 로그인을 준비하지 못했습니다.');
      });

    return () => {
      active = false;
      container.replaceChildren();
    };
  }, [clientId, loadAttempt]);

  return (
    <div className="google-sign-in" aria-busy={loading || authenticating}>
      <div ref={containerRef} className="google-sign-in__button" />
      {loading ? (
        <p className="google-sign-in__status" role="status">
          Google 로그인을 준비하는 중…
        </p>
      ) : null}
      {authenticating ? (
        <p className="google-sign-in__status" role="status">
          Google 계정을 확인하는 중…
        </p>
      ) : null}
      {error ? (
        <div className="google-sign-in__failure">
          <p className="google-sign-in__error" role="alert">
            {error}
          </p>
          <Button
            size="compact"
            variant="ghost"
            onClick={() => {
              setError(null);
              setLoading(true);
              setLoadAttempt((attempt) => attempt + 1);
            }}
          >
            Google 로그인 다시 시도
          </Button>
        </div>
      ) : null}
    </div>
  );
}
