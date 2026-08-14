import type { AudioEngine } from './engine.js';
import { AudioEnvironmentError } from './errors.js';
import {
  LookaheadScheduler,
  type LookaheadSchedulerOptions,
  type PerformanceTimelineLike,
  type SchedulerStartOptions,
  type TimelineMeasureLike,
} from './scheduler.js';

export interface TimelineTransition {
  readonly audioTime: number;
  readonly fromTimelineTimeSec: number;
  readonly toTimelineTimeSec: number;
  readonly measureNumber: number;
  readonly pass: number;
}

interface TimelineBinding {
  readonly timeline: PerformanceTimelineLike;
  readonly anchorTimelineTimeSec: number;
  readonly anchorAudioTime: number;
}

interface PendingBinding extends TimelineBinding {
  readonly transitionAudioTime: number;
}

/** Owns engine lifecycle and applies edits only at a following measure boundary. */
export class TimelineTransport {
  readonly scheduler: LookaheadScheduler;
  private binding: TimelineBinding | null = null;
  private pendingBinding: PendingBinding | null = null;

  constructor(
    private readonly engine: AudioEngine,
    schedulerOptions: LookaheadSchedulerOptions = {},
  ) {
    this.scheduler = new LookaheadScheduler(engine, schedulerOptions);
  }

  get beatQueue() {
    return this.scheduler.beatQueue;
  }

  get isPlaying(): boolean {
    return this.scheduler.isRunning;
  }

  async start(options: SchedulerStartOptions): Promise<void> {
    this.scheduler.stop();
    this.binding = null;
    this.pendingBinding = null;
    await this.engine.start();
    try {
      this.scheduler.start(options);
    } catch (error) {
      this.engine.stop();
      throw error;
    }
    this.binding = {
      timeline: options.timeline,
      anchorTimelineTimeSec: options.anchorTimelineTimeSec,
      anchorAudioTime: options.anchorAudioTime,
    };
    this.pendingBinding = null;
  }

  position(): number | null {
    if (!this.scheduler.isRunning) return null;
    const now = this.engine.now();
    const binding = this.bindingAt(now);
    if (binding === null) return null;
    return binding.anchorTimelineTimeSec + now - binding.anchorAudioTime;
  }

  queueTimelineTransition(nextTimeline: PerformanceTimelineLike): TimelineTransition {
    const now = this.engine.now();
    const current = this.bindingAt(now);
    if (current === null || !this.scheduler.isRunning) {
      throw new AudioEnvironmentError(
        'timeline-transition-unavailable',
        'A next-measure transition requires active timeline playback.',
      );
    }
    const position = current.anchorTimelineTimeSec + now - current.anchorAudioTime;
    const boundary = findFollowingMeasure(current.timeline, position);
    if (boundary === null) {
      throw new AudioEnvironmentError(
        'timeline-transition-unavailable',
        'There is no following measure boundary in the active timeline.',
      );
    }
    const replacementBoundary = findMatchingMeasure(nextTimeline, boundary);
    if (replacementBoundary === null) {
      throw new AudioEnvironmentError(
        'timeline-transition-unavailable',
        `The replacement timeline has no measure ${boundary.measureNumber}, pass ${boundary.pass}.`,
      );
    }

    const transitionAudioTime =
      current.anchorAudioTime + boundary.startTimeSec - current.anchorTimelineTimeSec;
    const replacement: SchedulerStartOptions = {
      timeline: nextTimeline,
      anchorTimelineTimeSec: replacementBoundary.startTimeSec,
      anchorAudioTime: transitionAudioTime,
    };
    this.scheduler.replaceTimelineFrom(transitionAudioTime, replacement);
    this.pendingBinding = {
      timeline: nextTimeline,
      anchorTimelineTimeSec: replacementBoundary.startTimeSec,
      anchorAudioTime: transitionAudioTime,
      transitionAudioTime,
    };

    return {
      audioTime: transitionAudioTime,
      fromTimelineTimeSec: boundary.startTimeSec,
      toTimelineTimeSec: replacementBoundary.startTimeSec,
      measureNumber: boundary.measureNumber,
      pass: boundary.pass,
    };
  }

  stop(): void {
    this.scheduler.stop();
    this.engine.stop();
    this.binding = null;
    this.pendingBinding = null;
  }

  private bindingAt(audioTime: number): TimelineBinding | null {
    if (
      this.pendingBinding !== null &&
      audioTime + Number.EPSILON >= this.pendingBinding.transitionAudioTime
    ) {
      this.binding = this.pendingBinding;
      this.pendingBinding = null;
    }
    return this.binding;
  }
}

function findFollowingMeasure(
  timeline: PerformanceTimelineLike,
  positionSec: number,
): TimelineMeasureLike | null {
  return (
    timeline.entries.find((entry) => entry.startTimeSec > positionSec + Number.EPSILON) ?? null
  );
}

function findMatchingMeasure(
  timeline: PerformanceTimelineLike,
  boundary: TimelineMeasureLike,
): TimelineMeasureLike | null {
  return (
    timeline.entries.find(
      (entry) => entry.measureNumber === boundary.measureNumber && entry.pass === boundary.pass,
    ) ?? null
  );
}
