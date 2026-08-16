import { act, renderHook } from '@testing-library/react';
import { calibratedVisualTimeMs, type PerformanceTimeline, type TempoMap } from '@feelmyrythm/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const powerMocks = vi.hoisted(() => ({
  schedulers: [] as Array<{ onEnded: (() => void) | null }>,
  acquireWakeLock: vi.fn(async () => undefined),
  releaseWakeLock: vi.fn(async () => undefined),
  disposeWakeLock: vi.fn(async () => undefined),
  keepAwake: vi.fn(async () => undefined),
  allowSleep: vi.fn(async () => undefined),
  createAudioEngine: vi.fn(
    () =>
      null as null | {
        onStopped: (() => void) | null;
        start(): Promise<void>;
        now(): number;
        outputLatency(): number;
        stop(): void;
        setVolume(): void;
        dispose(): Promise<void>;
      },
  ),
}));

vi.mock('@feelmyrythm/audio', () => {
  class MockAudioPerformanceMapper {
    clear() {}
    sampleNow() {}
  }

  class MockBrowserWakeLockAdapter {
    acquire() {
      return powerMocks.acquireWakeLock();
    }
    release() {
      return powerMocks.releaseWakeLock();
    }
    dispose() {
      return powerMocks.disposeWakeLock();
    }
  }

  class MockOffsetServerPerformanceMapper {}

  class MockServerAudioMapper {
    serverToScheduledAudio() {
      return 2;
    }
  }

  class MockTimelineTransport {
    readonly scheduler = { onEnded: null as (() => void) | null };
    readonly beatQueue = {
      currentAt: () => null,
      nextAtOrAfter: () => null,
    };
    isPlaying = true;

    constructor() {
      powerMocks.schedulers.push(this.scheduler);
    }

    async start() {
      this.isPlaying = true;
    }

    stop() {
      this.isPlaying = false;
    }

    position() {
      return 0;
    }

    queueTimelineTransition() {}
  }

  class MockWebAudioEngine {
    async start() {}
    now() {
      return 1;
    }
    outputLatency() {
      return 0;
    }
    stop() {}
    setVolume() {}
    async dispose() {}
  }

  return {
    AudioPerformanceMapper: MockAudioPerformanceMapper,
    BrowserWakeLockAdapter: MockBrowserWakeLockAdapter,
    OffsetServerPerformanceMapper: MockOffsetServerPerformanceMapper,
    ServerAudioMapper: MockServerAudioMapper,
    TimelineTransport: MockTimelineTransport,
    WebAudioEngine: MockWebAudioEngine,
  };
});

vi.mock('@feelmyrythm/mobile', () => ({
  nativeBridge: {
    beatHaptic: vi.fn(async () => undefined),
    keepAwake: powerMocks.keepAwake,
    allowSleep: powerMocks.allowSleep,
    createAudioEngine: powerMocks.createAudioEngine,
  },
}));

import {
  lateJoinEntry,
  parseVisualOffsetMs,
  readVisualOffsetMs,
  useMetronome,
  VISUAL_OFFSET_MAX_MS,
  VISUAL_OFFSET_MIN_MS,
  visualFrameAudioTimeSec,
} from './useMetronome';

const timeline: PerformanceTimeline = {
  tempoMapRevision: 1,
  totalDurationSec: 3,
  entries: [0, 1, 2].map((startTimeSec, index) => ({
    measureNumber: index + 10,
    pass: 1,
    sectionId: 'section-1',
    startTimeSec,
    beats: [
      {
        timeSec: startTimeSec,
        accent: 2,
        isSubdivision: false,
        beatIndex: 0,
        subdivisionIndex: 0,
      },
    ],
  })),
};

const map: TempoMap = {
  id: 'map-1',
  repertoireItemId: 'local',
  revision: 1,
  totalMeasures: 1,
  sections: [
    {
      id: 'section-1',
      startMeasure: 1,
      endMeasure: 1,
      timeSignature: { num: 4, denom: 4 },
      bpm: 120,
      beatUnit: 'quarter',
      subdivision: 1,
    },
  ],
  jumps: [],
  countIn: { measures: 1, useSectionMeter: true },
};

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  powerMocks.schedulers.length = 0;
  powerMocks.acquireWakeLock.mockClear();
  powerMocks.releaseWakeLock.mockClear();
  powerMocks.disposeWakeLock.mockClear();
  powerMocks.keepAwake.mockClear();
  powerMocks.allowSleep.mockClear();
  powerMocks.createAudioEngine.mockReset().mockReturnValue(null);
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lateJoinEntry', () => {
  it('keeps the requested measure when count-in has begun but its anchor is schedulable', () => {
    expect(lateJoinEntry(timeline, 0, true)?.measureNumber).toBe(10);
  });

  it('uses the following measure once the current boundary is no longer schedulable', () => {
    expect(lateJoinEntry(timeline, 0, false)?.measureNumber).toBe(11);
    expect(lateJoinEntry(timeline, 0.2, false)?.measureNumber).toBe(11);
    expect(lateJoinEntry(timeline, 2.1, false)).toBeUndefined();
  });
});

describe('visual frame calibration', () => {
  it('accepts only finite offsets inside the Settings range', () => {
    expect(parseVisualOffsetMs(String(VISUAL_OFFSET_MIN_MS))).toBe(VISUAL_OFFSET_MIN_MS);
    expect(parseVisualOffsetMs(String(VISUAL_OFFSET_MAX_MS))).toBe(VISUAL_OFFSET_MAX_MS);
    expect(parseVisualOffsetMs(String(VISUAL_OFFSET_MIN_MS - 0.1))).toBeNull();
    expect(parseVisualOffsetMs(String(VISUAL_OFFSET_MAX_MS + 0.1))).toBeNull();
    expect(parseVisualOffsetMs('')).toBeNull();
    expect(parseVisualOffsetMs('Infinity')).toBeNull();
  });

  it('uses zero when persisted visual calibration is absent or invalid', () => {
    expect(readVisualOffsetMs({ getItem: () => null })).toBe(0);
    expect(readVisualOffsetMs({ getItem: () => 'not-a-number' })).toBe(0);
    expect(readVisualOffsetMs({ getItem: () => '16.7' })).toBe(16.7);
  });

  it('looks ahead for positive offsets and behind for negative offsets', () => {
    expect(visualFrameAudioTimeSec(2, 40)).toBeCloseTo(2.04);
    expect(visualFrameAudioTimeSec(2, -40)).toBeCloseTo(1.96);

    const targetEventMs = 2_040;
    const calibration = {
      outputLatencySec: 0,
      manualOffsetMs: 0,
      visualOffsetMs: 40,
    };
    const earlyRenderTimeMs = calibratedVisualTimeMs(targetEventMs, calibration);
    expect(earlyRenderTimeMs).toBe(2_000);
    expect(visualFrameAudioTimeSec(earlyRenderTimeMs / 1_000, 40)).toBeCloseTo(
      targetEventMs / 1_000,
    );

    const delayedEventMs = 1_960;
    const delayedRenderTimeMs = calibratedVisualTimeMs(delayedEventMs, {
      ...calibration,
      visualOffsetMs: -40,
    });
    expect(delayedRenderTimeMs).toBe(2_000);
    expect(visualFrameAudioTimeSec(delayedRenderTimeMs / 1_000, -40)).toBeCloseTo(
      delayedEventMs / 1_000,
    );
  });
});

describe('natural playback power cleanup', () => {
  it('stops an audio session that finishes starting after the user has cancelled playback', async () => {
    let finishStart: (() => void) | undefined;
    const nativeEngine = {
      onStopped: null as (() => void) | null,
      start: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishStart = resolve;
          }),
      ),
      now: vi.fn(() => 1),
      outputLatency: vi.fn(() => 0),
      stop: vi.fn(),
      setVolume: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    powerMocks.createAudioEngine.mockReturnValue(nativeEngine);
    const { result } = renderHook(() => useMetronome(map));
    let pendingStart: Promise<void> | undefined;

    act(() => {
      pendingStart = result.current.start(1, 1, false);
    });
    act(() => result.current.stop());
    await act(async () => {
      finishStart?.();
      await pendingStart;
    });

    expect(nativeEngine.stop).toHaveBeenCalledTimes(1);
    expect(result.current.playing).toBe(false);
    expect(powerMocks.keepAwake).not.toHaveBeenCalled();
  });

  it('closes the current audio session when synchronized start validation fails', async () => {
    const nativeEngine = {
      onStopped: null as (() => void) | null,
      start: vi.fn(async () => undefined),
      now: vi.fn(() => 100),
      outputLatency: vi.fn(() => 0),
      stop: vi.fn(),
      setVolume: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    powerMocks.createAudioEngine.mockReturnValue(nativeEngine);
    const { result } = renderHook(() => useMetronome(map));

    await expect(
      act(async () =>
        result.current.startSynchronized({
          measure: 1,
          pass: 1,
          serverStartTimeMs: 0,
          serverOffsetMs: 0,
          withCountIn: false,
        }),
      ),
    ).rejects.toThrow('다음 마디 경계');

    expect(nativeEngine.stop).toHaveBeenCalledTimes(1);
    expect(result.current.playing).toBe(false);
    expect(powerMocks.keepAwake).not.toHaveBeenCalled();
  });

  it.each(['local', 'synchronized'] as const)(
    'releases browser and native wake controls exactly once after %s playback ends',
    async (mode) => {
      const { result, unmount } = renderHook(() => useMetronome(map));

      await act(async () => {
        if (mode === 'local') {
          await result.current.start(1, 1, false);
        } else {
          await result.current.startSynchronized({
            measure: 1,
            pass: 1,
            serverStartTimeMs: performance.now() + 1_000,
            serverOffsetMs: 0,
            withCountIn: false,
          });
        }
      });

      expect(powerMocks.acquireWakeLock).toHaveBeenCalledTimes(1);
      expect(powerMocks.keepAwake).toHaveBeenCalledTimes(1);
      const onEnded = powerMocks.schedulers.at(-1)?.onEnded;
      expect(onEnded).toBeTypeOf('function');

      act(() => {
        onEnded?.();
        onEnded?.();
        result.current.stop();
      });

      expect(powerMocks.releaseWakeLock).toHaveBeenCalledTimes(1);
      expect(powerMocks.allowSleep).toHaveBeenCalledTimes(1);

      unmount();
      expect(powerMocks.releaseWakeLock).toHaveBeenCalledTimes(1);
      expect(powerMocks.allowSleep).toHaveBeenCalledTimes(1);
    },
  );

  it('stops the transport and releases power after a native media control stop', async () => {
    const nativeEngine = {
      onStopped: null as (() => void) | null,
      start: vi.fn(async () => undefined),
      now: vi.fn(() => 1),
      outputLatency: vi.fn(() => 0),
      stop: vi.fn(),
      setVolume: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    powerMocks.createAudioEngine.mockReturnValue(nativeEngine);
    const { result } = renderHook(() => useMetronome(map));

    await act(async () => result.current.start(1, 1, false));
    expect(result.current.playing).toBe(true);

    act(() => nativeEngine.onStopped?.());

    expect(result.current.playing).toBe(false);
    expect(powerMocks.releaseWakeLock).toHaveBeenCalledTimes(1);
    expect(powerMocks.allowSleep).toHaveBeenCalledTimes(1);
  });
});
