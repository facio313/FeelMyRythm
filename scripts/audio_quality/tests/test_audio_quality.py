from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import tracemalloc
import unittest
import wave
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from scripts.audio_quality.analysis import (
    AudioQualityError,
    analyze_click_intervals,
    analyze_device_offset,
    detect_clicks,
)


class AudioQualityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary_directory.name)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_detects_clicks_across_integer_pcm_widths_and_small_blocks(self) -> None:
        sample_rate = 8_000
        expected_onsets = [100.0, 600.0, 1_100.0, 1_600.0]
        samples = _click_track(
            sample_rate, 2.0, [value / 1_000 for value in expected_onsets]
        )

        for sample_width in (1, 2, 3, 4):
            with self.subTest(sample_width_bits=sample_width * 8):
                path = self.directory / f"clicks-{sample_width * 8}.wav"
                _write_pcm(path, sample_rate, sample_width, [samples])
                detection = detect_clicks(
                    path,
                    threshold=0.2,
                    min_separation_ms=50,
                    block_frames=127,
                )
                self.assertEqual(len(detection.onsets_ms), len(expected_onsets))
                for actual, expected in zip(
                    detection.onsets_ms, expected_onsets, strict=True
                ):
                    self.assertAlmostEqual(actual, expected, places=6)

    def test_interval_statistics_and_quality_gate(self) -> None:
        sample_rate = 8_000
        path = self.directory / "stable.wav"
        _write_pcm(
            path,
            sample_rate,
            2,
            [_click_track(sample_rate, 3.0, [0.1, 0.6, 1.1, 1.6, 2.1, 2.6])],
        )

        result = analyze_click_intervals(
            path,
            threshold=0.2,
            expected_interval_ms=500,
            max_rms_jitter_ms=0.01,
            max_abs_drift_ms=0.01,
        )

        self.assertEqual(result["intervals"]["count"], 5)
        self.assertEqual(result["intervals"]["meanMs"], 500.0)
        self.assertEqual(result["intervals"]["rmsJitterMs"], 0.0)
        self.assertEqual(result["intervals"]["cumulativeDriftMs"], 0.0)
        self.assertEqual(result["qualityGate"]["passed"], True)

    def test_reports_known_interval_jitter_and_cumulative_drift(self) -> None:
        sample_rate = 8_000
        path = self.directory / "jitter.wav"
        _write_pcm(
            path,
            sample_rate,
            2,
            [_click_track(sample_rate, 2.5, [0.1, 0.6, 1.102, 1.6, 2.101])],
        )

        result = analyze_click_intervals(path, threshold=0.2, expected_interval_ms=500)
        intervals = result["intervals"]

        self.assertEqual(intervals["cumulativeDriftMs"], 1.0)
        self.assertEqual(intervals["rmsJitterMs"], 1.5)
        self.assertEqual(intervals["peakToPeakJitterMs"], 4.0)

    def test_two_mono_cross_correlation_reports_positive_target_delay(self) -> None:
        sample_rate = 8_000
        reference_path = self.directory / "reference.wav"
        target_path = self.directory / "target.wav"
        reference_onsets = [0.2, 0.7, 1.2, 1.7, 2.2]
        delay_seconds = 0.0125
        _write_pcm(
            reference_path,
            sample_rate,
            2,
            [_click_track(sample_rate, 2.5, reference_onsets)],
        )
        _write_pcm(
            target_path,
            sample_rate,
            2,
            [
                _click_track(
                    sample_rate,
                    2.5,
                    [value + delay_seconds for value in reference_onsets],
                )
            ],
        )

        result = analyze_device_offset(
            reference_path,
            target_path,
            reference_threshold=0.2,
            target_threshold=0.2,
            max_lag_ms=100,
            bin_width_ms=0.125,
            peak_window_ms=1,
            max_offset_ms=10,
        )

        self.assertEqual(result["crossCorrelation"]["offsetMs"], 12.5)
        self.assertEqual(result["crossCorrelation"]["matchedClickCount"], 5)
        self.assertEqual(result["crossCorrelation"]["peakCorrelation"], 1.0)
        self.assertEqual(result["qualityGate"]["passed"], False)

        script = REPOSITORY_ROOT / "scripts/audio_quality/device_offset.py"
        completed = subprocess.run(
            [
                sys.executable,
                str(script),
                str(reference_path),
                str(target_path),
                "--reference-threshold",
                "0.2",
                "--target-threshold",
                "0.2",
                "--max-lag-ms",
                "100",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertEqual(payload["inputMode"], "two-mono-files")
        self.assertEqual(payload["crossCorrelation"]["offsetMs"], 12.5)

        gated = subprocess.run(
            [
                sys.executable,
                str(script),
                str(reference_path),
                str(target_path),
                "--reference-threshold",
                "0.2",
                "--target-threshold",
                "0.2",
                "--max-lag-ms",
                "100",
                "--phase4",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(gated.returncode, 2, gated.stderr)
        self.assertEqual(json.loads(gated.stdout)["qualityGate"]["passed"], False)

    def test_stereo_cross_correlation_uses_selected_channels(self) -> None:
        sample_rate = 8_000
        path = self.directory / "stereo.wav"
        reference_onsets = [0.2, 0.65, 1.1, 1.55, 2.0]
        delay_seconds = 0.008
        left = _click_track(sample_rate, 2.3, reference_onsets)
        right = _click_track(
            sample_rate,
            2.3,
            [value + delay_seconds for value in reference_onsets],
            amplitude=0.6,
        )
        _write_pcm(path, sample_rate, 3, [left, right])

        result = analyze_device_offset(
            path,
            path,
            reference_channel=0,
            target_channel=1,
            max_lag_ms=50,
            bin_width_ms=0.125,
            peak_window_ms=1,
        )

        self.assertEqual(result["crossCorrelation"]["offsetMs"], 8.0)
        self.assertEqual(result["reference"]["input"]["sampleWidthBits"], 24)
        self.assertEqual(result["target"]["detection"]["channel"], 2)

    def test_thirty_minute_wav_analysis_has_bounded_python_memory(self) -> None:
        path = self.directory / "thirty-minutes.wav"
        _write_long_click_track(path, duration_seconds=30 * 60, sample_rate=1_000)

        tracemalloc.start()
        result = analyze_click_intervals(
            path,
            threshold=0.2,
            expected_interval_ms=1_000,
            block_frames=257,
        )
        _, peak_bytes = tracemalloc.get_traced_memory()
        tracemalloc.stop()

        self.assertEqual(result["detection"]["onsetCount"], 1_800)
        self.assertEqual(result["intervals"]["cumulativeDriftMs"], 0.0)
        self.assertLess(peak_bytes, 8 * 1024 * 1024)
        with self.assertRaisesRegex(
            AudioQualityError, "theoretical 250,000-onset memory limit"
        ):
            detect_clicks(path, threshold=0.2, min_separation_ms=1)

    def test_cli_prints_machine_readable_json_and_failed_gate_uses_exit_two(
        self,
    ) -> None:
        sample_rate = 8_000
        path = self.directory / "cli.wav"
        _write_pcm(
            path,
            sample_rate,
            2,
            [_click_track(sample_rate, 2.0, [0.1, 0.6, 1.1, 1.6])],
        )
        script = REPOSITORY_ROOT / "scripts/audio_quality/click_intervals.py"

        completed = subprocess.run(
            [
                sys.executable,
                str(script),
                str(path),
                "--bpm",
                "120",
                "--threshold",
                "0.2",
                "--max-abs-drift-ms",
                "0",
            ],
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertEqual(payload["analysis"], "click-intervals")
        self.assertEqual(payload["qualityGate"]["passed"], True)

        failed = subprocess.run(
            [
                sys.executable,
                str(script),
                str(path),
                "--bpm",
                "100",
                "--threshold",
                "0.2",
                "--max-rms-jitter-ms",
                "1",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(failed.returncode, 2, failed.stderr)
        self.assertEqual(json.loads(failed.stdout)["qualityGate"]["passed"], False)

    def test_device_offset_cli_accepts_stereo_and_reports_negative_target_lead(
        self,
    ) -> None:
        sample_rate = 8_000
        path = self.directory / "cli-stereo.wav"
        reference_onsets = [0.2, 0.7, 1.2, 1.7]
        target_onsets = [value - 0.01 for value in reference_onsets]
        _write_pcm(
            path,
            sample_rate,
            2,
            [
                _click_track(sample_rate, 2.0, reference_onsets),
                _click_track(sample_rate, 2.0, target_onsets),
            ],
        )
        script = REPOSITORY_ROOT / "scripts/audio_quality/device_offset.py"

        completed = subprocess.run(
            [
                sys.executable,
                str(script),
                str(path),
                "--reference-threshold",
                "0.2",
                "--target-threshold",
                "0.2",
                "--max-lag-ms",
                "100",
                "--max-offset-ms",
                "10",
            ],
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertEqual(payload["inputMode"], "stereo")
        self.assertEqual(payload["crossCorrelation"]["offsetMs"], -10.0)
        self.assertEqual(payload["qualityGate"]["passed"], True)

    def test_silent_wav_and_excessive_correlation_grid_fail_clearly(self) -> None:
        path = self.directory / "silent.wav"
        _write_pcm(path, 8_000, 2, [[0.0] * 1_000])
        with self.assertRaisesRegex(AudioQualityError, "no non-silent samples"):
            detect_clicks(path)

        reference = self.directory / "reference.wav"
        _write_pcm(reference, 8_000, 2, [_click_track(8_000, 1.5, [0.1, 0.6, 1.1])])
        with self.assertRaisesRegex(AudioQualityError, "correlation would require"):
            analyze_device_offset(
                reference,
                reference,
                reference_channel=0,
                target_channel=0,
                max_lag_ms=2_000,
                bin_width_ms=0.001,
            )


def _click_track(
    sample_rate: int,
    duration_seconds: float,
    onsets_seconds: list[float],
    *,
    amplitude: float = 0.9,
) -> list[float]:
    samples = [0.0] * round(sample_rate * duration_seconds)
    shape = [1.0, 0.65, -0.35, 0.18]
    for onset_seconds in onsets_seconds:
        start = round(onset_seconds * sample_rate)
        for offset, multiplier in enumerate(shape):
            if start + offset < len(samples):
                samples[start + offset] = amplitude * multiplier
    return samples


def _write_pcm(
    path: Path,
    sample_rate: int,
    sample_width: int,
    channels: list[list[float]],
) -> None:
    if not channels or any(len(channel) != len(channels[0]) for channel in channels):
        raise ValueError("fixture channels must be non-empty and have equal lengths")
    encoded = bytearray()
    for frame in zip(*channels, strict=True):
        for sample in frame:
            encoded.extend(_encode_sample(sample, sample_width))
    with wave.open(str(path), "wb") as writer:
        writer.setnchannels(len(channels))
        writer.setsampwidth(sample_width)
        writer.setframerate(sample_rate)
        writer.writeframes(encoded)


def _encode_sample(sample: float, sample_width: int) -> bytes:
    sample = max(-1.0, min(1.0, sample))
    if sample_width == 1:
        return bytes([round(sample * 127) + 128])
    maximum = (1 << (sample_width * 8 - 1)) - 1
    value = round(sample * maximum)
    return value.to_bytes(sample_width, "little", signed=True)


def _write_long_click_track(
    path: Path, *, duration_seconds: int, sample_rate: int
) -> None:
    with wave.open(str(path), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        for _ in range(duration_seconds):
            block = bytearray(sample_rate * 2)
            onset = round(sample_rate * 0.1)
            for offset, multiplier in enumerate((1.0, 0.65, -0.35, 0.18)):
                encoded = _encode_sample(0.9 * multiplier, 2)
                byte_offset = (onset + offset) * 2
                block[byte_offset : byte_offset + 2] = encoded
            writer.writeframesraw(block)


if __name__ == "__main__":
    unittest.main()
