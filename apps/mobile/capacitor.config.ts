import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'work.bonifacio.feelmyrythm',
  appName: 'FeelMyRythm',
  webDir: 'web',
  backgroundColor: '#0C0D10',
  ios: {
    contentInset: 'automatic',
    backgroundColor: '#0C0D10',
    preferredContentMode: 'mobile',
    scheme: 'FeelMyRythm',
  },
  android: {
    backgroundColor: '#0C0D10',
    allowMixedContent: false,
    captureInput: true,
  },
  server: {
    hostname: 'app.feelmyrythm.local',
    androidScheme: 'https',
    cleartext: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 900,
      backgroundColor: '#0C0D10',
      showSpinner: false,
    },
  },
};

export default config;
