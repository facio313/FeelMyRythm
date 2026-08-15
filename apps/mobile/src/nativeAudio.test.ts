import { describe, expect, it, vi } from 'vitest';

import { NativeAudioEngine, type NativeAudioPluginContract } from './nativeAudio';

function pluginFixture() {
  const start = vi.fn(async () => ({ nativeTimeSec: 100, outputLatencySec: 0.014 }));
  const scheduleClicks = vi.fn(async () => undefined);
  const cancelScheduledFrom = vi.fn(async () => undefined);
  const setVolume = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  let stoppedListener: ((event: { reason: string }) => void) | null = null;
  const removeListener = vi.fn(async () => undefined);
  const addListener = vi.fn(
    async (_eventName: 'stopped', listener: (event: { reason: string }) => void) => {
      stoppedListener = listener;
      return { remove: removeListener };
    },
  );
  const plugin: NativeAudioPluginContract = {
    start,
    scheduleClicks,
    cancelScheduledFrom,
    setVolume,
    stop,
    addListener,
  };
  return {
    plugin,
    start,
    scheduleClicks,
    cancelScheduledFrom,
    setVolume,
    stop,
    removeListener,
    emitStopped: () => stoppedListener?.({ reason: 'mediaControl' }),
  };
}

describe('NativeAudioEngine', () => {
  it('maps performance time to the native monotonic clock and exposes latency', async () => {
    const { plugin, start } = pluginFixture();
    const times = [2_000, 2_010, 2_110];
    const engine = new NativeAudioEngine({
      plugin,
      volume: 0.7,
      performanceNow: () => times.shift() ?? 2_110,
    });

    await engine.start();

    expect(start).toHaveBeenCalledWith({ volume: 0.7 });
    expect(engine.now()).toBeCloseTo(100.105, 6);
    expect(engine.outputLatency()).toBe(0.014);
    expect(engine.schedulingStrategy).toBe('entireTimeline');
  });

  it('transfers clicks in a batch and preserves cancel/stop ordering', async () => {
    const { plugin, scheduleClicks, cancelScheduledFrom, setVolume, stop } = pluginFixture();
    const engine = new NativeAudioEngine({ plugin, performanceNow: () => 1_000 });
    await engine.start();

    engine.scheduleClicks([
      { atAudioTime: 4, kind: 'downbeat' },
      { atAudioTime: 4.5, kind: 'sub' },
    ]);
    engine.cancelScheduledFrom(5);
    engine.setVolume(0.4);
    engine.stop();
    await engine.dispose();

    expect(scheduleClicks).toHaveBeenCalledWith({
      clicks: [
        { atTimeSec: 4, kind: 'downbeat' },
        { atTimeSec: 4.5, kind: 'sub' },
      ],
    });
    expect(cancelScheduledFrom).toHaveBeenCalledWith({ atTimeSec: 5 });
    expect(setVolume).toHaveBeenCalledWith({ volume: 0.4 });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('rejects scheduling before start and invalid volume', () => {
    const engine = new NativeAudioEngine({
      plugin: pluginFixture().plugin,
      performanceNow: () => 0,
    });
    expect(() => engine.scheduleClick(1, 'beat')).toThrow(/start/);
    expect(() => engine.setVolume(2)).toThrow(/between 0 and 1/);
  });

  it('surfaces native media-control and natural stops to the owner', async () => {
    const fixture = pluginFixture();
    const engine = new NativeAudioEngine({ plugin: fixture.plugin, performanceNow: () => 0 });
    const onStopped = vi.fn();
    engine.onStopped = onStopped;
    await engine.start();

    fixture.emitStopped();

    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(engine.now()).toBe(0);
    await engine.dispose();
    expect(fixture.removeListener).toHaveBeenCalledTimes(1);
  });
});
