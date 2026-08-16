import { describe, expect, it } from 'vitest';

import {
  AudioEnvironmentError,
  LookaheadScheduler,
  WebAudioEngine,
  type AudioEngine,
  type ClickKind,
} from '../src/index.js';

class MinimalEngine implements AudioEngine {
  scheduleClick(_atAudioTime: number, _kind: ClickKind): void {}
  now(): number {
    return 0;
  }
  outputLatency(): number {
    return 0;
  }
  async start(): Promise<void> {}
  stop(): void {}
}

describe('unsupported browser boundaries', () => {
  it('returns a typed error when Web Audio is unavailable', async () => {
    const engine = new WebAudioEngine();
    await expect(engine.start()).rejects.toMatchObject({
      name: 'AudioEnvironmentError',
      code: 'audio-context-unsupported',
    });
  });

  it('returns a typed error when the Worker scheduler is unavailable', () => {
    const scheduler = new LookaheadScheduler(new MinimalEngine());
    expect(() =>
      scheduler.start({
        timeline: { tempoMapRevision: 1, entries: [], totalDurationSec: 0 },
        anchorTimelineTimeSec: 0,
        anchorAudioTime: 0,
      }),
    ).toThrow(AudioEnvironmentError);
  });
});
