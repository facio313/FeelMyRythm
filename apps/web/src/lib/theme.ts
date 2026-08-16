import { nativeBridge, type NativeBridge } from '@feelmyrythm/mobile';

export type AppTheme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'fmr.theme';
export const THEME_COLORS: Readonly<Record<AppTheme, string>> = {
  dark: '#0C0D10',
  light: '#FAF8F3',
};

type ThemeStorage = Pick<Storage, 'getItem'> & Partial<Pick<Storage, 'setItem'>>;
type ThemeColorMeta = Pick<HTMLMetaElement, 'content'>;
type ThemeSystemBars = Pick<NativeBridge, 'setSystemBarsTheme'>;

export interface ThemeApplyOptions {
  root?: HTMLElement | null;
  themeColorMeta?: ThemeColorMeta | null;
  storage?: ThemeStorage | null;
  systemBars?: ThemeSystemBars | null;
}

function defaultStorage(): ThemeStorage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function defaultRoot(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement;
}

function defaultThemeColorMeta(): HTMLMetaElement | null {
  return typeof document === 'undefined'
    ? null
    : document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
}

export function readStoredTheme(
  storage: Pick<Storage, 'getItem'> | null = defaultStorage(),
): AppTheme {
  try {
    return storage?.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme: AppTheme, options: ThemeApplyOptions = {}): AppTheme {
  const root = options.root === undefined ? defaultRoot() : options.root;
  const themeColorMeta =
    options.themeColorMeta === undefined ? defaultThemeColorMeta() : options.themeColorMeta;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const systemBars = options.systemBars === undefined ? nativeBridge : options.systemBars;

  if (root) root.dataset.theme = theme;
  if (themeColorMeta) themeColorMeta.content = THEME_COLORS[theme];
  try {
    storage?.setItem?.(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme changes remain active for this page even when persistence is blocked.
  }

  const setSystemBarsTheme = systemBars?.setSystemBarsTheme;
  if (typeof setSystemBarsTheme === 'function') {
    try {
      void Promise.resolve(setSystemBarsTheme.call(systemBars, theme)).catch(() => undefined);
    } catch {
      // Native presentation is best-effort and must never block the web UI.
    }
  }

  return theme;
}

export function applyStoredTheme(options: ThemeApplyOptions = {}): AppTheme {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  return applyTheme(readStoredTheme(storage), { ...options, storage });
}
