import {
  buildCountIn,
  expandTimeline,
  seekPoint,
  type PerformanceTimeline,
  type TempoMap,
} from '@feelmyrythm/core';
import {
  countInDurationSec,
  MetronomeScheduler,
  WebAudioEngine,
  type ScheduledBeat,
} from '@feelmyrythm/audio';
import { useCallback, useEffect, useRef, useState } from 'react';

// 엔진·스케줄러는 앱 전역 싱글턴 (AudioContext는 페이지당 1개가 바람직)
let engineSingleton: WebAudioEngine | null = null;
let schedulerSingleton: MetronomeScheduler | null = null;

export function getEngine(): WebAudioEngine {
  if (!engineSingleton) engineSingleton = new WebAudioEngine();
  return engineSingleton;
}

export function getScheduler(): MetronomeScheduler {
  if (!schedulerSingleton) schedulerSingleton = new MetronomeScheduler(getEngine());
  return schedulerSingleton;
}

export interface StartMetronomeOptions {
  startMeasure?: number;
  pass?: number;
  countIn?: boolean;
  /** 동기 세션: 예비박 첫 박(예비박 없으면 앵커)이 울릴 오디오 시각 강제 지정 */
  firstBeatAudioTime?: number;
  /** 끝나면 처음부터 다시 (빠른 메트로놈 모드) */
  loop?: boolean;
}

export interface MetronomeHandle {
  isRunning: boolean;
  timeline: PerformanceTimeline | null;
  /** 시각화용: 스케줄된 박 피드 (오디오 시각 포함) */
  queueRef: React.RefObject<ScheduledBeat[]>;
  start: (map: TempoMap, opts?: StartMetronomeOptions) => Promise<void>;
  stop: () => void;
}

export function useMetronome(): MetronomeHandle {
  const [isRunning, setIsRunning] = useState(false);
  const [timeline, setTimeline] = useState<PerformanceTimeline | null>(null);
  const queueRef = useRef<ScheduledBeat[]>([]);
  const lastArgsRef = useRef<{ map: TempoMap; opts?: StartMetronomeOptions } | null>(null);

  const stop = useCallback(() => {
    getScheduler().stop();
    lastArgsRef.current = null;
    setIsRunning(false);
  }, []);

  const start = useCallback(async (map: TempoMap, opts?: StartMetronomeOptions) => {
    const engine = getEngine();
    await engine.start(); // 사용자 제스처 안에서 호출되어야 함

    const scheduler = getScheduler();
    const tl = expandTimeline(map);
    const startMeasure = opts?.startMeasure ?? tl.entries[0]!.measureNumber;
    const anchorSec = seekPoint(tl, startMeasure, opts?.pass ?? 1);
    const useCountIn = opts?.countIn !== false;
    const countIn = useCountIn ? buildCountIn(map, startMeasure) : [];

    let anchorAudioTime: number;
    if (opts?.firstBeatAudioTime !== undefined) {
      anchorAudioTime = opts.firstBeatAudioTime + countInDurationSec(countIn);
    } else {
      anchorAudioTime = engine.now() + countInDurationSec(countIn) + 0.2;
    }

    queueRef.current = [];
    scheduler.onBeat = (b) => {
      queueRef.current.push(b);
    };
    scheduler.onEnded = () => {
      const again = lastArgsRef.current;
      if (again?.opts?.loop) {
        void start(again.map, again.opts);
      } else {
        setIsRunning(false);
      }
    };

    scheduler.start({ timeline: tl, anchorSec, anchorAudioTime, countIn });
    lastArgsRef.current = { map, opts };
    setTimeline(tl);
    setIsRunning(true);
  }, []);

  // 페이지 이탈 시 정지
  useEffect(() => {
    return () => {
      getScheduler().stop();
    };
  }, []);

  return { isRunning, timeline, queueRef, start, stop };
}
