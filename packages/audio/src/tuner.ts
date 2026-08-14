import { AudioEnvironmentError, assertFiniteNumber } from './errors.js';
import { createBrowserAudioContext } from './webAudioEngine.js';

export const TUNER_MIN_WINDOW_SIZE = 2048;
export const TUNER_MAX_WINDOW_SIZE = 4096;
export const TUNER_A4_PRESETS = [415, 430, 440, 442, 443] as const;

export interface PitchDetectionOptions {
  readonly minFrequency?: number;
  readonly maxFrequency?: number;
  readonly threshold?: number;
  readonly silenceRms?: number;
}

export interface PitchDetectionResult {
  readonly frequency: number;
  readonly clarity: number;
  readonly periodSamples: number;
  readonly rms: number;
}

export interface NoteReading {
  readonly midi: number;
  readonly name: string;
  readonly octave: number;
  readonly cents: number;
}

export interface TunerReading extends PitchDetectionResult, NoteReading {
  readonly a4: number;
  readonly timestampMs: number;
}

/** YIN pitch detection for monophonic instrument frames. */
export function detectPitch(
  samples: Float32Array,
  sampleRate: number,
  options: PitchDetectionOptions = {},
): PitchDetectionResult | null {
  validateWindowSize(samples.length);
  assertFiniteNumber(sampleRate, 'sampleRate');
  if (sampleRate <= 0) throw new RangeError('sampleRate must be greater than zero');

  const minFrequency = positive(options.minFrequency ?? 50, 'minFrequency');
  const maxFrequency = positive(options.maxFrequency ?? 2_000, 'maxFrequency');
  if (maxFrequency <= minFrequency) {
    throw new RangeError('maxFrequency must be greater than minFrequency');
  }
  const threshold = inOpenUnitInterval(options.threshold ?? 0.15, 'threshold');
  const silenceRms = nonNegative(options.silenceRms ?? 0.01, 'silenceRms');

  let sumSquares = 0;
  for (const sample of samples) sumSquares += sample * sample;
  const rms = Math.sqrt(sumSquares / samples.length);
  if (rms < silenceRms) return null;

  const minimumTau = Math.max(2, Math.floor(sampleRate / maxFrequency));
  const maximumTau = Math.min(
    Math.floor(sampleRate / minFrequency),
    Math.floor(samples.length / 2),
  );
  if (minimumTau >= maximumTau) return null;

  const difference = new Float64Array(maximumTau + 1);
  for (let tau = 1; tau <= maximumTau; tau += 1) {
    let total = 0;
    const limit = samples.length - tau;
    for (let index = 0; index < limit; index += 1) {
      const delta = samples[index]! - samples[index + tau]!;
      total += delta * delta;
    }
    difference[tau] = total;
  }

  const normalized = new Float64Array(maximumTau + 1);
  normalized[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= maximumTau; tau += 1) {
    runningSum += difference[tau]!;
    normalized[tau] = runningSum === 0 ? 1 : (difference[tau]! * tau) / runningSum;
  }

  let selectedTau = -1;
  for (let tau = minimumTau; tau <= maximumTau; tau += 1) {
    if (normalized[tau]! >= threshold) continue;
    selectedTau = tau;
    while (
      selectedTau + 1 <= maximumTau &&
      normalized[selectedTau + 1]! < normalized[selectedTau]!
    ) {
      selectedTau += 1;
    }
    break;
  }
  if (selectedTau < 0) {
    let bestValue = Number.POSITIVE_INFINITY;
    for (let tau = minimumTau; tau <= maximumTau; tau += 1) {
      if (normalized[tau]! < bestValue) {
        bestValue = normalized[tau]!;
        selectedTau = tau;
      }
    }
    if (bestValue > Math.max(0.25, threshold * 1.5)) return null;
  }

  const periodSamples = interpolateMinimum(normalized, selectedTau);
  const frequency = sampleRate / periodSamples;
  if (frequency < minFrequency || frequency > maxFrequency) return null;
  return {
    frequency,
    clarity: Math.max(0, Math.min(1, 1 - normalized[selectedTau]!)),
    periodSamples,
    rms,
  };
}

export const detectPitchYin = detectPitch;

export function frequencyToNote(frequency: number, a4 = 440): NoteReading {
  const validFrequency = positive(frequency, 'frequency');
  const validA4 = validateA4(a4);
  const midiFloat = 69 + 12 * Math.log2(validFrequency / validA4);
  const midi = Math.round(midiFloat);
  const cents = 1_200 * Math.log2(validFrequency / (validA4 * 2 ** ((midi - 69) / 12)));
  const noteNames = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  return {
    midi,
    name: noteNames[((midi % 12) + 12) % 12]!,
    octave: Math.floor(midi / 12) - 1,
    cents: Math.abs(cents) < 1e-10 ? 0 : cents,
  };
}

export class MedianStabilizer {
  private readonly values: number[] = [];

  constructor(private readonly windowSize = 5) {
    if (!Number.isInteger(windowSize) || windowSize < 1 || windowSize % 2 === 0) {
      throw new RangeError('windowSize must be a positive odd integer');
    }
  }

  push(value: number): number {
    assertFiniteNumber(value, 'value');
    this.values.push(value);
    if (this.values.length > this.windowSize) this.values.shift();
    return this.value()!;
  }

  value(): number | null {
    if (this.values.length === 0) return null;
    const sorted = [...this.values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[middle]!;
    return (sorted[middle - 1]! + sorted[middle]!) / 2;
  }

  clear(): void {
    this.values.length = 0;
  }
}

export interface TunerMediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export interface TunerEngineOptions extends PitchDetectionOptions {
  readonly windowSize?: number;
  readonly hopSize?: number;
  readonly medianWindowSize?: number;
  readonly a4?: number;
  readonly context?: AudioContext;
  readonly contextFactory?: () => AudioContext;
  readonly mediaDevices?: TunerMediaDevicesLike;
}

let tunerProcessorSequence = 0;

/** Browser microphone adapter; AudioWorklet collects frames, YIN remains deterministic TS. */
export class TunerEngine {
  onReading: ((reading: TunerReading | null) => void) | null = null;

  private readonly windowSize: number;
  private readonly hopSize: number;
  private readonly detectionOptions: PitchDetectionOptions;
  private readonly stabilizer: MedianStabilizer;
  private readonly contextFactory: () => AudioContext;
  private readonly ownsContext: boolean;
  private readonly mediaDevices: TunerMediaDevicesLike | null;
  private context: AudioContext | null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private silentGain: GainNode | null = null;
  private running = false;
  private startPromise: Promise<void> | null = null;
  private lifecycleGeneration = 0;
  private a4: number;
  private lastReading: TunerReading | null = null;
  private consecutiveMisses = 0;

  constructor(options: TunerEngineOptions = {}) {
    this.windowSize = options.windowSize ?? 4096;
    validateWindowSize(this.windowSize);
    this.hopSize = options.hopSize ?? Math.floor(this.windowSize / 2);
    if (!Number.isInteger(this.hopSize) || this.hopSize < 1 || this.hopSize > this.windowSize) {
      throw new RangeError('hopSize must be an integer between 1 and windowSize');
    }
    this.a4 = validateA4(options.a4 ?? 440);
    this.stabilizer = new MedianStabilizer(options.medianWindowSize ?? 5);
    this.detectionOptions = pickDetectionOptions(options);
    this.context = options.context ?? null;
    this.ownsContext = options.context === undefined;
    this.contextFactory = options.contextFactory ?? createBrowserAudioContext;
    this.mediaDevices =
      options.mediaDevices ??
      (typeof navigator === 'undefined' || navigator.mediaDevices === undefined
        ? null
        : navigator.mediaDevices);
  }

  get isRunning(): boolean {
    return this.running;
  }

  get reading(): TunerReading | null {
    return this.lastReading;
  }

  get concertA(): number {
    return this.a4;
  }

  setA4(a4: number): void {
    this.a4 = validateA4(a4);
    this.stabilizer.clear();
    this.lastReading = null;
  }

  processFrame(samples: Float32Array, sampleRate: number): TunerReading | null {
    const detected = detectPitch(samples, sampleRate, this.detectionOptions);
    if (detected === null) {
      this.consecutiveMisses += 1;
      if (this.consecutiveMisses >= 3) this.stabilizer.clear();
      this.lastReading = null;
      this.onReading?.(null);
      return null;
    }
    this.consecutiveMisses = 0;
    const stabilizedFrequency = this.stabilizer.push(detected.frequency);
    const note = frequencyToNote(stabilizedFrequency, this.a4);
    const reading: TunerReading = {
      ...detected,
      ...note,
      frequency: stabilizedFrequency,
      a4: this.a4,
      timestampMs: currentTimestamp(),
    };
    this.lastReading = reading;
    this.onReading?.(reading);
    return reading;
  }

  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    const generation = ++this.lifecycleGeneration;
    const pending = this.startGeneration(generation).finally(() => {
      if (this.startPromise === pending) this.startPromise = null;
    });
    this.startPromise = pending;
    return pending;
  }

  private async startGeneration(generation: number): Promise<void> {
    if (
      this.mediaDevices === null ||
      typeof AudioWorkletNode === 'undefined' ||
      typeof Blob === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      throw new AudioEnvironmentError(
        'tuner-unsupported',
        'This browser does not provide microphone AudioWorklet support.',
      );
    }

    const context = this.context ?? this.contextFactory();
    this.context = context;
    if (context.audioWorklet === undefined) {
      if (this.ownsContext && context.state !== 'closed')
        void context.close().catch(() => undefined);
      if (this.ownsContext) this.context = null;
      throw new AudioEnvironmentError(
        'tuner-unsupported',
        'This browser does not provide AudioContext.audioWorklet.',
      );
    }

    try {
      if (context.state === 'suspended') await context.resume();
      if (generation !== this.lifecycleGeneration) return;
      const stream = await this.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
        },
        video: false,
      });
      if (generation !== this.lifecycleGeneration) {
        stopStream(stream);
        return;
      }
      this.stream = stream;

      const processorName = `feelmyrythm-tuner-${++tunerProcessorSequence}`;
      const sourceUrl = URL.createObjectURL(
        new Blob([workletSource(processorName, this.windowSize, this.hopSize)], {
          type: 'application/javascript',
        }),
      );
      try {
        await context.audioWorklet.addModule(sourceUrl);
      } finally {
        URL.revokeObjectURL(sourceUrl);
      }
      if (generation !== this.lifecycleGeneration) return;

      const source = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, processorName, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      worklet.port.onmessage = (event: MessageEvent<Float32Array | ArrayBuffer>) => {
        const frame =
          event.data instanceof Float32Array ? event.data : new Float32Array(event.data);
        this.processFrame(frame, context.sampleRate);
      };
      source.connect(worklet);
      worklet.connect(silentGain);
      silentGain.connect(context.destination);
      this.source = source;
      this.worklet = worklet;
      this.silentGain = silentGain;
      this.running = true;
    } catch (error) {
      if (generation !== this.lifecycleGeneration) return;
      this.releaseResources();
      if (error instanceof AudioEnvironmentError) throw error;
      throw new AudioEnvironmentError(
        'tuner-start-failed',
        'The microphone tuner could not be started.',
        { cause: error },
      );
    }
  }

  stop(): void {
    this.lifecycleGeneration += 1;
    this.releaseResources();
  }

  private releaseResources(): void {
    disconnect(this.source);
    disconnect(this.worklet);
    disconnect(this.silentGain);
    this.source = null;
    this.worklet = null;
    this.silentGain = null;
    if (this.stream) stopStream(this.stream);
    this.stream = null;
    this.running = false;
    this.consecutiveMisses = 0;
    this.stabilizer.clear();
    this.lastReading = null;
    const context = this.context;
    if (this.ownsContext) {
      this.context = null;
      if (context !== null && context.state !== 'closed')
        void context.close().catch(() => undefined);
    }
  }
}

function interpolateMinimum(values: Float64Array, index: number): number {
  if (index <= 0 || index >= values.length - 1) return index;
  const left = values[index - 1]!;
  const center = values[index]!;
  const right = values[index + 1]!;
  const denominator = left - 2 * center + right;
  if (Math.abs(denominator) < Number.EPSILON) return index;
  const shift = Math.max(-1, Math.min(1, (0.5 * (left - right)) / denominator));
  return index + shift;
}

function validateWindowSize(size: number): void {
  if (!Number.isInteger(size) || size < TUNER_MIN_WINDOW_SIZE || size > TUNER_MAX_WINDOW_SIZE) {
    throw new RangeError(
      `window size must be an integer from ${TUNER_MIN_WINDOW_SIZE} to ${TUNER_MAX_WINDOW_SIZE}`,
    );
  }
}

function validateA4(a4: number): number {
  const value = positive(a4, 'a4');
  if (value < 400 || value > 480) throw new RangeError('a4 must be between 400 and 480 Hz');
  return value;
}

function pickDetectionOptions(options: TunerEngineOptions): PitchDetectionOptions {
  const result: {
    minFrequency?: number;
    maxFrequency?: number;
    threshold?: number;
    silenceRms?: number;
  } = {};
  if (options.minFrequency !== undefined) result.minFrequency = options.minFrequency;
  if (options.maxFrequency !== undefined) result.maxFrequency = options.maxFrequency;
  if (options.threshold !== undefined) result.threshold = options.threshold;
  if (options.silenceRms !== undefined) result.silenceRms = options.silenceRms;
  return result;
}

function workletSource(processorName: string, windowSize: number, hopSize: number): string {
  return `class FrameCollector extends AudioWorkletProcessor{constructor(){super();this.ring=new Float32Array(${windowSize});this.write=0;this.filled=0;this.since=0;}process(inputs,outputs){const input=inputs[0]&&inputs[0][0];const output=outputs[0]&&outputs[0][0];if(output)output.fill(0);if(!input)return true;for(let i=0;i<input.length;i++){this.ring[this.write]=input[i];this.write=(this.write+1)%${windowSize};this.filled=Math.min(${windowSize},this.filled+1);this.since++;if(this.filled===${windowSize}&&this.since>=${hopSize}){const frame=new Float32Array(${windowSize});for(let j=0;j<${windowSize};j++)frame[j]=this.ring[(this.write+j)%${windowSize}];this.port.postMessage(frame,[frame.buffer]);this.since=0;}}return true;}}registerProcessor(${JSON.stringify(processorName)},FrameCollector);`;
}

function disconnect(node: AudioNode | null): void {
  try {
    node?.disconnect();
  } catch {
    // Disconnecting an already detached node is idempotent for our lifecycle.
  }
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function currentTimestamp(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function positive(value: number, label: string): number {
  assertFiniteNumber(value, label);
  if (value <= 0) throw new RangeError(`${label} must be greater than zero`);
  return value;
}

function nonNegative(value: number, label: string): number {
  assertFiniteNumber(value, label);
  if (value < 0) throw new RangeError(`${label} must not be negative`);
  return value;
}

function inOpenUnitInterval(value: number, label: string): number {
  assertFiniteNumber(value, label);
  if (value <= 0 || value >= 1) throw new RangeError(`${label} must be between 0 and 1`);
  return value;
}
