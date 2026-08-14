import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleSignInButton, googleButtonWidth } from './GoogleSignInButton';

const GOOGLE_IDENTITY_SCRIPT = 'https://accounts.google.com/gsi/client';

afterEach(() => {
  cleanup();
  document.querySelector(`script[src="${GOOGLE_IDENTITY_SCRIPT}"]`)?.remove();
  delete window.google;
});

describe('GoogleSignInButton', () => {
  it('never asks the SDK to render wider than a narrow container', () => {
    expect(googleButtonWidth(216.8)).toBe(216);
    expect(googleButtonWidth(256)).toBe(256);
    expect(googleButtonWidth(800)).toBe(400);
  });

  it('announces an accessible error and clears its busy state when the SDK cannot load', async () => {
    render(<GoogleSignInButton clientId="client-id" onCredential={vi.fn()} />);

    const status = screen.getByRole('status');
    const root = status.closest('.google-sign-in');
    expect(root).toHaveAttribute('aria-busy', 'true');

    const script = document.querySelector<HTMLScriptElement>(
      `script[src="${GOOGLE_IDENTITY_SCRIPT}"]`,
    );
    expect(script).not.toBeNull();
    if (!script) throw new Error('Google Identity script was not appended');
    fireEvent.error(script);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Google 로그인 라이브러리를 불러오지 못했습니다.',
    );
    expect(root).toHaveAttribute('aria-busy', 'false');
  });

  it('resets a rejected loader and explicitly retries with a fresh script', async () => {
    const renderButton = vi.fn();
    render(<GoogleSignInButton clientId="client-id" onCredential={vi.fn()} />);
    const firstScript = document.querySelector<HTMLScriptElement>(
      `script[src="${GOOGLE_IDENTITY_SCRIPT}"]`,
    );
    if (!firstScript) throw new Error('Initial Google Identity script was not appended');
    fireEvent.error(firstScript);

    fireEvent.click(await screen.findByRole('button', { name: 'Google 로그인 다시 시도' }));
    const secondScript = document.querySelector<HTMLScriptElement>(
      `script[src="${GOOGLE_IDENTITY_SCRIPT}"]`,
    );
    expect(secondScript).not.toBeNull();
    expect(secondScript).not.toBe(firstScript);
    window.google = {
      accounts: {
        id: {
          initialize: vi.fn(),
          renderButton,
        },
      },
    };
    if (!secondScript) throw new Error('Retry Google Identity script was not appended');
    fireEvent.load(secondScript);

    await waitFor(() => expect(renderButton).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(document.querySelector('.google-sign-in')).toHaveAttribute('aria-busy', 'false');
  });
});
