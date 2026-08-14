import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppRouter, localPracticeRedirect, RouteLoadingFallback } from './App';

afterEach(cleanup);

describe('route loading fallback', () => {
  it('announces lazy route loading as a polite busy status', () => {
    render(<RouteLoadingFallback />);

    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('화면을 준비하는 중');
  });
});

describe('practice route boundary', () => {
  it('redirects authenticated local practice routes to the repertoire picker', () => {
    expect(localPracticeRedirect(true, undefined)).toBe('/dashboard');
    expect(localPracticeRedirect(true, 'local')).toBe('/dashboard');
    expect(localPracticeRedirect(true, 'repertoire-1')).toBeNull();
    expect(localPracticeRedirect(false, undefined)).toBeNull();
  });
});

describe('app data router', () => {
  it.each([
    ['/feelmyrythm', '/feelmyrythm/editor/map-1'],
    ['/', '/editor/map-1'],
  ])('matches editor routes with the %s basename', (basename, pathname) => {
    const originalPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.history.replaceState(null, '', pathname);
    const router = createAppRouter(basename);

    expect(router.basename).toBe(basename);
    expect(router.state.matches.at(-1)?.params).toEqual({ tempoMapId: 'map-1' });

    router.dispose();
    window.history.replaceState(null, '', originalPath);
  });
});
