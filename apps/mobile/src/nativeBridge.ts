import { KeepAwake } from '@capacitor-community/keep-awake';
import { App } from '@capacitor/app';
import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { subscribeToDeepLinks } from './deepLink';

export { platformStorage } from './secureStorage';

export interface NativeBridge {
  readonly native: boolean;
  keepAwake(): Promise<void>;
  allowSleep(): Promise<void>;
  beatHaptic(accent: 0 | 1 | 2): Promise<void>;
  setSystemBarsTheme(theme: 'dark' | 'light'): Promise<void>;
  onDeepLink(listener: (path: string) => void): Promise<() => void>;
}

export const nativeBridge: NativeBridge = {
  native: Capacitor.isNativePlatform(),
  async keepAwake() {
    if (Capacitor.isNativePlatform()) await KeepAwake.keepAwake();
  },
  async allowSleep() {
    if (Capacitor.isNativePlatform()) await KeepAwake.allowSleep();
  },
  async beatHaptic(accent) {
    if (!Capacitor.isNativePlatform()) return;
    await Haptics.impact({
      style:
        accent === 2 ? ImpactStyle.Heavy : accent === 1 ? ImpactStyle.Medium : ImpactStyle.Light,
    });
  },
  async setSystemBarsTheme(theme) {
    if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('SystemBars')) return;
    try {
      await SystemBars.setStyle({
        // Capacitor's Dark style means light content on a dark background.
        style: theme === 'dark' ? SystemBarsStyle.Dark : SystemBarsStyle.Light,
      });
    } catch {
      // Theme changes must remain usable when a platform cannot update its system bars.
    }
  },
  async onDeepLink(listener) {
    if (!Capacitor.isNativePlatform()) return () => undefined;
    return subscribeToDeepLinks(App, listener);
  },
};
