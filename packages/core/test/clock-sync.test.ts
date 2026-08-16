import { describe, expect, it } from 'vitest';

import {
  ClockMapper,
  ClockSyncEstimator,
  estimateClockOffset,
  type ClockSyncSample,
} from '../src/index.js';

function symmetricSample(t0: number, rttMs: number, offsetMs: number): ClockSyncSample {
  return {
    clientSendTimeMs: t0,
    serverTimeMs: t0 + rttMs / 2 + offsetMs,
    clientReceiveTimeMs: t0 + rttMs,
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let next = Math.imul(state ^ (state >>> 15), 1 | state);
    next ^= next + Math.imul(next ^ (next >>> 7), 61 | next);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function ntpSampleWithQueuingJitter(options: {
  rng: () => number;
  clientSendTimeMs: number;
  trueOffsetMs: number;
  baseOneWayMs: number;
  maxJitterMs: number;
}): ClockSyncSample {
  const forwardMs = options.baseOneWayMs + options.rng() * options.maxJitterMs;
  const backMs = options.baseOneWayMs + options.rng() * options.maxJitterMs;
  return {
    clientSendTimeMs: options.clientSendTimeMs,
    serverTimeMs: options.clientSendTimeMs + forwardMs + options.trueOffsetMs,
    clientReceiveTimeMs: options.clientSendTimeMs + forwardMs + backMs,
  };
}

describe('clock offset estimation', () => {
  it('selects the minimum-RTT offset from a burst', () => {
    const samples = [
      symmetricSample(0, 40, 1_002),
      symmetricSample(100, 4, 1_000),
      symmetricSample(200, 20, 999),
    ];

    expect(estimateClockOffset(samples)).toMatchObject({ offsetMs: 1_000, rttMs: 4 });
  });

  it('recovers the true offset from a jittered NTP-like simulation', () => {
    const trueOffset = 1_700_000_000_000;
    const paths = [
      { forward: 12, back: 20 },
      { forward: 3, back: 3 },
      { forward: 30, back: 10 },
      { forward: 8, back: 9 },
    ];
    const samples = paths.map(({ forward, back }, index): ClockSyncSample => {
      const clientSendTimeMs = index * 100;
      return {
        clientSendTimeMs,
        serverTimeMs: clientSendTimeMs + forward + trueOffset,
        clientReceiveTimeMs: clientSendTimeMs + forward + back,
      };
    });

    expect(estimateClockOffset(samples).offsetMs).toBe(trueOffset);
  });

  it('keeps offset error under 5ms when queuing jitter reaches 50ms', () => {
    const baseOneWayMs = 8;
    const maxJitterMs = 50;
    const usableExtraRttMs = 10;
    const seeds = [1, 7, 99, 20260815];

    for (const seed of seeds) {
      const rng = mulberry32(seed);
      const trueOffsetMs = 1_700_000_000_000 + rng() * 2_000;
      const samples: ClockSyncSample[] = [];
      let minExtraRttMs = Number.POSITIVE_INFINITY;

      for (let index = 0; index < 512; index += 1) {
        const sample = ntpSampleWithQueuingJitter({
          rng,
          clientSendTimeMs: index * 100,
          trueOffsetMs,
          baseOneWayMs,
          maxJitterMs,
        });
        samples.push(sample);
        minExtraRttMs = Math.min(
          minExtraRttMs,
          sample.clientReceiveTimeMs - sample.clientSendTimeMs - 2 * baseOneWayMs,
        );
        if (samples.length >= 24 && minExtraRttMs < usableExtraRttMs) break;
      }

      expect(samples.length).toBeGreaterThanOrEqual(8);
      expect(
        samples.some(
          (sample) => sample.clientReceiveTimeMs - sample.clientSendTimeMs > 2 * baseOneWayMs + 1,
        ),
      ).toBe(true);

      const estimate = estimateClockOffset(samples);
      const extraRttMs = estimate.rttMs - 2 * baseOneWayMs;
      expect(extraRttMs).toBeLessThan(usableExtraRttMs);
      expect(Math.abs(estimate.offsetMs - trueOffsetMs)).toBeLessThanOrEqual(extraRttMs / 2 + 1e-9);
      expect(Math.abs(estimate.offsetMs - trueOffsetMs)).toBeLessThan(5);
    }
  });

  it('uses EMA for accepted drift samples and rejects RTT outliers', () => {
    const estimator = new ClockSyncEstimator({
      initialBurstSize: 3,
      emaAlpha: 0.2,
      rttOutlierFactor: 2,
      rttOutlierSlackMs: 5,
    });
    estimator.initialize([
      symmetricSample(0, 20, 1_005),
      symmetricSample(100, 4, 1_000),
      symmetricSample(200, 10, 1_002),
    ]);

    const accepted = estimator.observe(symmetricSample(300, 5, 1_010));
    expect(accepted.accepted).toBe(true);
    expect(accepted.state.offsetMs).toBeCloseTo(1_002, 12);

    const rejected = estimator.observe(symmetricSample(400, 100, 2_000));
    expect(rejected).toMatchObject({ accepted: false, reason: 'rtt-outlier' });
    expect(rejected.state.offsetMs).toBeCloseTo(1_002, 12);
    expect(rejected.state.observedSamples).toBe(5);
    expect(rejected.state.acceptedSamples).toBe(2);
  });
});

describe('ClockMapper', () => {
  it('maps server, performance, and audio clocks in both directions', () => {
    const mapper = new ClockMapper({
      serverOffsetMs: 1_700_000_000_000,
      performanceTimeMs: 1_000,
      audioTimeSec: 10,
    });
    const serverTarget = 1_700_000_002_500;

    expect(mapper.serverToPerformanceTime(serverTarget)).toBe(2_500);
    expect(mapper.serverToAudioTime(serverTarget)).toBeCloseTo(11.5, 12);
    expect(mapper.audioToServerTime(11.5)).toBe(serverTarget);
  });

  it('applies automatic, manual, and visual calibration independently', () => {
    const mapper = new ClockMapper({
      serverOffsetMs: 10_000,
      performanceTimeMs: 1_000,
      audioTimeSec: 5,
    });
    const calibration = {
      outputLatencySec: 0.1,
      manualOffsetMs: 20,
      visualOffsetMs: 16,
    };

    expect(mapper.serverToCalibratedAudioTime(12_500, calibration)).toBeCloseTo(6.38, 12);
    expect(mapper.serverToCalibratedVisualTime(12_500, calibration)).toBe(2_484);
  });
});
