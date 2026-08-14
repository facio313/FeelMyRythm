import { describe, expect, it } from 'vitest';

import {
  BeatQueue,
  LOOKAHEAD_SEC,
  LookaheadScheduler,
  SCHEDULER_TICK_MS,
  TimelineTransport,
  type AudioEngine,
  type ClickKind,
  type PerformanceTimelineLike,
  type SchedulerTimer,
} from '../src/index.js';

class FakeEngine implements AudioEngine {
  time = 0;
  started = false;
  readonly scheduled: { at: number; kind: ClickKind }[] = [];
  readonly cancelledFrom: number[] = [];
  startCalls = 0;
  stopCalls = 0;

  scheduleClick(atAudioTime: number, kind: ClickKind): void {
    this.scheduled.push({ at: atAudioTime, kind });
  }

  now(): number {
    return this.time;
  }

  outputLatency(): number {
    return 0.02;
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    this.started = true;
  }

  stop(): void {
    this.stopCalls += 1;
    this.started = false;
  }

  cancelScheduledFrom(atAudioTime: number): void {
    this.cancelledFrom.push(atAudioTime);
    for (let index = this.scheduled.length - 1; index >= 0; index -= 1) {
      if (this.scheduled[index]!.at >= atAudioTime) this.scheduled.splice(index, 1);
    }
  }
}

class ManualTimer implements SchedulerTimer {
  running = false;
  private listener: (() => void) | null = null;

  start(listener: () => void): void {
    this.running = true;
    this.listener = listener;
  }

  stop(): void {
    this.running = false;
    this.listener = null;
  }

  fire(): void {
    if (this.running) this.listener?.();
  }
}

function timeline(secondMeasureBeats = [1, 1.5]): PerformanceTimelineLike {
  return {
    tempoMapRevision: 1,
    totalDurationSec: 2,
    entries: [
      {
        measureNumber: 1,
        pass: 1,
        sectionId: 'a',
        startTimeSec: 0,
        beats: [
          { timeSec: 0, accent: 2, isSubdivision: false },
          { timeSec: 0.5, accent: 0, isSubdivision: false },
        ],
      },
      {
        measureNumber: 2,
        pass: 1,
        sectionId: 'b',
        startTimeSec: 1,
        beats: secondMeasureBeats.map((timeSec, index) => ({
          timeSec,
          accent: index === 0 ? (2 as const) : index === 1 ? (1 as const) : (0 as const),
          isSubdivision: index === 1,
        })),
      },
    ],
  };
}

describe('LookaheadScheduler', () => {
  it('uses the specified 25 ms worker cadence and 120 ms lookahead window', () => {
    expect(SCHEDULER_TICK_MS).toBe(25);
    expect(LOOKAHEAD_SEC).toBe(0.12);
  });

  it('only schedules beats inside the audio-clock lookahead and mirrors them to BeatQueue', () => {
    const engine = new FakeEngine();
    const timer = new ManualTimer();
    const queue = new BeatQueue();
    engine.time = 10;
    const scheduler = new LookaheadScheduler(engine, { timer, beatQueue: queue });

    scheduler.start({
      timeline: timeline(),
      anchorTimelineTimeSec: 0,
      anchorAudioTime: 10,
    });

    expect(engine.scheduled).toEqual([{ at: 10, kind: 'downbeat' }]);
    expect(queue.snapshot().map((beat) => beat.audioTime)).toEqual([10]);

    engine.time = 10.39;
    timer.fire();
    expect(engine.scheduled.at(-1)).toEqual({ at: 10.5, kind: 'beat' });
    expect(queue.snapshot().map((beat) => beat.audioTime)).toEqual([10, 10.5]);
  });

  it('schedules count-in beats relative to the main timeline anchor', () => {
    const engine = new FakeEngine();
    const timer = new ManualTimer();
    engine.time = 20;
    const scheduler = new LookaheadScheduler(engine, { timer });

    scheduler.start({
      timeline: timeline(),
      anchorTimelineTimeSec: 0,
      anchorAudioTime: 21,
      countIn: [
        { timeSec: -1, countdown: 2 },
        { timeSec: -0.5, countdown: 1 },
      ],
    });

    expect(engine.scheduled[0]).toEqual({ at: 20, kind: 'countIn' });
    expect(scheduler.beatQueue.snapshot()[0]).toMatchObject({
      audioTime: 20,
      kind: 'countIn',
      isCountIn: true,
      countdown: 2,
    });
  });
});

describe('TimelineTransport', () => {
  it('does not suspend the engine as part of starting a fresh schedule', async () => {
    const engine = new FakeEngine();
    const transport = new TimelineTransport(engine, { timer: new ManualTimer() });

    await transport.start({
      timeline: timeline(),
      anchorTimelineTimeSec: 0,
      anchorAudioTime: 0,
    });

    expect(engine.startCalls).toBe(1);
    expect(engine.stopCalls).toBe(0);
  });

  it('replaces future beats at the next measure boundary', async () => {
    const engine = new FakeEngine();
    const timer = new ManualTimer();
    engine.time = 100;
    const transport = new TimelineTransport(engine, { timer });
    await transport.start({
      timeline: timeline(),
      anchorTimelineTimeSec: 0,
      anchorAudioTime: 100,
    });

    engine.time = 100.2;
    const transition = transport.queueTimelineTransition(timeline([1, 1.25, 1.75]));
    expect(transition).toMatchObject({
      audioTime: 101,
      measureNumber: 2,
      pass: 1,
    });
    expect(engine.cancelledFrom).toEqual([101]);

    engine.time = 100.9;
    timer.fire();
    engine.time = 101.15;
    timer.fire();
    engine.time = 101.64;
    timer.fire();
    expect(engine.scheduled.some(({ at }) => at === 101.25)).toBe(true);
    expect(engine.scheduled.some(({ at }) => at === 101.5)).toBe(false);
    expect(transport.position()).toBeCloseTo(1.64, 8);
  });

  it('cancels an old click already inside lookahead before replacing it', async () => {
    const engine = new FakeEngine();
    const timer = new ManualTimer();
    engine.time = 0.89;
    const transport = new TimelineTransport(engine, { timer });
    await transport.start({
      timeline: timeline(),
      anchorTimelineTimeSec: 0,
      anchorAudioTime: 0,
    });
    expect(engine.scheduled).toContainEqual({ at: 1, kind: 'downbeat' });

    const base = timeline([1, 1.25]);
    const replacement: PerformanceTimelineLike = {
      ...base,
      entries: [
        base.entries[0]!,
        {
          ...base.entries[1]!,
          beats: [
            { timeSec: 1, accent: 1, isSubdivision: false },
            { timeSec: 1.25, accent: 0, isSubdivision: true },
          ],
        },
      ],
    };
    transport.queueTimelineTransition(replacement);

    expect(engine.scheduled.filter(({ at }) => at === 1)).toEqual([{ at: 1, kind: 'beat' }]);
    expect(transport.beatQueue.snapshot().filter(({ audioTime }) => audioTime === 1)).toHaveLength(
      1,
    );
  });
});
