import type { AudioEngine } from './engine.js';
import { AudioEnvironmentError, assertFiniteNumber } from './errors.js';

export interface ServerPerformanceMapping {
  serverToPerformance(serverTimeMs: number): number;
  performanceToServer(performanceTimeMs: number): number;
}

/** Rolling robust offset map between performance.now() milliseconds and audio seconds. */
export class AudioPerformanceMapper {
  private readonly offsetsSec: number[] = [];

  constructor(private readonly maxSamples = 9) {
    if (!Number.isInteger(maxSamples) || maxSamples < 1) {
      throw new RangeError('maxSamples must be a positive integer');
    }
  }

  get ready(): boolean {
    return this.offsetsSec.length > 0;
  }

  addSample(performanceTimeMs: number, audioTimeSec: number): void {
    assertFiniteNumber(performanceTimeMs, 'performanceTimeMs');
    assertFiniteNumber(audioTimeSec, 'audioTimeSec');
    this.offsetsSec.push(audioTimeSec - performanceTimeMs / 1_000);
    if (this.offsetsSec.length > this.maxSamples) this.offsetsSec.shift();
  }

  sampleNow(engine: AudioEngine, performanceTimeMs = currentPerformanceTime()): void {
    this.addSample(performanceTimeMs, engine.now());
  }

  performanceToAudio(performanceTimeMs: number): number {
    assertFiniteNumber(performanceTimeMs, 'performanceTimeMs');
    return performanceTimeMs / 1_000 + this.offset();
  }

  audioToPerformance(audioTimeSec: number): number {
    assertFiniteNumber(audioTimeSec, 'audioTimeSec');
    return (audioTimeSec - this.offset()) * 1_000;
  }

  clear(): void {
    this.offsetsSec.length = 0;
  }

  private offset(): number {
    if (this.offsetsSec.length === 0) {
      throw new AudioEnvironmentError(
        'clock-mapping-uninitialized',
        'Sample performance and audio clocks before converting between them.',
      );
    }
    return median(this.offsetsSec);
  }
}

/** `offsetMs` follows the NTP convention: serverTime = performanceTime + offset. */
export class OffsetServerPerformanceMapper implements ServerPerformanceMapping {
  constructor(private offsetMs: number) {
    assertFiniteNumber(offsetMs, 'offsetMs');
  }

  updateOffset(offsetMs: number): void {
    assertFiniteNumber(offsetMs, 'offsetMs');
    this.offsetMs = offsetMs;
  }

  serverToPerformance(serverTimeMs: number): number {
    assertFiniteNumber(serverTimeMs, 'serverTimeMs');
    return serverTimeMs - this.offsetMs;
  }

  performanceToServer(performanceTimeMs: number): number {
    assertFiniteNumber(performanceTimeMs, 'performanceTimeMs');
    return performanceTimeMs + this.offsetMs;
  }
}

/** Composes server↔performance and performance↔audio mappings from DESIGN.md §6.2. */
export class ServerAudioMapper {
  constructor(
    private readonly serverPerformance: ServerPerformanceMapping,
    private readonly audioPerformance: AudioPerformanceMapper,
    private readonly outputLatencyProvider: () => number = () => 0,
  ) {}

  serverToAudio(serverTimeMs: number): number {
    return this.audioPerformance.performanceToAudio(
      this.serverPerformance.serverToPerformance(serverTimeMs),
    );
  }

  audioToServer(audioTimeSec: number): number {
    return this.serverPerformance.performanceToServer(
      this.audioPerformance.audioToPerformance(audioTimeSec),
    );
  }

  /** Positive calibration means additional audible delay and therefore earlier scheduling. */
  serverToScheduledAudio(serverTimeMs: number, calibrationOffsetSec = 0): number {
    assertFiniteNumber(calibrationOffsetSec, 'calibrationOffsetSec');
    const outputLatency = this.outputLatencyProvider();
    assertFiniteNumber(outputLatency, 'outputLatency');
    if (outputLatency < 0) throw new RangeError('outputLatency must not be negative');
    return this.serverToAudio(serverTimeMs) - outputLatency - calibrationOffsetSec;
  }
}

function currentPerformanceTime(): number {
  if (typeof performance === 'undefined') {
    throw new AudioEnvironmentError(
      'clock-mapping-uninitialized',
      'performance.now() is unavailable in this environment.',
    );
  }
  return performance.now();
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}
