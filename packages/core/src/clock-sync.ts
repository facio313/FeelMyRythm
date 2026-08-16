/*
 * NTP 유사 시계 합의. 박 시각이 아니라 서버 epoch ↔ 클라이언트 monotonic 오프셋만 맞춘다.
 * 비대칭 지연은 min-RTT 표본을 골라 줄이고, 이후 표본은 EMA로 드리프트만 따라간다.
 */
import {
  calibratedAudioScheduleTime,
  calibratedVisualTimeMs,
  type PlaybackCalibration,
} from './calibration.js';

export interface ClockSyncSample {
  /** Client monotonic timestamp sent in PING. */
  clientSendTimeMs: number;
  /** Server epoch timestamp recorded at receipt/response. */
  serverTimeMs: number;
  /** Client monotonic timestamp when PONG is received. */
  clientReceiveTimeMs: number;
}

export interface ClockOffsetEstimate {
  /** serverTimeMs - clientMonotonicTimeMs */
  offsetMs: number;
  rttMs: number;
  clientMidpointTimeMs: number;
  sample: ClockSyncSample;
}

export interface ClockSyncEstimatorOptions {
  /** Design default: ten samples immediately after joining. */
  initialBurstSize?: number;
  /** Weight assigned to a newly accepted periodic offset. */
  emaAlpha?: number;
  /** A periodic RTT above both outlier bounds is rejected. */
  rttOutlierFactor?: number;
  rttOutlierSlackMs?: number;
}

export interface ClockSyncState {
  offsetMs: number;
  latestRttMs: number;
  minRttMs: number;
  observedSamples: number;
  acceptedSamples: number;
}

export interface ClockSyncObservation {
  accepted: boolean;
  reason: 'accepted' | 'rtt-outlier';
  estimate: ClockOffsetEstimate;
  state: ClockSyncState;
}

const DEFAULT_OPTIONS = Object.freeze({
  initialBurstSize: 10,
  emaAlpha: 0.2,
  rttOutlierFactor: 2.5,
  rttOutlierSlackMs: 10,
});

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
}

export function estimateClockSample(sample: ClockSyncSample): ClockOffsetEstimate {
  assertFinite(sample.clientSendTimeMs, 'clientSendTimeMs');
  assertFinite(sample.serverTimeMs, 'serverTimeMs');
  assertFinite(sample.clientReceiveTimeMs, 'clientReceiveTimeMs');
  const rttMs = sample.clientReceiveTimeMs - sample.clientSendTimeMs;
  if (rttMs < 0) throw new RangeError('clientReceiveTimeMs must not precede clientSendTimeMs');
  const clientMidpointTimeMs = (sample.clientSendTimeMs + sample.clientReceiveTimeMs) / 2;
  return {
    offsetMs: sample.serverTimeMs - clientMidpointTimeMs,
    rttMs,
    clientMidpointTimeMs,
    sample: { ...sample },
  };
}

/** RTT가 가장 작은 표본의 offset을 채택한다. 동률이면 먼저 온 표본을 쓴다. */
export function estimateClockOffset(samples: readonly ClockSyncSample[]): ClockOffsetEstimate {
  if (samples.length === 0) throw new RangeError('samples must not be empty');
  let best: ClockOffsetEstimate | undefined;
  for (const sample of samples) {
    const estimate = estimateClockSample(sample);
    if (best === undefined || estimate.rttMs < best.rttMs) best = estimate;
  }
  if (best === undefined) throw new RangeError('samples must not be empty');
  return best;
}

export class ClockSyncEstimator {
  readonly initialBurstSize: number;
  readonly emaAlpha: number;
  readonly rttOutlierFactor: number;
  readonly rttOutlierSlackMs: number;

  private currentState: ClockSyncState | undefined;

  constructor(options: ClockSyncEstimatorOptions = {}) {
    this.initialBurstSize = options.initialBurstSize ?? DEFAULT_OPTIONS.initialBurstSize;
    this.emaAlpha = options.emaAlpha ?? DEFAULT_OPTIONS.emaAlpha;
    this.rttOutlierFactor = options.rttOutlierFactor ?? DEFAULT_OPTIONS.rttOutlierFactor;
    this.rttOutlierSlackMs = options.rttOutlierSlackMs ?? DEFAULT_OPTIONS.rttOutlierSlackMs;

    if (!Number.isInteger(this.initialBurstSize) || this.initialBurstSize <= 0) {
      throw new RangeError('initialBurstSize must be a positive integer');
    }
    if (!Number.isFinite(this.emaAlpha) || this.emaAlpha <= 0 || this.emaAlpha > 1) {
      throw new RangeError('emaAlpha must be in (0, 1]');
    }
    if (!Number.isFinite(this.rttOutlierFactor) || this.rttOutlierFactor < 1) {
      throw new RangeError('rttOutlierFactor must be at least 1');
    }
    if (!Number.isFinite(this.rttOutlierSlackMs) || this.rttOutlierSlackMs < 0) {
      throw new RangeError('rttOutlierSlackMs must not be negative');
    }
  }

  initialize(samples: readonly ClockSyncSample[]): ClockSyncState {
    if (samples.length < this.initialBurstSize) {
      throw new RangeError(
        `initial burst requires at least ${String(this.initialBurstSize)} samples`,
      );
    }
    const estimate = estimateClockOffset(samples);
    this.currentState = {
      offsetMs: estimate.offsetMs,
      latestRttMs: estimate.rttMs,
      minRttMs: estimate.rttMs,
      observedSamples: samples.length,
      acceptedSamples: 1,
    };
    return this.state;
  }

  observe(sample: ClockSyncSample): ClockSyncObservation {
    const estimate = estimateClockSample(sample);
    if (this.currentState === undefined) {
      this.currentState = {
        offsetMs: estimate.offsetMs,
        latestRttMs: estimate.rttMs,
        minRttMs: estimate.rttMs,
        observedSamples: 1,
        acceptedSamples: 1,
      };
      return { accepted: true, reason: 'accepted', estimate, state: this.state };
    }

    const previous = this.currentState;
    const observedSamples = previous.observedSamples + 1;
    const outlierThreshold = Math.max(
      previous.minRttMs * this.rttOutlierFactor,
      previous.minRttMs + this.rttOutlierSlackMs,
    );
    if (estimate.rttMs > outlierThreshold) {
      this.currentState = { ...previous, observedSamples };
      return { accepted: false, reason: 'rtt-outlier', estimate, state: this.state };
    }

    this.currentState = {
      offsetMs: previous.offsetMs * (1 - this.emaAlpha) + estimate.offsetMs * this.emaAlpha,
      latestRttMs: estimate.rttMs,
      minRttMs: Math.min(previous.minRttMs, estimate.rttMs),
      observedSamples,
      acceptedSamples: previous.acceptedSamples + 1,
    };
    return { accepted: true, reason: 'accepted', estimate, state: this.state };
  }

  get initialized(): boolean {
    return this.currentState !== undefined;
  }

  get state(): ClockSyncState {
    if (this.currentState === undefined) {
      throw new Error('ClockSyncEstimator has not been initialized');
    }
    return { ...this.currentState };
  }

  reset(): void {
    this.currentState = undefined;
  }
}

export interface ClockMappingSnapshot {
  /** server epoch time minus performance monotonic time. */
  serverOffsetMs: number;
  /** A simultaneous performance.now() sample. */
  performanceTimeMs: number;
  /** A simultaneous platform audio-clock sample in seconds. */
  audioTimeSec: number;
}

/** Pure affine mapping among server epoch, performance, and audio clocks. */
export class ClockMapper {
  private snapshot: ClockMappingSnapshot;

  constructor(snapshot: ClockMappingSnapshot) {
    ClockMapper.assertSnapshot(snapshot);
    this.snapshot = { ...snapshot };
  }

  updateServerOffset(serverOffsetMs: number): void {
    assertFinite(serverOffsetMs, 'serverOffsetMs');
    this.snapshot = { ...this.snapshot, serverOffsetMs };
  }

  sampleAudioClock(performanceTimeMs: number, audioTimeSec: number): void {
    assertFinite(performanceTimeMs, 'performanceTimeMs');
    assertFinite(audioTimeSec, 'audioTimeSec');
    this.snapshot = { ...this.snapshot, performanceTimeMs, audioTimeSec };
  }

  get currentSnapshot(): ClockMappingSnapshot {
    return { ...this.snapshot };
  }

  serverToPerformanceTime(serverTimeMs: number): number {
    assertFinite(serverTimeMs, 'serverTimeMs');
    return serverTimeMs - this.snapshot.serverOffsetMs;
  }

  performanceToServerTime(performanceTimeMs: number): number {
    assertFinite(performanceTimeMs, 'performanceTimeMs');
    return performanceTimeMs + this.snapshot.serverOffsetMs;
  }

  performanceToAudioTime(performanceTimeMs: number): number {
    assertFinite(performanceTimeMs, 'performanceTimeMs');
    return (
      this.snapshot.audioTimeSec + (performanceTimeMs - this.snapshot.performanceTimeMs) / 1_000
    );
  }

  audioToPerformanceTime(audioTimeSec: number): number {
    assertFinite(audioTimeSec, 'audioTimeSec');
    return this.snapshot.performanceTimeMs + (audioTimeSec - this.snapshot.audioTimeSec) * 1_000;
  }

  serverToAudioTime(serverTimeMs: number): number {
    return this.performanceToAudioTime(this.serverToPerformanceTime(serverTimeMs));
  }

  audioToServerTime(audioTimeSec: number): number {
    return this.performanceToServerTime(this.audioToPerformanceTime(audioTimeSec));
  }

  serverToCalibratedAudioTime(serverTimeMs: number, calibration: PlaybackCalibration): number {
    return calibratedAudioScheduleTime(this.serverToAudioTime(serverTimeMs), calibration);
  }

  serverToCalibratedVisualTime(serverTimeMs: number, calibration: PlaybackCalibration): number {
    return calibratedVisualTimeMs(this.serverToPerformanceTime(serverTimeMs), calibration);
  }

  private static assertSnapshot(snapshot: ClockMappingSnapshot): void {
    assertFinite(snapshot.serverOffsetMs, 'serverOffsetMs');
    assertFinite(snapshot.performanceTimeMs, 'performanceTimeMs');
    assertFinite(snapshot.audioTimeSec, 'audioTimeSec');
  }
}
