import {
  AudioPerformanceMapper,
  BrowserWakeLockAdapter,
  OffsetServerPerformanceMapper,
  ServerAudioMapper,
  TimelineTransport,
  type AudioEngine,
  type ScheduledBeat,
} from '@feelmyrythm/audio';
import {
  buildCountIn,
  expandTimeline,
  locate,
  seekPoint,
  type PerformanceTimeline,
  type TempoMap,
} from '@feelmyrythm/core';
import { nativeBridge } from '@feelmyrythm/mobile';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BeatFrame } from '@feelmyrythm/ui';
import { createPlatformAudioEngine, type ManagedAudioEngine } from './audioEngine';

export interface MetronomePosition {
  measureNumber: number;
  pass: number;
  beatIndex: number;
  beatCount: number;
  sectionId: string;
  isCountIn: boolean;
  isWaiting?: boolean;
  countdown?: number;
}

export interface MetronomeController {
  playing: boolean;
  position: MetronomePosition;
  frameSource: () => BeatFrame;
  prepareAudio: () => Promise<void>;
  start: (measure?: number, pass?: number, withCountIn?: boolean) => Promise<void>;
  startSynchronized: (options: {
    measure: number;
    pass: number;
    serverStartTimeMs: number;
    serverOffsetMs: number;
    withCountIn?: boolean;
  }) => Promise<void>;
  stop: () => void;
  setVolume: (volume: number) => void;
}

export const VISUAL_OFFSET_STORAGE_KEY = 'fmr.visualOffsetMs';
export const VISUAL_OFFSET_MIN_MS = -100;
export const VISUAL_OFFSET_MAX_MS = 100;

export function parseVisualOffsetMs(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= VISUAL_OFFSET_MIN_MS && value <= VISUAL_OFFSET_MAX_MS
    ? value
    : null;
}

export function readVisualOffsetMs(storage: Pick<Storage, 'getItem'> = localStorage): number {
  return parseVisualOffsetMs(storage.getItem(VISUAL_OFFSET_STORAGE_KEY)) ?? 0;
}

/**
 * Positive visual calibration renders an event early. At render time we
 * therefore look the same distance ahead on the audio timeline.
 */
export function visualFrameAudioTimeSec(audioTimeSec: number, visualOffsetMs: number): number {
  if (!Number.isFinite(audioTimeSec)) throw new RangeError('audioTimeSec must be finite');
  if (!Number.isFinite(visualOffsetMs)) throw new RangeError('visualOffsetMs must be finite');
  return audioTimeSec + visualOffsetMs / 1_000;
}

const idlePosition: MetronomePosition = {
  measureNumber: 1,
  pass: 1,
  beatIndex: 0,
  beatCount: 4,
  sectionId: '',
  isCountIn: false,
  isWaiting: false,
};

interface DisplayAnchor {
  position: MetronomePosition;
  firstAudioTime: number;
  countIn: {
    audioTime: number;
    accent: 0 | 1 | 2;
    countdown: number;
  }[];
  timelines: {
    timeline: PerformanceTimeline;
    anchorTimelineTimeSec: number;
    anchorAudioTime: number;
  }[];
}

function primaryBeatCount(timeline: PerformanceTimeline, entryIndex: number): number {
  const entry = timeline.entries[entryIndex];
  if (!entry) return 4;
  return Math.max(1, ...entry.beats.map((beat) => beat.beatIndex + 1));
}

function beatProgress(time: number, start: number, end: number): number {
  return end > start ? Math.min(1, Math.max(0, (time - start) / (end - start))) : 0;
}

function frameFor(
  engine: AudioEngine | null,
  transport: TimelineTransport | null,
  timeline: PerformanceTimeline,
  fallback: MetronomePosition,
  visualOffsetMs: number,
  anchor: DisplayAnchor | null,
): BeatFrame {
  if (!engine || !transport?.isPlaying) {
    return {
      beatIndex: fallback.beatIndex,
      beatCount: fallback.beatCount,
      progress: 0,
      accent: fallback.beatIndex === 0 ? 2 : 1,
      measureNumber: fallback.measureNumber,
      isWaiting: fallback.isWaiting ?? false,
    };
  }
  const audioNow = engine.now();
  const visualAudioTime = visualFrameAudioTimeSec(audioNow, visualOffsetMs);
  if (anchor && Math.min(audioNow, visualAudioTime) < anchor.firstAudioTime) {
    return {
      beatIndex: anchor.position.beatIndex,
      beatCount: anchor.position.beatCount,
      progress: 0,
      accent: 0,
      measureNumber: anchor.position.measureNumber,
      isWaiting: true,
    };
  }
  const mainAudioTime = anchor?.timelines[0]?.anchorAudioTime;
  if (anchor && mainAudioTime !== undefined && visualAudioTime < mainAudioTime) {
    const index = anchor.countIn.findLastIndex((beat) => beat.audioTime <= visualAudioTime);
    const current = anchor.countIn[index];
    if (current) {
      return {
        beatIndex: 0,
        beatCount: anchor.position.beatCount,
        progress: beatProgress(
          visualAudioTime,
          current.audioTime,
          anchor.countIn[index + 1]?.audioTime ?? mainAudioTime,
        ),
        accent: current.accent,
        isCountIn: true,
        countInValue: current.countdown,
        measureNumber: anchor.position.measureNumber,
      };
    }
  }
  const binding =
    anchor?.timelines.findLast((candidate) => candidate.anchorAudioTime <= visualAudioTime) ??
    anchor?.timelines[0];
  const activeTimeline = binding?.timeline ?? timeline;
  const timelinePosition = binding
    ? binding.anchorTimelineTimeSec + visualAudioTime - binding.anchorAudioTime
    : (transport.position() ?? 0) + (visualAudioTime - audioNow);
  const located = locate(activeTimeline, timelinePosition);
  const entry = activeTimeline.entries[located.entryIndex]!;
  const beat = entry.beats[located.beatIndex]!;
  const nextBeatTime =
    entry.beats[located.beatIndex + 1]?.timeSec ??
    activeTimeline.entries[located.entryIndex + 1]?.beats[0]?.timeSec ??
    activeTimeline.totalDurationSec;
  return {
    beatIndex: beat.beatIndex,
    beatCount: primaryBeatCount(activeTimeline, located.entryIndex),
    progress: beatProgress(timelinePosition, beat.timeSec, nextBeatTime),
    accent: beat.accent,
    isSubdivision: beat.isSubdivision,
    measureNumber: entry.measureNumber,
  };
}

function positionFromFrame(
  frame: BeatFrame,
  timeline: PerformanceTimeline,
  scheduled: ScheduledBeat | null,
  fallback: MetronomePosition,
): MetronomePosition {
  const entry = scheduled?.entryIndex === undefined ? null : timeline.entries[scheduled.entryIndex];
  return {
    measureNumber: frame.measureNumber ?? entry?.measureNumber ?? 1,
    pass: scheduled?.pass ?? entry?.pass ?? fallback.pass,
    beatIndex: frame.beatIndex,
    beatCount: frame.beatCount,
    sectionId: scheduled?.sectionId ?? entry?.sectionId ?? fallback.sectionId,
    isCountIn: frame.isCountIn ?? false,
    isWaiting: frame.isWaiting ?? false,
    ...(frame.countInValue === undefined ? {} : { countdown: frame.countInValue }),
  };
}

export function lateJoinEntry(
  timeline: PerformanceTimeline,
  currentTimelineTimeSec: number,
  includeCurrentBoundary: boolean,
) {
  const epsilon = 1e-9;
  return timeline.entries.find((entry) =>
    includeCurrentBoundary
      ? entry.startTimeSec >= currentTimelineTimeSec - epsilon
      : entry.startTimeSec > currentTimelineTimeSec + epsilon,
  );
}

export function useMetronome(map: TempoMap): MetronomeController {
  const timeline = useMemo(() => expandTimeline(map), [map]);
  const timelineRef = useRef(timeline);
  const engineRef = useRef<ManagedAudioEngine | null>(null);
  const engineStartRef = useRef<{ engine: ManagedAudioEngine; promise: Promise<void> } | null>(
    null,
  );
  const transportRef = useRef<TimelineTransport | null>(null);
  const displayAnchorRef = useRef<DisplayAnchor | null>(null);
  const wakeLockRef = useRef<BrowserWakeLockAdapter | null>(null);
  const playbackPowerActiveRef = useRef(false);
  const audioRequestedRef = useRef(false);
  const audioClockRef = useRef(new AudioPerformanceMapper());
  const startRequestRef = useRef(0);
  const visualOffsetMsRef = useRef(readVisualOffsetMs());
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState<MetronomePosition>(() => ({
    ...idlePosition,
    sectionId: map.sections[0]?.id ?? '',
    beatCount: map.sections[0]?.timeSignature.num ?? 4,
  }));
  const positionRef = useRef(position);
  const lastHapticRef = useRef('');

  const setDisplayAnchor = useCallback(
    (
      timeline: PerformanceTimeline,
      anchorTime: number,
      anchorAudioTime: number,
      countIn: readonly { timeSec: number; accent: 0 | 1 | 2; countdown: number }[],
    ) => {
      const located = locate(timeline, anchorTime);
      const entry = timeline.entries[located.entryIndex]!;
      const position: MetronomePosition = {
        measureNumber: entry.measureNumber,
        pass: entry.pass,
        beatIndex: entry.beats[located.beatIndex]!.beatIndex,
        beatCount: primaryBeatCount(timeline, located.entryIndex),
        sectionId: entry.sectionId,
        isCountIn: false,
        isWaiting: true,
      };
      displayAnchorRef.current = {
        position,
        firstAudioTime: anchorAudioTime + (countIn[0]?.timeSec ?? 0),
        countIn: countIn.map((beat) => ({
          audioTime: anchorAudioTime + beat.timeSec,
          accent: beat.accent,
          countdown: beat.countdown,
        })),
        timelines: [{ timeline, anchorTimelineTimeSec: anchorTime, anchorAudioTime }],
      };
      positionRef.current = position;
      setPosition(position);
    },
    [],
  );

  const clearDisplayPhase = useCallback(() => {
    displayAnchorRef.current = null;
    setPosition((current) => {
      const next = { ...current, isWaiting: false, isCountIn: false };
      positionRef.current = next;
      return next;
    });
  }, []);

  const releasePlaybackPower = useCallback(() => {
    if (!playbackPowerActiveRef.current) return;
    playbackPowerActiveRef.current = false;
    void wakeLockRef.current?.release().catch(() => undefined);
    void nativeBridge.allowSleep();
  }, []);

  const keepPlaybackAwake = useCallback(() => {
    if (playbackPowerActiveRef.current) return;
    playbackPowerActiveRef.current = true;
    const wakeLock = wakeLockRef.current ?? new BrowserWakeLockAdapter();
    wakeLockRef.current = wakeLock;
    void wakeLock.acquire().catch(() => undefined);
    void nativeBridge.keepAwake();
  }, []);

  const bindExternalStop = useCallback(
    (engine: ManagedAudioEngine) => {
      if (!('onStopped' in engine)) return;
      engine.onStopped = () => {
        if (engineRef.current !== engine) return;
        startRequestRef.current += 1;
        audioRequestedRef.current = false;
        transportRef.current?.stop();
        clearDisplayPhase();
        setPlaying(false);
        releasePlaybackPower();
      };
    },
    [clearDisplayPhase, releasePlaybackPower],
  );

  const getAudioEngine = useCallback(() => {
    const engine =
      engineRef.current ??
      createPlatformAudioEngine(Number(localStorage.getItem('fmr.volume') ?? 0.75));
    engineRef.current = engine;
    bindExternalStop(engine);
    return engine;
  }, [bindExternalStop]);

  const startAudioEngine = useCallback((engine: ManagedAudioEngine): Promise<void> => {
    if (engineStartRef.current?.engine === engine) return engineStartRef.current.promise;
    const promise = engine.start().finally(() => {
      if (engineStartRef.current?.promise === promise) engineStartRef.current = null;
    });
    engineStartRef.current = { engine, promise };
    return promise;
  }, []);

  const prepareAudio = useCallback(async () => {
    if (transportRef.current?.isPlaying) return;
    const request = startRequestRef.current;
    const engine = getAudioEngine();
    audioRequestedRef.current = true;
    try {
      await startAudioEngine(engine);
    } catch (error) {
      if (request === startRequestRef.current && engineRef.current === engine) {
        audioRequestedRef.current = false;
        engine.stop();
      }
      throw error;
    }
    if (request !== startRequestRef.current || engineRef.current !== engine) {
      if (engineRef.current !== engine || !audioRequestedRef.current) engine.stop();
      throw new DOMException('오디오 준비가 취소되었습니다.', 'AbortError');
    }
  }, [getAudioEngine, startAudioEngine]);

  useEffect(() => {
    const previous = timelineRef.current;
    timelineRef.current = timeline;
    if (transportRef.current?.isPlaying && previous !== timeline) {
      try {
        const transition = transportRef.current.queueTimelineTransition(timeline);
        const anchor = displayAnchorRef.current;
        if (anchor) {
          anchor.timelines = [
            ...anchor.timelines.filter((binding) => binding.anchorAudioTime < transition.audioTime),
            {
              timeline,
              anchorTimelineTimeSec: transition.toTimelineTimeSec,
              anchorAudioTime: transition.audioTime,
            },
          ];
        }
      } catch {
        // The transport may already be at its final measure; a fresh start will use the new map.
      }
    }
  }, [timeline]);

  const frameSource = useCallback(
    () =>
      frameFor(
        engineRef.current,
        transportRef.current,
        timelineRef.current,
        positionRef.current,
        visualOffsetMsRef.current,
        displayAnchorRef.current,
      ),
    [],
  );

  useEffect(() => {
    if (!playing) return;
    let animationFrame = 0;
    const sample = () => {
      const engine = engineRef.current;
      const transport = transportRef.current;
      if (engine) audioClockRef.current.sampleNow(engine, performance.now());
      const frame = frameFor(
        engine,
        transport,
        timelineRef.current,
        positionRef.current,
        0,
        displayAnchorRef.current,
      );
      const audioNow = engine?.now() ?? 0;
      const audibleScheduled =
        engine && transport ? transport.beatQueue.currentAt(audioNow, 4) : null;
      const nextPosition = positionFromFrame(
        frame,
        timelineRef.current,
        audibleScheduled,
        positionRef.current,
      );
      setPosition((current) => {
        if (
          current.measureNumber === nextPosition.measureNumber &&
          current.pass === nextPosition.pass &&
          current.beatIndex === nextPosition.beatIndex &&
          current.beatCount === nextPosition.beatCount &&
          current.sectionId === nextPosition.sectionId &&
          current.isCountIn === nextPosition.isCountIn &&
          current.isWaiting === nextPosition.isWaiting &&
          current.countdown === nextPosition.countdown
        ) {
          return current;
        }
        positionRef.current = nextPosition;
        return nextPosition;
      });
      if (
        audibleScheduled &&
        audibleScheduled.id !== lastHapticRef.current &&
        audibleScheduled.audioTime <= audioNow
      ) {
        lastHapticRef.current = audibleScheduled.id;
        // Haptics intentionally remain on the unadjusted audible clock.
        void nativeBridge.beatHaptic(audibleScheduled.accent);
      }
      if (transport && !transport.isPlaying) setPlaying(false);
      else animationFrame = requestAnimationFrame(sample);
    };
    animationFrame = requestAnimationFrame(sample);
    return () => cancelAnimationFrame(animationFrame);
  }, [playing]);

  useEffect(
    () => () => {
      startRequestRef.current += 1;
      audioRequestedRef.current = false;
      transportRef.current?.stop();
      releasePlaybackPower();
      void wakeLockRef.current?.dispose();
      const engine = engineRef.current;
      engineRef.current = null;
      if (engine && 'onStopped' in engine) engine.onStopped = null;
      void engine?.dispose();
    },
    [releasePlaybackPower],
  );

  const start = useCallback(
    async (measure = 1, pass = 1, withCountIn = true) => {
      const request = ++startRequestRef.current;
      audioRequestedRef.current = true;
      visualOffsetMsRef.current = readVisualOffsetMs();
      transportRef.current?.stop();
      const engine = getAudioEngine();
      let transport: TimelineTransport | null = null;
      try {
        await startAudioEngine(engine);
        if (request !== startRequestRef.current) {
          if (engineRef.current !== engine || !audioRequestedRef.current) engine.stop();
          return;
        }
        audioClockRef.current.clear();
        audioClockRef.current.sampleNow(engine, performance.now());
        transport = new TimelineTransport(engine);
        transportRef.current = transport;
        const anchorTimelineTimeSec = seekPoint(timelineRef.current, measure, pass);
        const storedCountIn = localStorage.getItem('fmr.countInMeasures');
        const preferredCountInMeasures: 1 | 2 =
          storedCountIn === '1' || storedCountIn === '2'
            ? (Number(storedCountIn) as 1 | 2)
            : map.countIn.measures;
        const localPlaybackMap = {
          ...map,
          countIn: { ...map.countIn, measures: preferredCountInMeasures },
        };
        const rawCountIn = withCountIn ? buildCountIn(localPlaybackMap, anchorTimelineTimeSec) : [];
        const countInBeatCount = Math.max(1, ...rawCountIn.map((beat) => beat.beatIndex + 1));
        const countIn = rawCountIn.map((beat) => ({
          timeSec: beat.timeSec - anchorTimelineTimeSec,
          accent: beat.accent,
          countdown: countInBeatCount - beat.beatIndex,
        }));
        const firstRelative = countIn[0]?.timeSec ?? 0;
        const anchorAudioTime = engine.now() + 0.12 - Math.min(0, firstRelative);
        setDisplayAnchor(timelineRef.current, anchorTimelineTimeSec, anchorAudioTime, countIn);
        await transport.start({
          timeline: timelineRef.current,
          anchorTimelineTimeSec,
          anchorAudioTime,
          countIn,
        });
        if (request !== startRequestRef.current) {
          transport.stop();
          if (engineRef.current !== engine || !audioRequestedRef.current) engine.stop();
          return;
        }
        transport.scheduler.onEnded = () => {
          audioRequestedRef.current = false;
          clearDisplayPhase();
          setPlaying(false);
          releasePlaybackPower();
        };
        keepPlaybackAwake();
        setPlaying(true);
      } catch (error) {
        if (request === startRequestRef.current) {
          audioRequestedRef.current = false;
          transport?.stop();
          engine.stop();
          clearDisplayPhase();
          setPlaying(false);
          releasePlaybackPower();
        }
        throw error;
      }
    },
    [
      clearDisplayPhase,
      getAudioEngine,
      keepPlaybackAwake,
      map,
      releasePlaybackPower,
      setDisplayAnchor,
      startAudioEngine,
    ],
  );

  const startSynchronized = useCallback(
    async ({
      measure,
      pass,
      serverStartTimeMs,
      serverOffsetMs,
      withCountIn = true,
    }: {
      measure: number;
      pass: number;
      serverStartTimeMs: number;
      serverOffsetMs: number;
      withCountIn?: boolean;
    }) => {
      const request = ++startRequestRef.current;
      audioRequestedRef.current = true;
      visualOffsetMsRef.current = readVisualOffsetMs();
      transportRef.current?.stop();
      const engine = getAudioEngine();
      let transport: TimelineTransport | null = null;
      try {
        await startAudioEngine(engine);
        if (request !== startRequestRef.current) {
          if (engineRef.current !== engine || !audioRequestedRef.current) engine.stop();
          return;
        }
        audioClockRef.current.clear();
        audioClockRef.current.sampleNow(engine, performance.now());
        transport = new TimelineTransport(engine);
        transportRef.current = transport;
        const timeline = timelineRef.current;
        let anchorTimelineTimeSec = seekPoint(timeline, measure, pass);
        const rawCountIn = withCountIn ? buildCountIn(map, anchorTimelineTimeSec) : [];
        let countIn = rawCountIn.map((beat, index) => ({
          timeSec: beat.timeSec - anchorTimelineTimeSec,
          accent: beat.accent,
          countdown:
            Math.max(...rawCountIn.map((candidate) => candidate.beatIndex)) + 1 - beat.beatIndex,
          index,
        }));
        const firstRelative = countIn[0]?.timeSec ?? 0;
        const mapper = new ServerAudioMapper(
          new OffsetServerPerformanceMapper(serverOffsetMs),
          audioClockRef.current,
          () => engine.outputLatency(),
        );
        const manualOffsetSec =
          Number(localStorage.getItem('fmr.calibrationOffsetMs') ?? 0) / 1_000;
        let anchorAudioTime =
          mapper.serverToScheduledAudio(serverStartTimeMs, manualOffsetSec) - firstRelative;

        if (anchorAudioTime + firstRelative < engine.now() - 0.02) {
          const mainServerTime = serverStartTimeMs - firstRelative * 1000;
          const serverNow = performance.now() + serverOffsetMs;
          const anchorStillSchedulable = anchorAudioTime >= engine.now() - 0.02;
          const currentTimelineTime = anchorStillSchedulable
            ? anchorTimelineTimeSec
            : anchorTimelineTimeSec + Math.max(0, serverNow - mainServerTime) / 1000;
          const nextEntry = lateJoinEntry(timeline, currentTimelineTime, anchorStillSchedulable);
          if (!nextEntry) throw new Error('동기 타임라인의 다음 마디 경계가 없습니다.');
          anchorTimelineTimeSec = nextEntry.startTimeSec;
          const nextBoundaryServerTime =
            mainServerTime + (nextEntry.startTimeSec - seekPoint(timeline, measure, pass)) * 1000;
          anchorAudioTime = mapper.serverToScheduledAudio(nextBoundaryServerTime, manualOffsetSec);
          countIn = [];
        }

        setDisplayAnchor(timeline, anchorTimelineTimeSec, anchorAudioTime, countIn);
        await transport.start({
          timeline,
          anchorTimelineTimeSec,
          anchorAudioTime,
          countIn,
        });
        if (request !== startRequestRef.current) {
          transport.stop();
          if (engineRef.current !== engine || !audioRequestedRef.current) engine.stop();
          return;
        }
        transport.scheduler.onEnded = () => {
          audioRequestedRef.current = false;
          clearDisplayPhase();
          setPlaying(false);
          releasePlaybackPower();
        };
        keepPlaybackAwake();
        setPlaying(true);
      } catch (error) {
        if (request === startRequestRef.current) {
          audioRequestedRef.current = false;
          transport?.stop();
          engine.stop();
          clearDisplayPhase();
          setPlaying(false);
          releasePlaybackPower();
        }
        throw error;
      }
    },
    [
      clearDisplayPhase,
      getAudioEngine,
      keepPlaybackAwake,
      map,
      releasePlaybackPower,
      setDisplayAnchor,
      startAudioEngine,
    ],
  );

  const stop = useCallback(() => {
    startRequestRef.current += 1;
    audioRequestedRef.current = false;
    if (transportRef.current) transportRef.current.stop();
    else if (!engineStartRef.current) engineRef.current?.stop();
    clearDisplayPhase();
    setPlaying(false);
    releasePlaybackPower();
  }, [clearDisplayPhase, releasePlaybackPower]);

  const setVolume = useCallback((volume: number) => {
    localStorage.setItem('fmr.volume', String(volume));
    engineRef.current?.setVolume(volume);
  }, []);

  return {
    playing,
    position,
    frameSource,
    prepareAudio,
    start,
    startSynchronized,
    stop,
    setVolume,
  };
}
