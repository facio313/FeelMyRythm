import { beforeEach, describe, expect, it, vi } from 'vitest';

const capacitorState = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  isPluginAvailable: vi.fn(() => false),
  setStyle: vi.fn(async (_options: { style: string }) => undefined),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: capacitorState.isNativePlatform,
    isPluginAvailable: capacitorState.isPluginAvailable,
  },
  SystemBars: { setStyle: capacitorState.setStyle },
  SystemBarsStyle: {
    Dark: 'DARK',
    Light: 'LIGHT',
  },
  registerPlugin: vi.fn(() => ({})),
}));

vi.mock('@capacitor-community/keep-awake', () => ({
  KeepAwake: { keepAwake: vi.fn(), allowSleep: vi.fn() },
}));
vi.mock('@capacitor/app', () => ({ App: {} }));
vi.mock('@capacitor/haptics', () => ({
  Haptics: { impact: vi.fn() },
  ImpactStyle: { Heavy: 'HEAVY', Medium: 'MEDIUM', Light: 'LIGHT' },
}));
vi.mock('./deepLink', () => ({ subscribeToDeepLinks: vi.fn() }));

import { nativeBridge } from './nativeBridge';

describe('native system bar theme', () => {
  beforeEach(() => {
    capacitorState.isNativePlatform.mockReset().mockReturnValue(false);
    capacitorState.isPluginAvailable.mockReset().mockReturnValue(false);
    capacitorState.setStyle.mockReset().mockResolvedValue(undefined);
  });

  it('does nothing in a browser or when the native plugin is unavailable', async () => {
    await expect(nativeBridge.setSystemBarsTheme('dark')).resolves.toBeUndefined();
    expect(capacitorState.isPluginAvailable).not.toHaveBeenCalled();
    expect(capacitorState.setStyle).not.toHaveBeenCalled();

    capacitorState.isNativePlatform.mockReturnValue(true);
    await expect(nativeBridge.setSystemBarsTheme('light')).resolves.toBeUndefined();
    expect(capacitorState.isPluginAvailable).toHaveBeenCalledWith('SystemBars');
    expect(capacitorState.setStyle).not.toHaveBeenCalled();
  });

  it('uses light content for dark UI and dark content for light UI', async () => {
    capacitorState.isNativePlatform.mockReturnValue(true);
    capacitorState.isPluginAvailable.mockReturnValue(true);

    await nativeBridge.setSystemBarsTheme('dark');
    await nativeBridge.setSystemBarsTheme('light');

    expect(capacitorState.setStyle).toHaveBeenNthCalledWith(1, { style: 'DARK' });
    expect(capacitorState.setStyle).toHaveBeenNthCalledWith(2, { style: 'LIGHT' });
  });

  it('contains native plugin failures so theme controls stay responsive', async () => {
    capacitorState.isNativePlatform.mockReturnValue(true);
    capacitorState.isPluginAvailable.mockReturnValue(true);
    capacitorState.setStyle.mockRejectedValueOnce(new Error('native unavailable'));

    await expect(nativeBridge.setSystemBarsTheme('dark')).resolves.toBeUndefined();
  });
});
