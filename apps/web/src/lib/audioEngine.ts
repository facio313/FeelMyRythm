import { WebAudioEngine, type CancellableAudioEngine, type ClickKind } from '@feelmyrythm/audio';
import { nativeBridge } from '@feelmyrythm/mobile';

export interface ManagedAudioEngine extends CancellableAudioEngine {
  onStopped?: (() => void) | null;
  setVolume(volume: number): void;
  dispose(): Promise<void>;
  scheduleClick(atAudioTime: number, kind: ClickKind): void;
}

export function createPlatformAudioEngine(volume = 0.8): ManagedAudioEngine {
  const nativeEngine = nativeBridge.createAudioEngine?.({ volume });
  return nativeEngine ?? new WebAudioEngine({ volume });
}
