import { describe, expect, it } from 'vitest';

import {
  calibratedAudioScheduleTime,
  calibrationKey,
  estimateCalibrationOffset,
  median,
} from '../src/index.js';

describe('calibration helpers', () => {
  it('uses the median so a mistimed tap cannot dominate calibration', () => {
    const samples = [
      { expectedTimeMs: 0, observedTimeMs: 120 },
      { expectedTimeMs: 1_000, observedTimeMs: 1_122 },
      { expectedTimeMs: 2_000, observedTimeMs: 2_500 },
      { expectedTimeMs: 3_000, observedTimeMs: 3_118 },
      { expectedTimeMs: 4_000, observedTimeMs: 4_121 },
    ];

    expect(estimateCalibrationOffset(samples, 100)).toBe(21);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('schedules early by reported and residual latency', () => {
    expect(
      calibratedAudioScheduleTime(10, {
        outputLatencySec: 0.2,
        manualOffsetMs: 30,
        visualOffsetMs: 0,
      }),
    ).toBeCloseTo(9.77, 12);
  });

  it('creates collision-resistant keys for device/output combinations', () => {
    expect(calibrationKey('device::one', 'USB / DAC')).toBe('device%3A%3Aone::USB%20%2F%20DAC');
  });

  it('rejects missing or non-finite calibration evidence', () => {
    expect(() => median([])).toThrow(RangeError);
    expect(() => median([1, Number.NaN])).toThrow(RangeError);
    expect(() => estimateCalibrationOffset([])).toThrow(RangeError);
  });
});
