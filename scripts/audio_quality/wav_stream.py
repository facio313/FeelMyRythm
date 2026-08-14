"""Bounded-memory PCM WAV decoding.

The standard-library :mod:`wave` module owns container parsing. This module only
decodes complete PCM frames returned by it and never materializes the full WAV.
"""

from __future__ import annotations

import sys
import wave
from array import array
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

_MAX_BLOCK_BYTES = 8 * 1024 * 1024


class WavFormatError(ValueError):
    """Raised when a WAV cannot be analyzed as integer PCM."""


@dataclass(frozen=True)
class WavSpec:
    path: Path
    sample_rate: int
    channels: int
    sample_width_bytes: int
    frame_count: int

    @property
    def duration_seconds(self) -> float:
        return self.frame_count / self.sample_rate

    def to_json(self) -> dict[str, object]:
        return {
            "path": str(self.path),
            "sampleRateHz": self.sample_rate,
            "channels": self.channels,
            "sampleWidthBits": self.sample_width_bytes * 8,
            "frameCount": self.frame_count,
            "durationSeconds": round(self.duration_seconds, 6),
        }


Channel = int | None
"""Zero-based channel index, or ``None`` to use the maximum magnitude per frame."""


def parse_channel(value: str) -> Channel:
    """Parse a user-facing one-based channel number or ``mix``."""

    if value.lower() == "mix":
        return None
    try:
        channel = int(value)
    except ValueError as exc:
        raise ValueError("channel must be 'mix' or a one-based integer") from exc
    if channel < 1:
        raise ValueError("channel numbers start at 1")
    return channel - 1


def channel_label(channel: Channel) -> str | int:
    return "mix" if channel is None else channel + 1


def read_wav_spec(path: str | Path) -> WavSpec:
    wav_path = Path(path)
    try:
        with wave.open(str(wav_path), "rb") as reader:
            spec = _spec_from_reader(wav_path, reader)
    except (EOFError, wave.Error) as exc:
        raise WavFormatError(f"invalid WAV file: {wav_path}: {exc}") from exc
    return spec


def iter_magnitudes(
    path: str | Path,
    channel: Channel,
    *,
    block_frames: int = 65_536,
) -> Iterator[float]:
    """Yield normalized sample magnitudes while reading at most one block at a time."""

    if block_frames < 1:
        raise ValueError("block_frames must be at least 1")
    wav_path = Path(path)
    try:
        with wave.open(str(wav_path), "rb") as reader:
            spec = _spec_from_reader(wav_path, reader)
            _validate_channel(channel, spec.channels)
            scale = float(1 << (spec.sample_width_bytes * 8 - 1))
            frame_width = spec.channels * spec.sample_width_bytes
            effective_block_frames = min(
                block_frames,
                max(1, _MAX_BLOCK_BYTES // frame_width),
            )
            while raw := reader.readframes(effective_block_frames):
                values = _decode_pcm(raw, spec.sample_width_bytes)
                if channel is None:
                    yield from _mixed_magnitudes(values, spec.channels, scale)
                else:
                    yield from _channel_magnitudes(
                        values, spec.channels, channel, scale
                    )
    except (EOFError, wave.Error) as exc:
        raise WavFormatError(f"invalid WAV file: {wav_path}: {exc}") from exc


def _spec_from_reader(path: Path, reader: wave.Wave_read) -> WavSpec:
    if reader.getcomptype() != "NONE":
        raise WavFormatError(
            f"unsupported WAV compression {reader.getcomptype()!r}; integer PCM is required"
        )
    sample_width = reader.getsampwidth()
    if sample_width not in (1, 2, 3, 4):
        raise WavFormatError(
            f"unsupported PCM sample width {sample_width * 8} bits; use 8, 16, 24, or 32 bits"
        )
    sample_rate = reader.getframerate()
    channels = reader.getnchannels()
    if sample_rate < 1 or channels < 1:
        raise WavFormatError(
            "WAV must have a positive sample rate and at least one channel"
        )
    return WavSpec(
        path=path,
        sample_rate=sample_rate,
        channels=channels,
        sample_width_bytes=sample_width,
        frame_count=reader.getnframes(),
    )


def _validate_channel(channel: Channel, channels: int) -> None:
    if channel is not None and not 0 <= channel < channels:
        raise WavFormatError(
            f"channel {channel + 1} does not exist; WAV contains {channels} channel(s)"
        )


def _decode_pcm(raw: bytes, sample_width: int) -> Iterator[int] | array[int]:
    if sample_width == 1:
        return (value - 128 for value in raw)
    if sample_width == 2:
        values = array("h")
        values.frombytes(raw)
        if sys.byteorder != "little":
            values.byteswap()
        return values
    if sample_width == 4:
        values = array("i")
        values.frombytes(raw)
        if sys.byteorder != "little":
            values.byteswap()
        return values
    return _decode_pcm24(raw)


def _decode_pcm24(raw: bytes) -> Iterator[int]:
    view = memoryview(raw)
    for offset in range(0, len(view), 3):
        value = view[offset] | (view[offset + 1] << 8) | (view[offset + 2] << 16)
        if value & 0x80_0000:
            value -= 0x100_0000
        yield value


def _channel_magnitudes(
    values: Iterator[int] | array[int],
    channels: int,
    channel: int,
    scale: float,
) -> Iterator[float]:
    for index, value in enumerate(values):
        if index % channels == channel:
            yield abs(value) / scale


def _mixed_magnitudes(
    values: Iterator[int] | array[int],
    channels: int,
    scale: float,
) -> Iterator[float]:
    iterator = iter(values)
    while True:
        peak = 0
        try:
            for _ in range(channels):
                peak = max(peak, abs(next(iterator)))
        except StopIteration:
            return
        yield peak / scale
