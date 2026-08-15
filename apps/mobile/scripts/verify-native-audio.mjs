import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stdout } from 'node:process';

const root = resolve(import.meta.dirname, '..');

async function requireTokens(relativePath, tokens) {
  const contents = await readFile(resolve(root, relativePath), 'utf8');
  const missing = tokens.filter((token) => !contents.includes(token));
  if (missing.length > 0) {
    throw new Error(
      `${relativePath} is missing native-audio contract tokens: ${missing.join(', ')}`,
    );
  }
}

await requireTokens('ios/App/App/SecureStoragePlugin.swift', [
  'registerPluginInstance(NativeAudioPlugin())',
]);
await requireTokens('ios/App/App/NativeAudioPlugin.swift', [
  'AVAudioEngine',
  'setCategory(.playback',
  'scheduleClicks',
  'cancelScheduledFrom',
]);
await requireTokens('ios/App/App.xcodeproj/project.pbxproj', [
  'NativeAudioPlugin.swift in Sources',
]);
await requireTokens('ios/App/App/Info.plist', ['UIBackgroundModes', '<string>audio</string>']);
await requireTokens('android/app/src/main/AndroidManifest.xml', [
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  'android:foregroundServiceType="mediaPlayback"',
  '.NativeAudioPlaybackService',
]);
await requireTokens('android/app/build.gradle', [
  'com.google.oboe:oboe:1.10.0',
  "path file('src/main/cpp/CMakeLists.txt')",
]);
await requireTokens('android/app/src/main/cpp/native-audio.cpp', [
  'PerformanceMode::LowLatency',
  'onAudioReady',
  'CLOCK_MONOTONIC',
]);
await requireTokens('android/app/src/main/java/work/bonifacio/feelmyrythm/MainActivity.java', [
  'registerPlugin(NativeAudioPlugin.class)',
]);
await requireTokens(
  'android/app/src/main/java/work/bonifacio/feelmyrythm/NativeAudioPlaybackService.java',
  ['startForeground', 'Notification.MediaStyle', 'AUDIOFOCUS_GAIN'],
);
await requireTokens('src/nativeAudio.ts', [
  "schedulingStrategy = 'entireTimeline'",
  "registerPlugin<NativeAudioPluginContract>('NativeAudio')",
]);

stdout.write(
  'Verified native audio plugin, background service, and platform registration contracts.\n',
);
