import { act, renderHook } from '@testing-library/react';
import {
  calibratedVisualTimeMs,
  expandTimeline,
  type PerformanceTimeline,
  type TempoMap,
} from '@feelmyrythm/core';
import type {
  AudioEngine,
  BeatQueue,
  PerformanceTimelineLike,
  SchedulerStartOptions,
  TimelineTransition,
} from '@feelmyrythm/audio';
import type * as FeelMyRythmAudio from '@feelmyrythm/audio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const powerMocks = vi.hoisted(() => ({
  schedulers: [] as Array<{ onEnded: (() => void) | null }>,
  queues: [] as BeatQueue[],
  starts: [] as SchedulerStartOptions[],
  scheduledAudioTime: 2,
  queueTimelineTransition: vi.fn<(timeline: PerformanceTimelineLike) => TimelineTransition>(),
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

vi.mock('@feelmyrythm/audio', async (importOriginal) => {
  const actual = await importOriginal<typeof FeelMyRythmAudio>();
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
      return powerMocks.scheduledAudioTime;
    }
  }

  class MockTimelineTransport {
    readonly scheduler = { onEnded: null as (() => void) | null };
    readonly beatQueue = new actual.BeatQueue();
    private options: SchedulerStartOptions | null = null;
    isPlaying = true;

    constructor(private readonly engine: AudioEngine) {
      powerMocks.schedulers.push(this.scheduler);
      powerMocks.queues.push(this.beatQueue);
    }

    async start(options: SchedulerStartOptions) {
      this.options = options;
      powerMocks.starts.push(options);
      this.isPlaying = true;
    }

    stop() {
      this.isPlaying = false;
    }

    position() {
      return this.options
        ? this.options.anchorTimelineTimeSec + this.engine.now() - this.options.anchorAudioTime
        : 0;
    }

    queueTimelineTransition(timeline: PerformanceTimelineLike) {
      return powerMocks.queueTimelineTransition(timeline);
    }
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
  powerMocks.queues.length = 0;
  powerMocks.starts.length = 0;
  powerMocks.scheduledAudioTime = 2;
  powerMocks.queueTimelineTransition.mockReset();
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

describe('scheduled playback display phase', () => {
  const mixedMap: TempoMap = {
    ...map,
    totalMeasures: 6,
    sections: [
      { ...map.sections[0]!, id: 'four-beats', startMeasure: 1, endMeasure: 4, bpm: 96 },
      {
        ...map.sections[0]!,
        id: 'three-beats',
        startMeasure: 5,
        endMeasure: 6,
        bpm: 132,
        timeSignature: { num: 3, denom: 4 },
      },
    ],
  };

  function controllableEngine() {
    let audioNow = 1;
    const engine = {
      onStopped: null as (() => void) | null,
      start: vi.fn(async () => undefined),
      now: () => audioNow,
      outputLatency: () => 0,
      stop: vi.fn(),
      setVolume: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    powerMocks.createAudioEngine.mockReturnValue(engine);
    return (time: number) => {
      audioNow = time;
      act(() => {
        const sample = vi.mocked(requestAnimationFrame).mock.calls.at(-1)?.[0];
        sample?.(0);
      });
    };
  }

  function queueAnchorBeat() {
    const start = powerMocks.starts.at(-1)!;
    const entryIndex = start.timeline.entries.findIndex(
      (entry) => entry.startTimeSec === start.anchorTimelineTimeSec,
    );
    const entry = start.timeline.entries[entryIndex]!;
    powerMocks.queues.at(-1)!.push({
      id: 'anchor',
      audioTime: start.anchorAudioTime,
      timelineTimeSec: start.anchorTimelineTimeSec,
      kind: 'downbeat',
      accent: 2,
      isSubdivision: false,
      isCountIn: false,
      measureNumber: entry.measureNumber,
      pass: entry.pass,
      sectionId: entry.sectionId,
      entryIndex,
      beatIndex: 0,
    });
  }

  it('shows half-beat progress before the next click enters the lookahead queue', async () => {
    const advanceAudio = controllableEngine();
    const { result } = renderHook(() => useMetronome(map));
    await act(async () => result.current.start(1, 1, false));
    const start = powerMocks.starts.at(-1)!;
    queueAnchorBeat();

    advanceAudio(start.anchorAudioTime + 0.25);

    expect(powerMocks.queues.at(-1)?.size).toBe(1);
    expect(powerMocks.queues.at(-1)?.nextAtOrAfter(start.anchorAudioTime + 0.25)).toBeNull();
    expect(result.current.frameSource()).toMatchObject({ beatIndex: 0, measureNumber: 1 });
    expect(result.current.frameSource().progress).toBeCloseTo(0.5);
  });

  it('uses expanded beat times through tempo ramps, subdivisions, measure boundaries and the final beat', async () => {
    const changingMap: TempoMap = {
      ...map,
      totalMeasures: 2,
      sections: [
        {
          ...map.sections[0]!,
          bpm: 60,
          subdivision: 2,
          tempoChange: { type: 'accel', targetBpm: 120 },
        },
        {
          ...map.sections[0]!,
          id: 'three-beats',
          startMeasure: 2,
          endMeasure: 2,
          timeSignature: { num: 3, denom: 4 },
          bpm: 90,
        },
      ],
    };
    const expanded = expandTimeline(changingMap);
    const advanceAudio = controllableEngine();
    const { result } = renderHook(() => useMetronome(changingMap));
    await act(async () => result.current.start(1, 1, false));
    const start = powerMocks.starts.at(-1)!;
    queueAnchorBeat();

    for (const [entryIndex, entry] of expanded.entries.entries()) {
      for (const [beatIndex, beat] of entry.beats.entries()) {
        const nextTime =
          entry.beats[beatIndex + 1]?.timeSec ??
          expanded.entries[entryIndex + 1]?.startTimeSec ??
          expanded.totalDurationSec;
        advanceAudio(start.anchorAudioTime + (beat.timeSec + nextTime) / 2);
        expect(result.current.frameSource()).toMatchObject({
          beatIndex: beat.beatIndex,
          measureNumber: entry.measureNumber,
          isSubdivision: beat.isSubdivision,
        });
        expect(result.current.frameSource().progress).toBeCloseTo(0.5);
      }
    }
    advanceAudio(start.anchorAudioTime + expanded.totalDurationSec + 0.01);
    expect(result.current.frameSource().progress).toBe(1);
    expect(powerMocks.queues.at(-1)?.size).toBe(1);
  });

  it.each(['local', 'synchronized'] as const)(
    'uses the full %s count-in plan without looked-ahead queue entries',
    async (mode) => {
      const countInMap = { ...mixedMap, countIn: { ...mixedMap.countIn, measures: 2 as const } };
      const advanceAudio = controllableEngine();
      const { result } = renderHook(() => useMetronome(countInMap));
      await act(async () => {
        if (mode === 'local') await result.current.start(5, 1, true);
        else {
          await result.current.startSynchronized({
            measure: 5,
            pass: 1,
            serverStartTimeMs: 2_000,
            serverOffsetMs: 0,
          });
        }
      });
      const start = powerMocks.starts.at(-1)!;
      expect(start.countIn).toHaveLength(6);
      for (const [index, beat] of start.countIn!.entries()) {
        const nextTime = start.countIn![index + 1]?.timeSec ?? 0;
        advanceAudio(start.anchorAudioTime + (beat.timeSec + nextTime) / 2);
        expect(result.current.frameSource()).toMatchObject({
          measureNumber: 5,
          beatCount: 3,
          isCountIn: true,
          countInValue: beat.countdown,
          accent: beat.accent,
        });
        expect(result.current.frameSource().progress).toBeCloseTo(0.5);
      }
      advanceAudio(start.anchorAudioTime + 0.01);
      expect(result.current.frameSource().isCountIn).not.toBe(true);
      expect(result.current.frameSource().beatIndex).toBe(0);
      expect(powerMocks.queues.at(-1)?.size).toBe(0);
    },
  );

  it.each([-100, 100])(
    'applies a %sms visual offset to count-in and normal progress',
    async (offset) => {
      localStorage.setItem('fmr.visualOffsetMs', String(offset));
      const advanceAudio = controllableEngine();
      const { result } = renderHook(() => useMetronome(mixedMap));
      await act(async () => result.current.start(5, 1, true));
      const start = powerMocks.starts.at(-1)!;
      const lastCountIn = start.countIn!.at(-1)!;
      advanceAudio(start.anchorAudioTime + lastCountIn.timeSec / 2 - offset / 1_000);
      expect(result.current.frameSource()).toMatchObject({ isCountIn: true, countInValue: 1 });
      expect(result.current.frameSource().progress).toBeCloseTo(0.5);

      const entry = start.timeline.entries.find((entry) => entry.measureNumber === 5)!;
      const halfBeat = (entry.beats[1]!.timeSec - entry.beats[0]!.timeSec) / 2;
      advanceAudio(start.anchorAudioTime + halfBeat - offset / 1_000);
      expect(result.current.frameSource().isCountIn).not.toBe(true);
      expect(result.current.frameSource().progress).toBeCloseTo(0.5);
    },
  );

  it.each([-100, 100])(
    'keeps the old tempo until the queued transition with a %sms visual offset',
    async (offset) => {
      localStorage.setItem('fmr.visualOffsetMs', String(offset));
      const originalMap: TempoMap = {
        ...map,
        totalMeasures: 2,
        sections: [{ ...map.sections[0]!, endMeasure: 2, bpm: 60 }],
      };
      const editedMap: TempoMap = {
        ...originalMap,
        revision: 2,
        sections: [{ ...originalMap.sections[0]!, bpm: 120 }],
      };
      const advanceAudio = controllableEngine();
      const { result, rerender } = renderHook(({ map }) => useMetronome(map), {
        initialProps: { map: originalMap },
      });
      await act(async () => result.current.start(1, 1, false));
      const start = powerMocks.starts.at(-1)!;
      advanceAudio(start.anchorAudioTime + 3.5 - offset / 1_000);
      powerMocks.queueTimelineTransition.mockReturnValue({
        audioTime: start.anchorAudioTime + 4,
        fromTimelineTimeSec: 4,
        toTimelineTimeSec: 2,
        measureNumber: 2,
        pass: 1,
      });
      rerender({ map: editedMap });
      expect(powerMocks.queueTimelineTransition).toHaveBeenCalledTimes(1);
      expect(result.current.frameSource()).toMatchObject({ measureNumber: 1, beatIndex: 3 });
      expect(result.current.frameSource().progress).toBeCloseTo(0.5);

      advanceAudio(start.anchorAudioTime + 4.05 - offset / 1_000);
      expect(result.current.frameSource()).toMatchObject({ measureNumber: 2, beatIndex: 0 });
      expect(result.current.frameSource().progress).toBeCloseTo(0.1);
      advanceAudio(start.anchorAudioTime + 4.25 - offset / 1_000);
      expect(result.current.frameSource().progress).toBeCloseTo(0.5);
      expect(powerMocks.starts).toHaveLength(1);
    },
  );

  it('keeps the selected 5th measure and 3-beat section during the local scheduling lead time', async () => {
    const advanceAudio = controllableEngine();
    const { result } = renderHook(() => useMetronome(mixedMap));
    await act(async () => result.current.start(5, 1, false));

    expect(result.current.position).toMatchObject({
      measureNumber: 5,
      pass: 1,
      beatCount: 3,
      sectionId: 'three-beats',
      isWaiting: true,
      isCountIn: false,
    });
    expect(result.current.frameSource()).toMatchObject({
      measureNumber: 5,
      beatCount: 3,
      isWaiting: true,
    });
    const start = powerMocks.starts.at(-1)!;
    expect(start.anchorAudioTime).toBeCloseTo(1.12);
    expect(start.anchorTimelineTimeSec).toBe(10);
    expect(start.countIn).toEqual([]);

    advanceAudio(1.1);
    expect(result.current.position.measureNumber).toBe(5);
    expect(result.current.position.isWaiting).toBe(true);
    queueAnchorBeat();
    advanceAudio(start.anchorAudioTime);
    expect(result.current.position).toMatchObject({
      measureNumber: 5,
      beatCount: 3,
      sectionId: 'three-beats',
      isWaiting: false,
    });
    expect(result.current.frameSource().isWaiting).not.toBe(true);
  });

  it('waits for a future synchronized start even when visual calibration looks ahead', async () => {
    localStorage.setItem('fmr.visualOffsetMs', '100');
    const advanceAudio = controllableEngine();
    powerMocks.scheduledAudioTime = 4;
    const { result } = renderHook(() => useMetronome(mixedMap));
    await act(async () =>
      result.current.startSynchronized({
        measure: 5,
        pass: 1,
        serverStartTimeMs: 4_000,
        serverOffsetMs: 0,
        withCountIn: false,
      }),
    );
    queueAnchorBeat();

    advanceAudio(3.95);
    expect(result.current.frameSource()).toMatchObject({
      measureNumber: 5,
      beatCount: 3,
      isWaiting: true,
    });
    expect(result.current.position).toMatchObject({
      measureNumber: 5,
      isWaiting: true,
      isCountIn: false,
    });
    advanceAudio(4);
    expect(result.current.position).toMatchObject({
      measureNumber: 5,
      isWaiting: false,
      isCountIn: false,
    });
    expect(result.current.frameSource().isWaiting).not.toBe(true);
  });

  it('keeps anchor meter, section and repeated pass through waiting, count-in and the first main beat', async () => {
    const advanceAudio = controllableEngine();
    powerMocks.scheduledAudioTime = 4;
    const repeated: TempoMap = {
      ...mixedMap,
      jumps: [{ type: 'repeat', startMeasure: 1, endMeasure: 6, times: 2 }],
    };
    const { result } = renderHook(() => useMetronome(repeated));
    await act(async () =>
      result.current.startSynchronized({
        measure: 5,
        pass: 2,
        serverStartTimeMs: 4_000,
        serverOffsetMs: 0,
      }),
    );
    const start = powerMocks.starts.at(-1)!;
    const firstCountIn = start.countIn![0]!;
    const firstAudioTime = start.anchorAudioTime + firstCountIn.timeSec;
    expect(firstAudioTime).toBeCloseTo(4);
    expect(start.countIn).toHaveLength(3);
    powerMocks.queues.at(-1)!.push({
      id: 'count-in',
      audioTime: firstAudioTime,
      timelineTimeSec: start.anchorTimelineTimeSec + firstCountIn.timeSec,
      kind: 'countIn',
      accent: 2,
      isSubdivision: false,
      isCountIn: true,
      countdown: 3,
    });
    queueAnchorBeat();

    advanceAudio(3.99);
    expect(result.current.position).toMatchObject({
      measureNumber: 5,
      pass: 2,
      beatCount: 3,
      isWaiting: true,
    });
    advanceAudio(firstAudioTime);
    expect(result.current.position).toMatchObject({
      measureNumber: 5,
      pass: 2,
      beatCount: 3,
      sectionId: 'three-beats',
      isWaiting: false,
      isCountIn: true,
      countdown: 3,
    });
    expect(result.current.frameSource()).toMatchObject({
      measureNumber: 5,
      beatCount: 3,
      isCountIn: true,
      countInValue: 3,
    });
    advanceAudio(start.anchorAudioTime);
    expect(result.current.position).toMatchObject({
      measureNumber: 5,
      pass: 2,
      beatCount: 3,
      sectionId: 'three-beats',
      isWaiting: false,
      isCountIn: false,
    });
  });

  it('clears the waiting phase when a scheduled start is cancelled', async () => {
    controllableEngine();
    const { result } = renderHook(() => useMetronome(mixedMap));
    await act(async () => result.current.start(5, 1, false));
    expect(result.current.position.isWaiting).toBe(true);
    act(() => result.current.stop());

    expect(result.current.playing).toBe(false);
    expect(result.current.position.isWaiting).toBe(false);
    expect(result.current.frameSource().isWaiting).toBe(false);
  });
});

describe('audio preparation', () => {
  function createEngine(start = vi.fn<() => Promise<void>>(async () => undefined)) {
    return {
      onStopped: null as (() => void) | null,
      start,
      now: vi.fn(() => 1),
      outputLatency: vi.fn(() => 0),
      stop: vi.fn(),
      setVolume: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
  }

  it('prepares one engine for concurrent clicks without starting playback or wake controls', async () => {
    const engine = createEngine();
    powerMocks.createAudioEngine.mockReturnValue(engine);
    const { result } = renderHook(() => useMetronome(map));
    const initialFrame = result.current.frameSource();

    await act(async () => {
      await Promise.all([result.current.prepareAudio(), result.current.prepareAudio()]);
    });

    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(powerMocks.createAudioEngine).toHaveBeenCalledTimes(1);
    expect(result.current.playing).toBe(false);
    expect(result.current.frameSource()).toEqual(initialFrame);
    expect(powerMocks.schedulers).toHaveLength(0);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(powerMocks.acquireWakeLock).not.toHaveBeenCalled();
    expect(powerMocks.keepAwake).not.toHaveBeenCalled();

    act(() => result.current.stop());
    expect(engine.stop).toHaveBeenCalledTimes(1);
  });

  it.each(['stop', 'unmount', 'external-stop'] as const)(
    'rejects preparation cancelled by %s and stops the engine if it finishes later',
    async (cancel) => {
      let finishStart: (() => void) | undefined;
      const engine = createEngine(
        vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finishStart = resolve;
            }),
        ),
      );
      powerMocks.createAudioEngine.mockReturnValue(engine);
      const { result, unmount } = renderHook(() => useMetronome(map));
      const preparing = result.current.prepareAudio();

      act(() => {
        if (cancel === 'unmount') unmount();
        else if (cancel === 'external-stop') engine.onStopped?.();
        else result.current.stop();
      });
      await act(async () => {
        finishStart?.();
        await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
      });

      expect(engine.stop).toHaveBeenCalledTimes(1);
      expect(powerMocks.schedulers).toHaveLength(0);
      expect(powerMocks.keepAwake).not.toHaveBeenCalled();
      if (cancel === 'unmount') expect(engine.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it('does not let cancelled preparation stop a newer synchronized start', async () => {
    let finishStart: (() => void) | undefined;
    const engine = createEngine(
      vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishStart = resolve;
          }),
      ),
    );
    powerMocks.createAudioEngine.mockReturnValue(engine);
    const { result } = renderHook(() => useMetronome(map));
    const preparing = result.current.prepareAudio();
    act(() => result.current.stop());
    const starting = result.current.startSynchronized({
      measure: 1,
      pass: 1,
      serverStartTimeMs: performance.now() + 1_000,
      serverOffsetMs: 0,
      withCountIn: false,
    });

    await act(async () => {
      finishStart?.();
      await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
      await starting;
    });

    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(engine.stop).not.toHaveBeenCalled();
    expect(result.current.playing).toBe(true);
  });

  it('propagates preparation failures and permits retry on the next click', async () => {
    const engine = createEngine(
      vi.fn(async () => undefined).mockRejectedValueOnce(new Error('blocked')),
    );
    powerMocks.createAudioEngine.mockReturnValue(engine);
    const { result } = renderHook(() => useMetronome(map));

    await expect(result.current.prepareAudio()).rejects.toThrow('blocked');
    expect(engine.stop).toHaveBeenCalledTimes(1);
    await result.current.prepareAudio();
    expect(engine.start).toHaveBeenCalledTimes(2);
    expect(result.current.playing).toBe(false);
    expect(powerMocks.schedulers).toHaveLength(0);
  });

  it('keeps an active transport untouched when preparing again', async () => {
    const engine = createEngine();
    powerMocks.createAudioEngine.mockReturnValue(engine);
    const { result } = renderHook(() => useMetronome(map));
    await act(async () => result.current.start(1, 1, false));
    engine.start.mockClear();

    await result.current.prepareAudio();

    expect(engine.start).not.toHaveBeenCalled();
    expect(engine.stop).not.toHaveBeenCalled();
    expect(powerMocks.schedulers).toHaveLength(1);
    expect(result.current.playing).toBe(true);
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
