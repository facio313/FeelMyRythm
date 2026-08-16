export interface CalibrationTapSample {
  /** Intended audible click time on a monotonic clock. */
  expectedTimeMs: number;
  /** User tap time on the same monotonic clock. */
  observedTimeMs: number;
}

export interface PlaybackCalibration {
  /** Browser/device-reported output pipeline delay. */
  outputLatencySec: number;
  /** Positive when output remains late after automatic latency compensation. */
  manualOffsetMs: number;
  /** Positive when the display is observed late. */
  visualOffsetMs: number;
}

export const NO_CALIBRATION: Readonly<PlaybackCalibration> = Object.freeze({
  outputLatencySec: 0,
  manualOffsetMs: 0,
  visualOffsetMs: 0,
});

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('values must not be empty');
  const sorted = [...values];
  sorted.forEach((value, index) => assertFinite(value, `values[${String(index)}]`));
  sorted.sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) throw new RangeError('values must not be empty');
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1];
  if (lower === undefined) throw new RangeError('values must not be empty');
  return (lower + upper) / 2;
}

/**
 * Estimates residual audible lateness. Pass the already compensated automatic
 * latency so it is not counted twice.
 */
export function estimateCalibrationOffset(
  samples: readonly CalibrationTapSample[],
  compensatedOutputLatencyMs = 0,
): number {
  assertFinite(compensatedOutputLatencyMs, 'compensatedOutputLatencyMs');
  const offsets = samples.map((sample, index) => {
    assertFinite(sample.expectedTimeMs, `samples[${String(index)}].expectedTimeMs`);
    assertFinite(sample.observedTimeMs, `samples[${String(index)}].observedTimeMs`);
    return sample.observedTimeMs - sample.expectedTimeMs - compensatedOutputLatencyMs;
  });
  return median(offsets);
}

export function validateCalibration(calibration: PlaybackCalibration): void {
  assertFinite(calibration.outputLatencySec, 'outputLatencySec');
  assertFinite(calibration.manualOffsetMs, 'manualOffsetMs');
  assertFinite(calibration.visualOffsetMs, 'visualOffsetMs');
  if (calibration.outputLatencySec < 0) {
    throw new RangeError('outputLatencySec must not be negative');
  }
}

/** Convert an intended audible audio-clock time into an engine schedule time. */
export function calibratedAudioScheduleTime(
  targetAudioTimeSec: number,
  calibration: PlaybackCalibration,
): number {
  assertFinite(targetAudioTimeSec, 'targetAudioTimeSec');
  validateCalibration(calibration);
  return targetAudioTimeSec - calibration.outputLatencySec - calibration.manualOffsetMs / 1_000;
}

/** Convert an intended visible performance time into an earlier render target. */
export function calibratedVisualTimeMs(
  targetPerformanceTimeMs: number,
  calibration: PlaybackCalibration,
): number {
  assertFinite(targetPerformanceTimeMs, 'targetPerformanceTimeMs');
  validateCalibration(calibration);
  return targetPerformanceTimeMs - calibration.visualOffsetMs;
}

export function calibrationKey(deviceFingerprint: string, outputLabel: string): string {
  if (deviceFingerprint.trim().length === 0) {
    throw new RangeError('deviceFingerprint must not be empty');
  }
  if (outputLabel.trim().length === 0) throw new RangeError('outputLabel must not be empty');
  return `${encodeURIComponent(deviceFingerprint)}::${encodeURIComponent(outputLabel)}`;
}
