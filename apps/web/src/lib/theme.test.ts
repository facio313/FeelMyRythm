import { describe, expect, it, vi } from 'vitest';
import {
  applyStoredTheme,
  applyTheme,
  readStoredTheme,
  THEME_COLORS,
  THEME_STORAGE_KEY,
} from './theme';

describe('theme application', () => {
  it('applies a saved theme to every install surface before the app renders', () => {
    const root = document.createElement('html');
    const themeColorMeta = { content: '' };
    const setItem = vi.fn();
    const setSystemBarsTheme = vi.fn(async () => undefined);

    expect(
      applyStoredTheme({
        root,
        themeColorMeta,
        storage: { getItem: () => 'light', setItem },
        systemBars: { setSystemBarsTheme },
      }),
    ).toBe('light');
    expect(root.dataset.theme).toBe('light');
    expect(themeColorMeta.content).toBe(THEME_COLORS.light);
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, 'light');
    expect(setSystemBarsTheme).toHaveBeenCalledWith('light');
  });

  it('updates the document, browser chrome, persistence, and system bars together', () => {
    const root = document.createElement('html');
    const themeColorMeta = { content: THEME_COLORS.light };
    const setItem = vi.fn();
    const setSystemBarsTheme = vi.fn(async () => undefined);

    expect(
      applyTheme('dark', {
        root,
        themeColorMeta,
        storage: { getItem: () => null, setItem },
        systemBars: { setSystemBarsTheme },
      }),
    ).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(themeColorMeta.content).toBe(THEME_COLORS.dark);
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, 'dark');
    expect(setSystemBarsTheme).toHaveBeenCalledWith('dark');
  });

  it('keeps the current page usable when reading or writing storage is blocked', () => {
    const root = document.createElement('html');
    const themeColorMeta = { content: '' };
    const storage = {
      getItem: () => {
        throw new Error('storage read blocked');
      },
      setItem: () => {
        throw new Error('storage write blocked');
      },
    };

    expect(applyStoredTheme({ root, themeColorMeta, storage, systemBars: null })).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(themeColorMeta.content).toBe(THEME_COLORS.dark);
  });

  it('tolerates a document without a theme-color meta element', () => {
    const root = document.createElement('html');

    expect(() =>
      applyTheme('light', {
        root,
        themeColorMeta: null,
        storage: null,
        systemBars: null,
      }),
    ).not.toThrow();
    expect(root.dataset.theme).toBe('light');
  });

  it('contains rejected and synchronously thrown native presentation errors', async () => {
    const rejected = vi.fn(async () => {
      throw new Error('native rejected');
    });
    const thrown = vi.fn(() => {
      throw new Error('native threw');
    });

    expect(() =>
      applyTheme('dark', {
        root: null,
        themeColorMeta: null,
        storage: null,
        systemBars: { setSystemBarsTheme: rejected },
      }),
    ).not.toThrow();
    expect(() =>
      applyTheme('light', {
        root: null,
        themeColorMeta: null,
        storage: null,
        systemBars: { setSystemBarsTheme: thrown },
      }),
    ).not.toThrow();
    await Promise.resolve();
    expect(rejected).toHaveBeenCalledWith('dark');
    expect(thrown).toHaveBeenCalledWith('light');
  });

  it('normalizes invalid and inaccessible stored values to dark', () => {
    expect(readStoredTheme({ getItem: () => 'unexpected' })).toBe('dark');
    expect(
      readStoredTheme({
        getItem: () => {
          throw new Error('storage blocked');
        },
      }),
    ).toBe('dark');
  });
});
