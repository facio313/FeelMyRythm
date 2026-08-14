import { describe, expect, it } from 'vitest';

import { CLICK_KINDS, WebAudioEngine } from '../src/index.js';

class FakeAudioBuffer {
  readonly duration: number;
  readonly numberOfChannels = 1;
  readonly data: Float32Array;

  constructor(
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.duration = length / sampleRate;
    this.data = new Float32Array(length);
  }

  getChannelData(): Float32Array {
    return this.data;
  }

  copyFromChannel(): void {}
  copyToChannel(): void {}
}

class FakeBufferSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped = false;

  connect(): void {}

  start(at: number): void {
    this.startedAt = at;
  }

  stop(): void {
    this.stopped = true;
    this.onended?.();
  }
}

class FakeAudioContext {
  state: AudioContextState = 'suspended';
  currentTime = 4;
  sampleRate = 48_000;
  baseLatency = 0.01;
  outputLatency = 0.02;
  destination = {} as AudioDestinationNode;
  createdBuffers = 0;
  decodedBuffers = 0;
  readonly sources: FakeBufferSource[] = [];
  readonly gain = { gain: { value: 1 }, connect: () => undefined };
  resumeCalls = 0;
  suspendCalls = 0;
  deferSuspend = false;
  private finishPendingSuspend: (() => void) | null = null;

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = 'running';
  }

  async suspend(): Promise<void> {
    this.suspendCalls += 1;
    if (this.deferSuspend) {
      await new Promise<void>((resolve) => {
        this.finishPendingSuspend = resolve;
      });
    }
    this.state = 'suspended';
  }

  finishSuspend(): void {
    this.finishPendingSuspend?.();
    this.finishPendingSuspend = null;
  }

  async close(): Promise<void> {
    this.state = 'closed';
  }

  createGain(): GainNode {
    return this.gain as unknown as GainNode;
  }

  createBuffer(_channels: number, length: number, sampleRate: number): AudioBuffer {
    this.createdBuffers += 1;
    return new FakeAudioBuffer(length, sampleRate) as unknown as AudioBuffer;
  }

  async decodeAudioData(_data: ArrayBuffer): Promise<AudioBuffer> {
    this.decodedBuffers += 1;
    return new FakeAudioBuffer(128, this.sampleRate) as unknown as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }
}

describe('WebAudioEngine', () => {
  it('prepares four buffers and schedules only AudioBufferSource nodes', async () => {
    const context = new FakeAudioContext();
    const engine = new WebAudioEngine({
      context: context as unknown as AudioContext,
      samples: { beat: new ArrayBuffer(8) },
    });
    await engine.start();

    expect(context.decodedBuffers).toBe(1);
    expect(context.createdBuffers).toBe(3);
    for (const [index, kind] of CLICK_KINDS.entries()) engine.scheduleClick(5 + index, kind);
    expect(context.sources.map(({ startedAt }) => startedAt)).toEqual([5, 6, 7, 8]);
    expect(engine.outputLatency()).toBeCloseTo(0.03, 8);

    engine.stop();
    expect(context.sources.every(({ stopped }) => stopped)).toBe(true);
  });

  it('waits for an in-flight suspend before resuming a rapid restart', async () => {
    const context = new FakeAudioContext();
    const engine = new WebAudioEngine({ context: context as unknown as AudioContext });
    await engine.start();
    context.deferSuspend = true;

    engine.stop();
    const restarted = engine.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(context.suspendCalls).toBe(1);
    expect(context.resumeCalls).toBe(1);

    context.finishSuspend();
    await restarted;
    expect(context.resumeCalls).toBe(2);
    expect(context.state).toBe('running');
    expect(engine.isReady).toBe(true);
    engine.scheduleClick(5, 'beat');
    expect(context.sources.at(-1)?.startedAt).toBe(5);
  });
});
