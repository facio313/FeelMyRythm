import {
  canCancelScheduledAudio,
  type AudioEngine,
  type CancellableAudioEngine,
  type ClickKind,
} from './engine.js';
import { AudioEnvironmentError, assertFiniteNumber } from './errors.js';

export const SCHEDULER_TICK_MS = 25;
export const LOOKAHEAD_SEC = 0.12;

export interface TimelineBeatLike {
  readonly timeSec: number;
  readonly accent: 0 | 1 | 2;
  readonly isSubdivision: boolean;
}

export interface TimelineMeasureLike {
  readonly measureNumber: number;
  readonly pass: number;
  readonly sectionId: string;
  readonly startTimeSec: number;
  readonly beats: readonly TimelineBeatLike[];
}

/** Structurally compatible with packages/core PerformanceTimeline. */
export interface PerformanceTimelineLike {
  readonly tempoMapRevision: number;
  readonly entries: readonly TimelineMeasureLike[];
  readonly totalDurationSec: number;
}

/** `timeSec` is relative to the main anchor and is normally negative. */
export interface CountInBeatLike {
  readonly timeSec: number;
  readonly countdown?: number;
  readonly accent?: 0 | 1 | 2;
}

export interface ScheduledBeat {
  readonly id: string;
  readonly audioTime: number;
  readonly timelineTimeSec: number;
  readonly kind: ClickKind;
  readonly accent: 0 | 1 | 2;
  readonly isSubdivision: boolean;
  readonly isCountIn: boolean;
  readonly countdown?: number;
  readonly measureNumber?: number;
  readonly pass?: number;
  readonly sectionId?: string;
  readonly entryIndex?: number;
  readonly beatIndex?: number;
}

export class BeatQueue {
  private readonly beats: ScheduledBeat[] = [];

  get size(): number {
    return this.beats.length;
  }

  push(beat: ScheduledBeat): void {
    const index = this.beats.findIndex((candidate) => candidate.audioTime > beat.audioTime);
    if (index < 0) this.beats.push(beat);
    else this.beats.splice(index, 0, beat);
  }

  snapshot(): readonly ScheduledBeat[] {
    return this.beats.slice();
  }

  between(fromAudioTime: number, toAudioTime: number): readonly ScheduledBeat[] {
    assertFiniteNumber(fromAudioTime, 'fromAudioTime');
    assertFiniteNumber(toAudioTime, 'toAudioTime');
    return this.beats.filter(
      (beat) => beat.audioTime >= fromAudioTime && beat.audioTime < toAudioTime,
    );
  }

  currentAt(audioTime: number, maxAgeSec = 0.2): ScheduledBeat | null {
    assertFiniteNumber(audioTime, 'audioTime');
    assertFiniteNumber(maxAgeSec, 'maxAgeSec');
    for (let index = this.beats.length - 1; index >= 0; index -= 1) {
      const beat = this.beats[index]!;
      if (beat.audioTime <= audioTime) {
        return audioTime - beat.audioTime <= maxAgeSec ? beat : null;
      }
    }
    return null;
  }

  nextAtOrAfter(audioTime: number): ScheduledBeat | null {
    assertFiniteNumber(audioTime, 'audioTime');
    return this.beats.find((beat) => beat.audioTime >= audioTime) ?? null;
  }

  pruneBefore(audioTime: number): void {
    assertFiniteNumber(audioTime, 'audioTime');
    const firstRetained = this.beats.findIndex((beat) => beat.audioTime >= audioTime);
    if (firstRetained < 0) this.beats.length = 0;
    else if (firstRetained > 0) this.beats.splice(0, firstRetained);
  }

  removeFrom(audioTime: number): void {
    assertFiniteNumber(audioTime, 'audioTime');
    const firstRemoved = this.beats.findIndex((beat) => beat.audioTime >= audioTime);
    if (firstRemoved >= 0) this.beats.splice(firstRemoved);
  }

  clear(): void {
    this.beats.length = 0;
  }
}

export interface SchedulerTimer {
  readonly running: boolean;
  start(listener: () => void): void;
  stop(): void;
}

/** A main-thread controller whose cadence is generated inside a Web Worker. */
export class WorkerSchedulerTimer implements SchedulerTimer {
  private worker: Worker | null = null;

  get running(): boolean {
    return this.worker !== null;
  }

  start(listener: () => void): void {
    this.stop();
    if (
      typeof Worker === 'undefined' ||
      typeof Blob === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      throw new AudioEnvironmentError(
        'worker-unsupported',
        'This browser cannot run the metronome Worker scheduler.',
      );
    }

    const script = `let timer=null;onmessage=(event)=>{if(event.data==='start'){if(timer===null)timer=setInterval(()=>postMessage('tick'),${SCHEDULER_TICK_MS});}else if(event.data==='stop'){if(timer!==null)clearInterval(timer);timer=null;}};`;
    const url = URL.createObjectURL(new Blob([script], { type: 'application/javascript' }));
    try {
      this.worker = new Worker(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    this.worker.onmessage = () => listener();
    this.worker.postMessage('start');
  }

  stop(): void {
    if (this.worker === null) return;
    this.worker.postMessage('stop');
    this.worker.terminate();
    this.worker = null;
  }
}

export interface SchedulerStartOptions {
  readonly timeline: PerformanceTimelineLike;
  /** Timeline time represented by `anchorAudioTime`. */
  readonly anchorTimelineTimeSec: number;
  readonly anchorAudioTime: number;
  readonly countIn?: readonly CountInBeatLike[];
}

export interface LookaheadSchedulerOptions {
  readonly timer?: SchedulerTimer;
  readonly beatQueue?: BeatQueue;
  readonly lookaheadSec?: number;
  readonly lateToleranceSec?: number;
  readonly endTailSec?: number;
}

interface PendingBeat {
  readonly scheduled: ScheduledBeat;
}

export class LookaheadScheduler {
  readonly beatQueue: BeatQueue;
  onScheduledBeat: ((beat: ScheduledBeat) => void) | null = null;
  onEnded: (() => void) | null = null;

  private readonly timer: SchedulerTimer;
  private readonly lookaheadSec: number;
  private readonly lateToleranceSec: number;
  private readonly endTailSec: number;
  private pending: PendingBeat[] = [];
  private endAudioTime: number | null = null;
  private running = false;

  constructor(
    private readonly engine: AudioEngine,
    options: LookaheadSchedulerOptions = {},
  ) {
    this.timer = options.timer ?? new WorkerSchedulerTimer();
    this.beatQueue = options.beatQueue ?? new BeatQueue();
    this.lookaheadSec = positive(options.lookaheadSec ?? LOOKAHEAD_SEC, 'lookaheadSec');
    this.lateToleranceSec = nonNegative(options.lateToleranceSec ?? 0.02, 'lateToleranceSec');
    this.endTailSec = nonNegative(options.endTailSec ?? 0.1, 'endTailSec');
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(options: SchedulerStartOptions): void {
    this.stop();
    validateStartOptions(options);
    this.pending = flattenSchedule(options);
    this.endAudioTime = maximumAudioTime(this.pending);
    this.running = true;
    try {
      this.timer.start(() => this.tick());
    } catch (error) {
      this.running = false;
      this.pending = [];
      this.endAudioTime = null;
      throw error;
    }
    this.tick();
  }

  tick(): void {
    if (!this.running) return;
    const now = this.engine.now();
    const horizon = now + this.lookaheadSec;
    let consumed = 0;
    for (const pending of this.pending) {
      const beat = pending.scheduled;
      if (beat.audioTime > horizon + Number.EPSILON) break;
      consumed += 1;
      if (beat.audioTime < now - this.lateToleranceSec) continue;
      this.engine.scheduleClick(beat.audioTime, beat.kind);
      this.beatQueue.push(beat);
      this.onScheduledBeat?.(beat);
    }
    if (consumed > 0) this.pending = this.pending.slice(consumed);

    if (
      this.pending.length === 0 &&
      (this.endAudioTime === null || now >= this.endAudioTime + this.endTailSec)
    ) {
      this.finish();
    }
  }

  replaceTimelineFrom(transitionAudioTime: number, replacement: SchedulerStartOptions): void {
    if (!this.running) {
      throw new AudioEnvironmentError(
        'timeline-transition-unavailable',
        'A timeline transition requires an active scheduler.',
      );
    }
    assertFiniteNumber(transitionAudioTime, 'transitionAudioTime');
    if (transitionAudioTime < this.engine.now() - this.lateToleranceSec) {
      throw new AudioEnvironmentError(
        'timeline-transition-unavailable',
        'The requested timeline transition boundary has already passed.',
      );
    }
    validateStartOptions(replacement);

    const scheduledAcrossBoundary = this.beatQueue
      .snapshot()
      .some((beat) => beat.audioTime >= transitionAudioTime);
    if (scheduledAcrossBoundary && !canCancelScheduledAudio(this.engine)) {
      throw new AudioEnvironmentError(
        'timeline-transition-unavailable',
        'The audio adapter cannot cancel looked-ahead clicks at the transition boundary.',
      );
    }
    if (canCancelScheduledAudio(this.engine)) {
      (this.engine as CancellableAudioEngine).cancelScheduledFrom(transitionAudioTime);
    }
    this.beatQueue.removeFrom(transitionAudioTime);

    const retained = this.pending.filter(
      ({ scheduled }) => scheduled.audioTime < transitionAudioTime,
    );
    const incoming = flattenSchedule(replacement).filter(
      ({ scheduled }) => scheduled.audioTime >= transitionAudioTime - Number.EPSILON,
    );
    this.pending = [...retained, ...incoming].sort(
      (left, right) => left.scheduled.audioTime - right.scheduled.audioTime,
    );
    this.endAudioTime = maximumAudioTime(this.pending, this.beatQueue.snapshot());
    this.tick();
  }

  stop(): void {
    if (this.running && canCancelScheduledAudio(this.engine)) {
      this.engine.cancelScheduledFrom(this.engine.now());
    }
    this.timer.stop();
    this.running = false;
    this.pending = [];
    this.endAudioTime = null;
    this.beatQueue.clear();
  }

  private finish(): void {
    this.timer.stop();
    this.running = false;
    this.pending = [];
    this.onEnded?.();
  }
}

function flattenSchedule(options: SchedulerStartOptions): PendingBeat[] {
  const result: PendingBeat[] = [];
  for (const [index, countIn] of (options.countIn ?? []).entries()) {
    assertFiniteNumber(countIn.timeSec, `countIn[${index}].timeSec`);
    const audioTime = options.anchorAudioTime + countIn.timeSec;
    const base = {
      id: `count-in:${index}:${audioTime}`,
      audioTime,
      timelineTimeSec: options.anchorTimelineTimeSec + countIn.timeSec,
      kind: 'countIn' as const,
      accent: countIn.accent ?? (index === 0 ? (2 as const) : (0 as const)),
      isSubdivision: false,
      isCountIn: true,
    };
    const scheduled: ScheduledBeat =
      countIn.countdown === undefined ? base : { ...base, countdown: countIn.countdown };
    result.push({ scheduled });
  }

  options.timeline.entries.forEach((entry, entryIndex) => {
    entry.beats.forEach((beat, beatIndex) => {
      if (beat.timeSec + Number.EPSILON < options.anchorTimelineTimeSec) return;
      assertFiniteNumber(
        beat.timeSec,
        `timeline.entries[${entryIndex}].beats[${beatIndex}].timeSec`,
      );
      const audioTime = options.anchorAudioTime + beat.timeSec - options.anchorTimelineTimeSec;
      result.push({
        scheduled: {
          id: `timeline:${entryIndex}:${beatIndex}:${audioTime}`,
          audioTime,
          timelineTimeSec: beat.timeSec,
          kind: clickKindFor(beat),
          accent: beat.accent,
          isSubdivision: beat.isSubdivision,
          isCountIn: false,
          measureNumber: entry.measureNumber,
          pass: entry.pass,
          sectionId: entry.sectionId,
          entryIndex,
          beatIndex,
        },
      });
    });
  });
  return result.sort((left, right) => left.scheduled.audioTime - right.scheduled.audioTime);
}

function clickKindFor(beat: TimelineBeatLike): ClickKind {
  if (beat.isSubdivision) return 'sub';
  return beat.accent === 2 ? 'downbeat' : 'beat';
}

function validateStartOptions(options: SchedulerStartOptions): void {
  assertFiniteNumber(options.anchorTimelineTimeSec, 'anchorTimelineTimeSec');
  assertFiniteNumber(options.anchorAudioTime, 'anchorAudioTime');
  assertFiniteNumber(options.timeline.totalDurationSec, 'timeline.totalDurationSec');
}

function maximumAudioTime(
  pending: readonly PendingBeat[],
  queued: readonly ScheduledBeat[] = [],
): number | null {
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of pending) maximum = Math.max(maximum, value.scheduled.audioTime);
  for (const value of queued) maximum = Math.max(maximum, value.audioTime);
  return maximum === Number.NEGATIVE_INFINITY ? null : maximum;
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
