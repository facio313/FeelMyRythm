"""Click interval and inter-device offset analysis."""

from __future__ import annotations

import math
from collections.abc import Iterator
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path
from statistics import fmean, median
from typing import Any

from .wav_stream import (
    Channel,
    WavSpec,
    channel_label,
    iter_magnitudes,
    read_wav_spec,
)

_LEVEL_HISTOGRAM_BINS = 4_096
_MAX_CORRELATION_BINS = 2_000_001
_MAX_STORED_ONSETS = 250_000


class AudioQualityError(ValueError):
    """Raised when an input cannot produce a meaningful quality measurement."""


@dataclass(frozen=True)
class DetectionResult:
    spec: WavSpec
    channel: Channel
    trigger_threshold: float
    release_threshold: float
    baseline_amplitude: float
    peak_amplitude: float
    min_separation_ms: float
    onsets_ms: tuple[float, ...]

    def to_json(self) -> dict[str, Any]:
        return {
            "channel": channel_label(self.channel),
            "triggerThreshold": _rounded(self.trigger_threshold),
            "releaseThreshold": _rounded(self.release_threshold),
            "baselineAmplitude": _rounded(self.baseline_amplitude),
            "peakAmplitude": _rounded(self.peak_amplitude),
            "minSeparationMs": _rounded(self.min_separation_ms),
            "onsetCount": len(self.onsets_ms),
            "firstOnsetMs": _rounded(self.onsets_ms[0]) if self.onsets_ms else None,
            "lastOnsetMs": _rounded(self.onsets_ms[-1]) if self.onsets_ms else None,
        }


def detect_clicks(
    path: str | Path,
    *,
    channel: Channel = 0,
    threshold: float | None = None,
    min_separation_ms: float = 50.0,
    block_frames: int = 65_536,
) -> DetectionResult:
    """Detect rising click events with a two-pass, bounded-memory scan."""

    if threshold is not None and (
        not math.isfinite(threshold) or not 0 < threshold <= 1
    ):
        raise AudioQualityError("threshold must be greater than 0 and at most 1")
    if not math.isfinite(min_separation_ms) or min_separation_ms <= 0:
        raise AudioQualityError("min_separation_ms must be greater than 0")
    if block_frames < 1:
        raise AudioQualityError("block_frames must be at least 1")

    spec = read_wav_spec(path)
    theoretical_onset_limit = (
        math.ceil(spec.duration_seconds * 1_000 / min_separation_ms) + 1
    )
    if theoretical_onset_limit > _MAX_STORED_ONSETS:
        raise AudioQualityError(
            "min_separation_ms is too small for this recording duration; "
            f"the theoretical {_MAX_STORED_ONSETS:,}-onset memory limit would be exceeded"
        )
    peak, baseline = _scan_levels(path, channel, block_frames)
    if peak <= 1e-12:
        raise AudioQualityError("WAV contains no non-silent samples")

    trigger = threshold
    if trigger is None:
        trigger = max(peak * 0.1, baseline + (peak - baseline) * 0.35)
    if trigger > peak:
        raise AudioQualityError(
            f"threshold {trigger:.6f} exceeds the observed peak amplitude {peak:.6f}"
        )
    release = (
        baseline + (trigger - baseline) * 0.1 if trigger > baseline else trigger * 0.5
    )
    refractory_frames = max(1, math.ceil(min_separation_ms * spec.sample_rate / 1_000))
    onsets: list[float] = []
    last_trigger = -refractory_frames
    armed = True

    for sample_index, magnitude in enumerate(
        iter_magnitudes(path, channel, block_frames=block_frames)
    ):
        if armed:
            if magnitude >= trigger:
                if sample_index - last_trigger >= refractory_frames:
                    onsets.append(sample_index * 1_000 / spec.sample_rate)
                    last_trigger = sample_index
                armed = False
        elif magnitude <= release:
            armed = True

    return DetectionResult(
        spec=spec,
        channel=channel,
        trigger_threshold=trigger,
        release_threshold=release,
        baseline_amplitude=baseline,
        peak_amplitude=peak,
        min_separation_ms=min_separation_ms,
        onsets_ms=tuple(onsets),
    )


def analyze_click_intervals(
    path: str | Path,
    *,
    channel: Channel = 0,
    threshold: float | None = None,
    min_separation_ms: float = 50.0,
    expected_interval_ms: float | None = None,
    max_rms_jitter_ms: float | None = None,
    max_abs_drift_ms: float | None = None,
    block_frames: int = 65_536,
) -> dict[str, Any]:
    """Return interval, jitter, and drift statistics for a recorded click track."""

    if expected_interval_ms is not None and (
        not math.isfinite(expected_interval_ms) or expected_interval_ms <= 0
    ):
        raise AudioQualityError("expected_interval_ms must be greater than 0")
    _validate_non_negative_limit("max_rms_jitter_ms", max_rms_jitter_ms)
    _validate_non_negative_limit("max_abs_drift_ms", max_abs_drift_ms)

    detection = detect_clicks(
        path,
        channel=channel,
        threshold=threshold,
        min_separation_ms=min_separation_ms,
        block_frames=block_frames,
    )
    onsets = detection.onsets_ms
    if len(onsets) < 2:
        raise AudioQualityError(
            f"at least 2 click onsets are required; detected {len(onsets)}"
        )

    intervals = [right - left for left, right in pairwise(onsets)]
    observed_median = median(intervals)
    nominal = (
        expected_interval_ms if expected_interval_ms is not None else observed_median
    )
    errors = [interval - nominal for interval in intervals]
    mean_interval = fmean(intervals)
    standard_deviation = _population_standard_deviation(intervals, mean_interval)
    rms_jitter = math.sqrt(fmean(error * error for error in errors))
    cumulative_drift = onsets[-1] - onsets[0] - nominal * len(intervals)
    expected_span = nominal * len(intervals)
    fitted_interval = _linear_slope_by_index(onsets)
    interval_stats: dict[str, Any] = {
        "count": len(intervals),
        "nominalIntervalMs": _rounded(nominal),
        "nominalSource": "expected"
        if expected_interval_ms is not None
        else "detected-median",
        "meanMs": _rounded(mean_interval),
        "medianMs": _rounded(observed_median),
        "minimumMs": _rounded(min(intervals)),
        "maximumMs": _rounded(max(intervals)),
        "standardDeviationMs": _rounded(standard_deviation),
        "meanErrorMs": _rounded(fmean(errors)),
        "rmsJitterMs": _rounded(rms_jitter),
        "p95AbsoluteJitterMs": _rounded(
            _percentile([abs(error) for error in errors], 0.95)
        ),
        "peakToPeakJitterMs": _rounded(max(errors) - min(errors)),
        "cumulativeDriftMs": _rounded(cumulative_drift),
        "cumulativeDriftPpm": _rounded(cumulative_drift / expected_span * 1_000_000),
        "linearFitIntervalMs": _rounded(fitted_interval),
        "linearFitDriftPpm": _rounded(
            (fitted_interval - nominal) / nominal * 1_000_000
        ),
    }
    result: dict[str, Any] = {
        "schemaVersion": 1,
        "analysis": "click-intervals",
        "input": detection.spec.to_json(),
        "detection": detection.to_json(),
        "intervals": interval_stats,
    }
    gate = _interval_quality_gate(
        rms_jitter,
        cumulative_drift,
        max_rms_jitter_ms,
        max_abs_drift_ms,
    )
    if gate is not None:
        result["qualityGate"] = gate
    return result


def analyze_device_offset(
    reference_path: str | Path,
    target_path: str | Path,
    *,
    reference_channel: Channel = 0,
    target_channel: Channel = 0,
    reference_threshold: float | None = None,
    target_threshold: float | None = None,
    min_separation_ms: float = 50.0,
    max_lag_ms: float = 500.0,
    bin_width_ms: float = 0.25,
    peak_window_ms: float = 5.0,
    max_offset_ms: float | None = None,
    block_frames: int = 65_536,
) -> dict[str, Any]:
    """Cross-correlate sparse onset impulse trains from two WAV channels."""

    _validate_non_negative_limit("max_offset_ms", max_offset_ms)
    _correlation_half_bins(max_lag_ms, bin_width_ms, peak_window_ms)
    if not math.isfinite(min_separation_ms) or min_separation_ms <= 0:
        raise AudioQualityError("min_separation_ms must be greater than 0")
    if peak_window_ms >= min_separation_ms:
        raise AudioQualityError(
            "peak_window_ms must be smaller than min_separation_ms so matched clicks are unique"
        )
    reference = detect_clicks(
        reference_path,
        channel=reference_channel,
        threshold=reference_threshold,
        min_separation_ms=min_separation_ms,
        block_frames=block_frames,
    )
    target = detect_clicks(
        target_path,
        channel=target_channel,
        threshold=target_threshold,
        min_separation_ms=min_separation_ms,
        block_frames=block_frames,
    )
    if len(reference.onsets_ms) < 2 or len(target.onsets_ms) < 2:
        raise AudioQualityError(
            "cross-correlation requires at least 2 detected onsets in each signal; "
            f"detected {len(reference.onsets_ms)} and {len(target.onsets_ms)}"
        )
    correlation = cross_correlate_onsets(
        reference.onsets_ms,
        target.onsets_ms,
        max_lag_ms=max_lag_ms,
        bin_width_ms=bin_width_ms,
        peak_window_ms=peak_window_ms,
    )
    result: dict[str, Any] = {
        "schemaVersion": 1,
        "analysis": "device-offset",
        "signConvention": "positive offsetMs means target audio occurs after reference audio",
        "reference": {
            "input": reference.spec.to_json(),
            "detection": reference.to_json(),
        },
        "target": {
            "input": target.spec.to_json(),
            "detection": target.to_json(),
        },
        "crossCorrelation": correlation,
    }
    if max_offset_ms is not None:
        offset = float(correlation["offsetMs"])
        result["qualityGate"] = {
            "criteria": {"maxAbsoluteOffsetMs": _rounded(max_offset_ms)},
            "passed": abs(offset) <= max_offset_ms,
        }
    return result


def cross_correlate_onsets(
    reference_onsets_ms: tuple[float, ...] | list[float],
    target_onsets_ms: tuple[float, ...] | list[float],
    *,
    max_lag_ms: float,
    bin_width_ms: float,
    peak_window_ms: float,
) -> dict[str, Any]:
    """Cross-correlate two sparse impulse trains without allocating full audio arrays."""

    half_bins = _correlation_half_bins(max_lag_ms, bin_width_ms, peak_window_ms)
    total_bins = half_bins * 2 + 1
    histogram = [0] * total_bins
    pair_count = 0
    for lag in _iter_lags(reference_onsets_ms, target_onsets_ms, max_lag_ms):
        index = round(lag / bin_width_ms) + half_bins
        if 0 <= index < total_bins:
            histogram[index] += 1
            pair_count += 1
    if pair_count == 0:
        raise AudioQualityError(
            "no onset pairs fall inside max_lag_ms; increase the lag or inspect detection thresholds"
        )

    radius = max(0, math.ceil((peak_window_ms / 2) / bin_width_ms))
    prefix = [0]
    for value in histogram:
        prefix.append(prefix[-1] + value)
    scores = [
        prefix[min(total_bins, index + radius + 1)] - prefix[max(0, index - radius)]
        for index in range(total_bins)
    ]
    best_index = max(
        range(total_bins),
        key=lambda index: (scores[index], histogram[index], -abs(index - half_bins)),
    )
    best_center = (best_index - half_bins) * bin_width_ms
    match_tolerance = peak_window_ms / 2 + bin_width_ms / 2
    matches: list[tuple[float, float]] = []
    for reference_ms, lag in _iter_reference_lags(
        reference_onsets_ms, target_onsets_ms, max_lag_ms
    ):
        if abs(lag - best_center) <= match_tolerance:
            matches.append((reference_ms, lag))
    if not matches:
        raise AudioQualityError("correlation peak contains no onset pairs")

    matched_lags = [lag for _, lag in matches]
    offset = median(matched_lags)
    mean_offset = fmean(matched_lags)
    deviation = _population_standard_deviation(matched_lags, mean_offset)
    exclusion = radius * 2 + 1
    second_score = max(
        (
            score
            for index, score in enumerate(scores)
            if abs(index - best_index) > exclusion
        ),
        default=0,
    )
    normalization = math.sqrt(len(reference_onsets_ms) * len(target_onsets_ms))
    reference_times = [reference_ms for reference_ms, _ in matches]
    offset_drift_ppm = _linear_slope(reference_times, matched_lags) * 1_000_000
    return {
        "method": "onset-impulse-train-normalized-cross-correlation",
        "offsetMs": _rounded(offset),
        "meanOffsetMs": _rounded(mean_offset),
        "offsetStandardDeviationMs": _rounded(deviation),
        "p95AbsoluteDeviationMs": _rounded(
            _percentile([abs(lag - offset) for lag in matched_lags], 0.95)
        ),
        "offsetDriftPpm": _rounded(offset_drift_ppm),
        "matchedClickCount": len(matches),
        "candidatePairCount": pair_count,
        "peakCorrelation": _rounded(min(1.0, scores[best_index] / normalization)),
        "secondPeakCorrelation": _rounded(min(1.0, second_score / normalization)),
        "peakMargin": _rounded(
            (scores[best_index] - second_score) / scores[best_index]
        ),
        "maxLagMs": _rounded(max_lag_ms),
        "binWidthMs": _rounded(bin_width_ms),
        "peakWindowMs": _rounded(peak_window_ms),
    }


def _scan_levels(
    path: str | Path, channel: Channel, block_frames: int
) -> tuple[float, float]:
    histogram = [0] * _LEVEL_HISTOGRAM_BINS
    peak = 0.0
    sample_count = 0
    for magnitude in iter_magnitudes(path, channel, block_frames=block_frames):
        peak = max(peak, magnitude)
        index = min(_LEVEL_HISTOGRAM_BINS - 1, int(magnitude * _LEVEL_HISTOGRAM_BINS))
        histogram[index] += 1
        sample_count += 1
    if sample_count == 0:
        raise AudioQualityError("WAV contains no audio frames")
    midpoint = (sample_count - 1) // 2
    cumulative = 0
    baseline_index = 0
    for index, count in enumerate(histogram):
        cumulative += count
        if cumulative > midpoint:
            baseline_index = index
            break
    baseline = baseline_index / (_LEVEL_HISTOGRAM_BINS - 1)
    return peak, baseline


def _iter_lags(
    reference_onsets_ms: tuple[float, ...] | list[float],
    target_onsets_ms: tuple[float, ...] | list[float],
    max_lag_ms: float,
) -> Iterator[float]:
    for _, lag in _iter_reference_lags(
        reference_onsets_ms, target_onsets_ms, max_lag_ms
    ):
        yield lag


def _iter_reference_lags(
    reference_onsets_ms: tuple[float, ...] | list[float],
    target_onsets_ms: tuple[float, ...] | list[float],
    max_lag_ms: float,
) -> Iterator[tuple[float, float]]:
    left = 0
    for reference_ms in reference_onsets_ms:
        lower = reference_ms - max_lag_ms
        upper = reference_ms + max_lag_ms
        while left < len(target_onsets_ms) and target_onsets_ms[left] < lower:
            left += 1
        index = left
        while index < len(target_onsets_ms) and target_onsets_ms[index] <= upper:
            yield reference_ms, target_onsets_ms[index] - reference_ms
            index += 1


def _interval_quality_gate(
    rms_jitter_ms: float,
    cumulative_drift_ms: float,
    max_rms_jitter_ms: float | None,
    max_abs_drift_ms: float | None,
) -> dict[str, Any] | None:
    criteria: dict[str, float] = {}
    checks: list[bool] = []
    if max_rms_jitter_ms is not None:
        criteria["maxRmsJitterMs"] = _rounded(max_rms_jitter_ms)
        checks.append(rms_jitter_ms <= max_rms_jitter_ms)
    if max_abs_drift_ms is not None:
        criteria["maxAbsoluteDriftMs"] = _rounded(max_abs_drift_ms)
        checks.append(abs(cumulative_drift_ms) <= max_abs_drift_ms)
    if not checks:
        return None
    return {"criteria": criteria, "passed": all(checks)}


def _correlation_half_bins(
    max_lag_ms: float,
    bin_width_ms: float,
    peak_window_ms: float,
) -> int:
    if not math.isfinite(max_lag_ms) or max_lag_ms <= 0:
        raise AudioQualityError("max_lag_ms must be greater than 0")
    if not math.isfinite(bin_width_ms) or bin_width_ms <= 0:
        raise AudioQualityError("bin_width_ms must be greater than 0")
    if not math.isfinite(peak_window_ms) or not 0 < peak_window_ms < max_lag_ms * 2:
        raise AudioQualityError(
            "peak_window_ms must be greater than 0 and less than 2 * max_lag_ms"
        )
    half_bins = math.ceil(max_lag_ms / bin_width_ms)
    total_bins = half_bins * 2 + 1
    if total_bins > _MAX_CORRELATION_BINS:
        raise AudioQualityError(
            f"correlation would require {total_bins} bins; increase bin_width_ms or reduce max_lag_ms"
        )
    return half_bins


def _validate_non_negative_limit(name: str, value: float | None) -> None:
    if value is not None and (not math.isfinite(value) or value < 0):
        raise AudioQualityError(f"{name} must be non-negative")


def _population_standard_deviation(values: list[float], mean: float) -> float:
    return math.sqrt(fmean((value - mean) ** 2 for value in values))


def _percentile(values: list[float], probability: float) -> float:
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def _linear_slope_by_index(values: tuple[float, ...]) -> float:
    return _linear_slope(list(range(len(values))), list(values))


def _linear_slope(x_values: list[float] | list[int], y_values: list[float]) -> float:
    if len(x_values) < 2:
        return 0.0
    mean_x = fmean(x_values)
    mean_y = fmean(y_values)
    denominator = sum((value - mean_x) ** 2 for value in x_values)
    if denominator == 0:
        return 0.0
    return (
        sum(
            (x_value - mean_x) * (y_value - mean_y)
            for x_value, y_value in zip(x_values, y_values, strict=True)
        )
        / denominator
    )


def _rounded(value: float, digits: int = 6) -> float:
    rounded = round(value, digits)
    return 0.0 if rounded == 0 else rounded
