"""CLI for click onset interval, jitter, and drift measurement."""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections.abc import Sequence
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from scripts.audio_quality.analysis import AudioQualityError, analyze_click_intervals
from scripts.audio_quality.wav_stream import WavFormatError, parse_channel


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Detect PCM WAV click onsets and print interval drift/jitter statistics as JSON."
    )
    parser.add_argument("wav", type=Path, help="PCM WAV recording to analyze")
    parser.add_argument(
        "--channel",
        default="1",
        metavar="N|mix",
        help="one-based channel number, or max-magnitude mix (default: 1)",
    )
    expected = parser.add_mutually_exclusive_group()
    expected.add_argument(
        "--bpm", type=_positive_float, help="expected quarter-note BPM"
    )
    expected.add_argument(
        "--expected-interval-ms",
        type=_positive_float,
        help="expected interval between adjacent recorded clicks",
    )
    parser.add_argument(
        "--threshold",
        type=_unit_float,
        help="fixed normalized onset threshold; default derives it from the recording",
    )
    parser.add_argument(
        "--min-separation-ms",
        type=_positive_float,
        default=50.0,
        help="refractory interval that suppresses duplicate transients (default: 50)",
    )
    parser.add_argument(
        "--max-rms-jitter-ms",
        type=_non_negative_float,
        help="optional acceptance limit; a failure exits with status 2",
    )
    parser.add_argument(
        "--max-abs-drift-ms",
        type=_non_negative_float,
        help="optional cumulative drift acceptance limit; a failure exits with status 2",
    )
    parser.add_argument(
        "--phase4",
        action="store_true",
        help="apply the 1 ms RMS jitter gate when --max-rms-jitter-ms is omitted",
    )
    parser.add_argument(
        "--block-frames",
        type=_positive_int,
        default=65_536,
        help="streaming decoder block size (default: 65536)",
    )
    parser.add_argument("--pretty", action="store_true", help="indent JSON output")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    expected_interval_ms = args.expected_interval_ms
    if args.bpm is not None:
        expected_interval_ms = 60_000 / args.bpm
    max_rms_jitter_ms = args.max_rms_jitter_ms
    if max_rms_jitter_ms is None and args.phase4:
        max_rms_jitter_ms = 1.0
    try:
        result = analyze_click_intervals(
            args.wav,
            channel=parse_channel(args.channel),
            threshold=args.threshold,
            min_separation_ms=args.min_separation_ms,
            expected_interval_ms=expected_interval_ms,
            max_rms_jitter_ms=max_rms_jitter_ms,
            max_abs_drift_ms=args.max_abs_drift_ms,
            block_frames=args.block_frames,
        )
    except (AudioQualityError, WavFormatError, OSError, ValueError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(
        json.dumps(
            result,
            ensure_ascii=False,
            allow_nan=False,
            indent=2 if args.pretty else None,
            sort_keys=True,
        )
    )
    gate = result.get("qualityGate")
    return 2 if isinstance(gate, dict) and gate.get("passed") is False else 0


def _positive_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0:
        raise argparse.ArgumentTypeError("value must be greater than 0")
    return parsed


def _non_negative_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < 0:
        raise argparse.ArgumentTypeError("value must be non-negative")
    return parsed


def _unit_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or not 0 < parsed <= 1:
        raise argparse.ArgumentTypeError(
            "threshold must be greater than 0 and at most 1"
        )
    return parsed


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("value must be at least 1")
    return parsed


if __name__ == "__main__":
    raise SystemExit(main())
