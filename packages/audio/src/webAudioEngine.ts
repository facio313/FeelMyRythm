import { CLICK_KINDS, type AudioEngine, type ClickKind } from './engine.js';
import { AudioEnvironmentError, assertFiniteNumber } from './errors.js';

export type ClickSampleSource = AudioBuffer | ArrayBuffer;

export interface WebAudioEngineOptions {
  /** Injecting a context is useful when sharing a context or testing. */
  context?: AudioContext;
  contextFactory?: () => AudioContext;
  /** Missing kinds receive deterministic built-in PCM clicks. */
  samples?: Partial<Record<ClickKind, ClickSampleSource>>;
  volume?: number;
}

interface ScheduledSource {
  readonly source: AudioBufferSourceNode;
  readonly atAudioTime: number;
}

/** Web/Capacitor implementation that only schedules prebuilt AudioBuffer samples. */
export class WebAudioEngine implements AudioEngine {
  private context: AudioContext | null;
  private readonly ownsContext: boolean;
  private readonly contextFactory: () => AudioContext;
  private readonly configuredSamples: Partial<Record<ClickKind, ClickSampleSource>>;
  private readonly buffers = new Map<ClickKind, AudioBuffer>();
  private readonly scheduled = new Set<ScheduledSource>();
  private gain: GainNode | null = null;
  private preparePromise: Promise<void> | null = null;
  private lifecyclePromise: Promise<void> = Promise.resolve();
  private started = false;
  private volume: number;

  constructor(options: WebAudioEngineOptions = {}) {
    this.context = options.context ?? null;
    this.ownsContext = options.context === undefined;
    this.contextFactory = options.contextFactory ?? createBrowserAudioContext;
    this.configuredSamples = options.samples ?? {};
    this.volume = normalizeVolume(options.volume ?? 0.8);
  }

  get isReady(): boolean {
    return this.started && this.buffers.size === CLICK_KINDS.length;
  }

  async start(): Promise<void> {
    const operation = this.lifecyclePromise.then(() => this.startInternal());
    this.lifecyclePromise = operation.catch(() => undefined);
    await operation;
  }

  private async startInternal(): Promise<void> {
    const context = this.ensureContext();
    if (context.state === 'closed') {
      throw new AudioEnvironmentError('audio-context-closed', 'The Web Audio context is closed.');
    }

    if (context.state === 'suspended') await context.resume();
    this.ensureGain(context);

    this.preparePromise ??= this.prepareBuffers(context).catch((error: unknown) => {
      this.preparePromise = null;
      throw error;
    });
    await this.preparePromise;
    this.started = true;
  }

  scheduleClick(atAudioTime: number, kind: ClickKind): void {
    assertFiniteNumber(atAudioTime, 'atAudioTime');
    const context = this.context;
    const gain = this.gain;
    const buffer = this.buffers.get(kind);
    if (!this.started || context === null || gain === null || buffer === undefined) {
      throw new AudioEnvironmentError(
        'audio-engine-not-started',
        'WebAudioEngine.start() must finish before clicks can be scheduled.',
      );
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    const actualStartTime = Math.max(atAudioTime, context.currentTime);
    const scheduled: ScheduledSource = { source, atAudioTime: actualStartTime };
    this.scheduled.add(scheduled);
    source.onended = () => this.scheduled.delete(scheduled);
    source.start(actualStartTime);
  }

  now(): number {
    return this.context?.currentTime ?? 0;
  }

  outputLatency(): number {
    const context = this.context;
    if (context === null) return 0;
    const base = finiteNonNegative(context.baseLatency);
    const output = finiteNonNegative(
      (context as AudioContext & { readonly outputLatency?: number }).outputLatency ?? 0,
    );
    return base + output;
  }

  setVolume(volume: number): void {
    this.volume = normalizeVolume(volume);
    if (this.gain !== null) this.gain.gain.value = this.volume;
  }

  cancelScheduledFrom(atAudioTime: number): void {
    assertFiniteNumber(atAudioTime, 'atAudioTime');
    for (const scheduled of [...this.scheduled]) {
      if (scheduled.atAudioTime + Number.EPSILON < atAudioTime) continue;
      stopSource(scheduled.source);
      this.scheduled.delete(scheduled);
    }
  }

  cancelScheduled(): void {
    for (const scheduled of [...this.scheduled]) {
      stopSource(scheduled.source);
      this.scheduled.delete(scheduled);
    }
  }

  stop(): void {
    this.cancelScheduled();
    this.started = false;
    const operation = this.lifecyclePromise.then(async () => {
      const context = this.context;
      if (context !== null && context.state === 'running') await context.suspend();
      this.started = false;
    });
    this.lifecyclePromise = operation.catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.lifecyclePromise;
    const context = this.context;
    this.context = null;
    this.gain = null;
    this.buffers.clear();
    this.preparePromise = null;
    this.lifecyclePromise = Promise.resolve();
    if (this.ownsContext && context !== null && context.state !== 'closed') await context.close();
  }

  private ensureContext(): AudioContext {
    this.context ??= this.contextFactory();
    return this.context;
  }

  private ensureGain(context: AudioContext): void {
    if (this.gain !== null) return;
    this.gain = context.createGain();
    this.gain.gain.value = this.volume;
    this.gain.connect(context.destination);
  }

  private async prepareBuffers(context: AudioContext): Promise<void> {
    const prepared = new Map<ClickKind, AudioBuffer>();
    try {
      for (const kind of CLICK_KINDS) {
        const source = this.configuredSamples[kind];
        if (source === undefined) {
          prepared.set(kind, createDefaultClickBuffer(context, kind));
        } else if (source instanceof ArrayBuffer) {
          prepared.set(kind, await context.decodeAudioData(source.slice(0)));
        } else {
          prepared.set(kind, source);
        }
      }
    } catch (error) {
      throw new AudioEnvironmentError(
        'audio-sample-decode-failed',
        'One or more click samples could not be prepared.',
        { cause: error },
      );
    }

    this.buffers.clear();
    for (const [kind, buffer] of prepared) this.buffers.set(kind, buffer);
  }
}

export function createBrowserAudioContext(): AudioContext {
  type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;
  const browserGlobal = globalThis as typeof globalThis & {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  const Constructor = browserGlobal.AudioContext ?? browserGlobal.webkitAudioContext;
  if (Constructor === undefined) {
    throw new AudioEnvironmentError(
      'audio-context-unsupported',
      'This browser does not provide the Web Audio API.',
    );
  }
  return new Constructor({ latencyHint: 'interactive' });
}

function createDefaultClickBuffer(context: AudioContext, kind: ClickKind): AudioBuffer {
  const definitions: Record<
    ClickKind,
    {
      readonly frequency: number;
      readonly overtone: number;
      readonly duration: number;
      readonly gain: number;
    }
  > = {
    downbeat: { frequency: 1_760, overtone: 2.1, duration: 0.055, gain: 0.95 },
    beat: { frequency: 1_180, overtone: 2.4, duration: 0.045, gain: 0.72 },
    sub: { frequency: 760, overtone: 1.7, duration: 0.028, gain: 0.46 },
    countIn: { frequency: 2_240, overtone: 1.45, duration: 0.06, gain: 0.82 },
  };
  const definition = definitions[kind];
  const length = Math.max(1, Math.ceil(definition.duration * context.sampleRate));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const channel = buffer.getChannelData(0);

  for (let index = 0; index < length; index += 1) {
    const time = index / context.sampleRate;
    const attack = Math.min(1, time / 0.0008);
    const envelope = attack * Math.exp(-time * (kind === 'sub' ? 115 : 78));
    const primary = Math.sin(2 * Math.PI * definition.frequency * time);
    const overtone = Math.sin(
      2 * Math.PI * definition.frequency * definition.overtone * time + 0.35,
    );
    const transient = deterministicNoise(index) * Math.exp(-time * 260);
    channel[index] =
      definition.gain * envelope * (0.68 * primary + 0.24 * overtone + 0.08 * transient);
  }
  return buffer;
}

function deterministicNoise(index: number): number {
  const value = Math.sin((index + 1) * 12.9898) * 43_758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeVolume(value: number): number {
  assertFiniteNumber(value, 'volume');
  if (value < 0 || value > 1) throw new RangeError('volume must be between 0 and 1');
  return value;
}

function stopSource(source: AudioBufferSourceNode): void {
  try {
    source.stop();
  } catch {
    // A source that naturally ended or never started is already harmless.
  }
}
