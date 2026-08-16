import type { CancellableAudioEngine, ClickKind, ScheduledClick } from '@feelmyrythm/audio';
import { Capacitor, registerPlugin } from '@capacitor/core';

export interface NativeAudioStartResult {
  readonly nativeTimeSec: number;
  readonly outputLatencySec: number;
}

export interface NativeAudioPluginContract {
  start(options: { volume: number }): Promise<NativeAudioStartResult>;
  scheduleClicks(options: {
    clicks: readonly { atTimeSec: number; kind: ClickKind }[];
  }): Promise<void>;
  cancelScheduledFrom(options: { atTimeSec: number }): Promise<void>;
  setVolume(options: { volume: number }): Promise<void>;
  stop(): Promise<void>;
  addListener?(
    eventName: 'stopped',
    listener: (event: { reason: string }) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

export interface NativeAudioEngineOptions {
  readonly volume?: number;
  readonly plugin?: NativeAudioPluginContract;
  readonly performanceNow?: () => number;
}

const NativeAudio = registerPlugin<NativeAudioPluginContract>('NativeAudio');

/**
 * Maps the browser performance clock onto the platform monotonic clock once at startup.
 * Native code owns the complete click queue, so playback does not depend on WebView timers
 * after TimelineScheduler has transferred the deterministic timeline.
 */
export class NativeAudioEngine implements CancellableAudioEngine {
  readonly schedulingStrategy = 'entireTimeline' as const;
  onStopped: (() => void) | null = null;

  private readonly plugin: NativeAudioPluginContract;
  private readonly performanceNow: () => number;
  private operations: Promise<void> = Promise.resolve();
  private anchorNativeTimeSec = 0;
  private anchorPerformanceTimeMs = 0;
  private latencySec = 0;
  private volume: number;
  private started = false;
  private asynchronousError: unknown = null;
  private readonly listenerHandle: Promise<{ remove(): Promise<void> } | null>;

  constructor(options: NativeAudioEngineOptions = {}) {
    this.plugin = options.plugin ?? NativeAudio;
    this.performanceNow = options.performanceNow ?? (() => performance.now());
    this.volume = normalizeVolume(options.volume ?? 0.8);
    this.listenerHandle =
      this.plugin.addListener?.('stopped', () => {
        if (!this.started) return;
        this.started = false;
        this.onStopped?.();
      }) ?? Promise.resolve(null);
  }

  async start(): Promise<void> {
    await this.operations;
    this.throwAsynchronousError();
    const beforeMs = this.performanceNow();
    const result = await this.plugin.start({ volume: this.volume });
    const afterMs = this.performanceNow();
    if (!Number.isFinite(result.nativeTimeSec) || !Number.isFinite(result.outputLatencySec)) {
      throw new Error('Native audio returned an invalid clock sample.');
    }
    this.anchorNativeTimeSec = result.nativeTimeSec;
    this.anchorPerformanceTimeMs = (beforeMs + afterMs) / 2;
    this.latencySec = Math.max(0, result.outputLatencySec);
    this.started = true;
  }

  scheduleClick(atAudioTime: number, kind: ClickKind): void {
    this.scheduleClicks([{ atAudioTime, kind }]);
  }

  scheduleClicks(clicks: readonly ScheduledClick[]): void {
    this.requireStarted();
    if (clicks.length === 0) return;
    const payload = clicks.map(({ atAudioTime, kind }) => {
      assertFinite(atAudioTime, 'atAudioTime');
      return { atTimeSec: atAudioTime, kind };
    });
    this.enqueue(() => this.plugin.scheduleClicks({ clicks: payload }));
  }

  cancelScheduledFrom(atAudioTime: number): void {
    assertFinite(atAudioTime, 'atAudioTime');
    if (!this.started) return;
    this.enqueue(() => this.plugin.cancelScheduledFrom({ atTimeSec: atAudioTime }));
  }

  now(): number {
    if (!this.started) return 0;
    return (
      this.anchorNativeTimeSec + (this.performanceNow() - this.anchorPerformanceTimeMs) / 1_000
    );
  }

  outputLatency(): number {
    return this.latencySec;
  }

  setVolume(volume: number): void {
    this.volume = normalizeVolume(volume);
    if (this.started) this.enqueue(() => this.plugin.setVolume({ volume: this.volume }));
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.enqueue(() => this.plugin.stop());
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.operations;
    await (await this.listenerHandle)?.remove();
    this.onStopped = null;
    this.throwAsynchronousError();
  }

  private requireStarted(): void {
    this.throwAsynchronousError();
    if (!this.started) throw new Error('NativeAudioEngine.start() must finish first.');
  }

  private enqueue(operation: () => Promise<void>): void {
    this.operations = this.operations.then(operation).catch((error: unknown) => {
      this.asynchronousError ??= error;
    });
  }

  private throwAsynchronousError(): void {
    if (this.asynchronousError === null) return;
    const error = this.asynchronousError;
    this.asynchronousError = null;
    if (error instanceof Error) throw error;
    if (typeof error === 'string') throw new Error(error);
    throw new Error('A native audio bridge operation failed.');
  }
}

export function createNativeAudioEngine(options: Omit<NativeAudioEngineOptions, 'plugin'> = {}) {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('NativeAudio')) return null;
  return new NativeAudioEngine(options);
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
}

function normalizeVolume(value: number): number {
  assertFinite(value, 'volume');
  if (value < 0 || value > 1) throw new RangeError('volume must be between 0 and 1');
  return value;
}
