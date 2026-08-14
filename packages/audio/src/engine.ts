export const CLICK_KINDS = ['downbeat', 'beat', 'sub', 'countIn'] as const;

export type ClickKind = (typeof CLICK_KINDS)[number];

/** Platform adapter from DESIGN.md §5.1. All times and latencies are seconds. */
export interface AudioEngine {
  /** Reserve a click at an absolute audio-clock time. */
  scheduleClick(atAudioTime: number, kind: ClickKind): void;
  /** Current monotonic audio-clock time in seconds. */
  now(): number;
  /** Estimated graph + output-device latency in seconds. */
  outputLatency(): number;
  /** Resume/prepare the platform audio system. Call from a user gesture. */
  start(): Promise<void>;
  /** Stop pending output and suspend the platform audio system. */
  stop(): void;
}

/** Optional capability used to replace an already-looked-ahead timeline safely. */
export interface CancellableAudioEngine extends AudioEngine {
  cancelScheduledFrom(atAudioTime: number): void;
}

export function canCancelScheduledAudio(engine: AudioEngine): engine is CancellableAudioEngine {
  return 'cancelScheduledFrom' in engine && typeof engine.cancelScheduledFrom === 'function';
}
