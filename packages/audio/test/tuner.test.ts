import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AudioEnvironmentError,
  MedianStabilizer,
  TUNER_A4_PRESETS,
  TunerEngine,
  detectPitch,
  frequencyToNote,
} from '../src/index.js';

function sine(frequency: number, sampleRate = 48_000, size = 4096): Float32Array {
  return Float32Array.from(
    { length: size },
    (_, index) => 0.75 * Math.sin((2 * Math.PI * frequency * index) / sampleRate),
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function mediaStreamHarness(): { stream: MediaStream; stopTrack: ReturnType<typeof vi.fn> } {
  const stopTrack = vi.fn();
  const stream = {
    getTracks: () => [{ stop: stopTrack }],
  } as unknown as MediaStream;
  return { stopTrack, stream };
}

function audioContextHarness(addModule: (url: string) => Promise<void>): {
  addModule: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  context: AudioContext;
  createMediaStreamSource: ReturnType<typeof vi.fn>;
} {
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const gain = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    gain: { value: 1 },
  };
  const addModuleMock = vi.fn(addModule);
  const close = vi.fn(async () => undefined);
  const createMediaStreamSource = vi.fn(() => source);
  const context = {
    audioWorklet: { addModule: addModuleMock },
    close,
    createGain: vi.fn(() => gain),
    createMediaStreamSource,
    destination: {},
    resume: vi.fn(async () => undefined),
    sampleRate: 48_000,
    state: 'running',
  } as unknown as AudioContext;
  return { addModule: addModuleMock, close, context, createMediaStreamSource };
}

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:tuner-worklet');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.stubGlobal(
    'AudioWorkletNode',
    class {
      readonly connect = vi.fn();
      readonly disconnect = vi.fn();
      readonly port = { onmessage: null };
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('YIN pitch detection', () => {
  it.each([220, 440, 880, 1760])('detects a synthetic %d Hz tone', (frequency) => {
    const result = detectPitch(sine(frequency), 48_000, {
      minFrequency: 80,
      maxFrequency: 2_000,
    });
    expect(result).not.toBeNull();
    const centsError = 1_200 * Math.log2(result!.frequency / frequency);
    expect(Math.abs(centsError)).toBeLessThan(2);
    expect(result!.clarity).toBeGreaterThan(0.8);
  });

  it('rejects silence and frame sizes outside 2048-4096', () => {
    expect(detectPitch(new Float32Array(2048), 48_000)).toBeNull();
    expect(() => detectPitch(sine(440, 48_000, 1024), 48_000)).toThrow(RangeError);
    expect(() => detectPitch(sine(440, 48_000, 8192), 48_000)).toThrow(RangeError);
  });

  it('converts frequency to note/cents using the selected concert A', () => {
    expect(frequencyToNote(442, 442)).toMatchObject({ name: 'A', octave: 4, cents: 0 });
    expect(TUNER_A4_PRESETS).toEqual([415, 430, 440, 442, 443]);
  });

  it('stabilizes readings with a rolling median', () => {
    const median = new MedianStabilizer(5);
    [440, 440.2, 900, 439.9, 440.1].forEach((value) => median.push(value));
    expect(median.value()).toBeCloseTo(440.1, 8);
  });

  it('reports a typed safe error when browser tuner APIs are unavailable', async () => {
    vi.stubGlobal('AudioWorkletNode', undefined);
    const tuner = new TunerEngine();
    await expect(tuner.start()).rejects.toBeInstanceOf(AudioEnvironmentError);
  });

  it('shares one in-flight microphone start across concurrent callers', async () => {
    const microphone = deferred<MediaStream>();
    const { stopTrack, stream } = mediaStreamHarness();
    const audio = audioContextHarness(async () => undefined);
    const getUserMedia = vi.fn(() => microphone.promise);
    const tuner = new TunerEngine({
      contextFactory: () => audio.context,
      mediaDevices: { getUserMedia },
    });

    const firstStart = tuner.start();
    const secondStart = tuner.start();

    expect(secondStart).toBe(firstStart);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    microphone.resolve(stream);
    await expect(firstStart).resolves.toBeUndefined();

    expect(tuner.isRunning).toBe(true);
    expect(audio.addModule).toHaveBeenCalledTimes(1);
    expect(audio.createMediaStreamSource).toHaveBeenCalledTimes(1);
    tuner.stop();
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it('stops a microphone stream that resolves after stop during start', async () => {
    const microphone = deferred<MediaStream>();
    const { stopTrack, stream } = mediaStreamHarness();
    const audio = audioContextHarness(async () => undefined);
    const getUserMedia = vi.fn(() => microphone.promise);
    const tuner = new TunerEngine({
      contextFactory: () => audio.context,
      mediaDevices: { getUserMedia },
    });

    const start = tuner.start();
    tuner.stop();
    microphone.resolve(stream);
    await expect(start).resolves.toBeUndefined();

    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(audio.addModule).not.toHaveBeenCalled();
    expect(audio.createMediaStreamSource).not.toHaveBeenCalled();
    expect(audio.close).toHaveBeenCalledTimes(1);
    expect(tuner.isRunning).toBe(false);
  });

  it('does not build a graph after stop while the worklet module is loading', async () => {
    const moduleLoad = deferred<void>();
    const { stopTrack, stream } = mediaStreamHarness();
    const audio = audioContextHarness(() => moduleLoad.promise);
    const getUserMedia = vi.fn(async () => stream);
    const tuner = new TunerEngine({
      contextFactory: () => audio.context,
      mediaDevices: { getUserMedia },
    });

    const start = tuner.start();
    await vi.waitFor(() => expect(audio.addModule).toHaveBeenCalledTimes(1));
    tuner.stop();
    moduleLoad.resolve();
    await expect(start).resolves.toBeUndefined();

    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(audio.createMediaStreamSource).not.toHaveBeenCalled();
    expect(audio.close).toHaveBeenCalledTimes(1);
    expect(tuner.isRunning).toBe(false);
  });
});
