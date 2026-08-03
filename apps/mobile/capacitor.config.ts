import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.feelmyrythm.app',
  appName: 'FeelMyRythm',
  // 웹 앱 빌드를 그대로 래핑 (설계문서 §2.2)
  webDir: '../web/dist',
  server: {
    androidScheme: 'https',
  },
  ios: {
    // 무음 스위치에서도 메트로놈이 울리도록 오디오 세션은 네이티브 설정에서 playback 카테고리로 지정할 것
    contentInset: 'automatic',
  },
};

export default config;
