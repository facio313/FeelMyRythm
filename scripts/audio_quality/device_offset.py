"""CLI for inter-device click offset measurement by onset cross-correlation."""

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

from scripts.audio_quality.analysis import AudioQualityError, analyze_device_offset
from scripts.audio_quality.wav_stream import WavFormatError, parse_channel


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Cross-correlate click onsets from one stereo WAV or two WAV files and print JSON."
        )
    )
    parser.add_argument(
        "wav",
        type=Path,
        nargs="+",
        help="one stereo WAV, or reference.wav followed by target.wav",
    )
    parser.add_argument(
        "--reference-channel",
        default="1",
        metavar="N|mix",
        help="reference channel (default: 1)",
    )
    parser.add_argument(
        "--target-channel",
        metavar="N|mix",
        help="target channel (default: 2 for stereo input, otherwise 1)",
    )
    parser.add_argument(
        "--reference-threshold",
        type=_unit_float,
        help="fixed normalized reference onset threshold",
    )
    parser.add_argument(
        "--target-threshold",
        type=_unit_float,
        help="fixed normalized target onset threshold",
    )
    parser.add_argument(
        "--min-separation-ms",
        type=_positive_float,
        default=50.0,
        help="refractory interval that suppresses duplicate transients (default: 50)",
    )
    parser.add_argument(
        "--max-lag-ms",
        type=_positive_float,
        default=250.0,
        help="maximum absolute offset searched by correlation (default: 250)",
    )
    parser.add_argument(
        "--bin-width-ms",
        type=_positive_float,
        default=0.25,
        help="correlation histogram resolution (default: 0.25)",
    )
    parser.add_argument(
        "--peak-window-ms",
        type=_positive_float,
        default=5.0,
        help="smoothing/matching width around the correlation peak (default: 5)",
    )
    parser.add_argument(
        "--max-offset-ms",
        type=_non_negative_float,
        help="optional acceptance limit; a failure exits with status 2",
    )
    parser.add_argument(
        "--phase4",
        action="store_true",
        help="apply the Phase 4 inter-device offset gate of 10 ms when --max-offset-ms is omitted",
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
    if len(args.wav) not in (1, 2):
        parser.error("provide one stereo WAV or exactly two WAV files")
    reference_path = args.wav[0]
    target_path = args.wav[0] if len(args.wav) == 1 else args.wav[1]
    target_channel = args.target_channel or ("2" if len(args.wav) == 1 else "1")
    max_offset_ms = args.max_offset_ms
    if max_offset_ms is None and args.phase4:
        max_offset_ms = 10.0
    try:
        result = analyze_device_offset(
            reference_path,
            target_path,
            reference_channel=parse_channel(args.reference_channel),
            target_channel=parse_channel(target_channel),
            reference_threshold=args.reference_threshold,
            target_threshold=args.target_threshold,
            min_separation_ms=args.min_separation_ms,
            max_lag_ms=args.max_lag_ms,
            bin_width_ms=args.bin_width_ms,
            peak_window_ms=args.peak_window_ms,
            max_offset_ms=max_offset_ms,
            block_frames=args.block_frames,
        )
    except (AudioQualityError, WavFormatError, OSError, ValueError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    result["inputMode"] = "stereo" if len(args.wav) == 1 else "two-mono-files"
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
