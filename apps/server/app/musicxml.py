from __future__ import annotations

import io
import math
import re
import zipfile
from dataclasses import dataclass, replace
from typing import Any

from defusedxml import ElementTree as DefusedET

DEFAULT_QUARTER_BPM = 100.0
MAX_REPEAT_TIMES = 1_000

NOTE_VALUE_QUARTERS = {
    "whole": 4.0,
    "dottedWhole": 6.0,
    "half": 2.0,
    "dottedHalf": 3.0,
    "quarter": 1.0,
    "dottedQuarter": 1.5,
    "eighth": 0.5,
    "dottedEighth": 0.75,
    "sixteenth": 0.25,
    "dottedSixteenth": 0.375,
    "thirtySecond": 0.125,
}
SIMPLE_BEAT_UNITS = {
    1: "whole",
    2: "half",
    4: "quarter",
    8: "eighth",
    16: "sixteenth",
    32: "thirtySecond",
}
COMPOUND_BEAT_UNITS = {
    2: "dottedWhole",
    4: "dottedHalf",
    8: "dottedQuarter",
    16: "dottedEighth",
    32: "dottedSixteenth",
}
MUSICXML_BEAT_UNITS = {
    "whole": ("whole", 4.0),
    "half": ("half", 2.0),
    "quarter": ("quarter", 1.0),
    "eighth": ("eighth", 0.5),
    "16th": ("sixteenth", 0.25),
    "sixteenth": ("sixteenth", 0.25),
    "32nd": ("thirtySecond", 0.125),
    "thirty-second": ("thirtySecond", 0.125),
}
DOTTED_NOTE_VALUES = {
    "whole": "dottedWhole",
    "half": "dottedHalf",
    "quarter": "dottedQuarter",
    "eighth": "dottedEighth",
    "sixteenth": "dottedSixteenth",
}


@dataclass(frozen=True)
class MeasureState:
    beats: int = 4
    beat_type: int = 4
    quarter_bpm: float = DEFAULT_QUARTER_BPM
    beat_unit: str = "quarter"

    @property
    def bpm(self) -> float:
        return self.quarter_bpm / NOTE_VALUE_QUARTERS[self.beat_unit]


@dataclass(frozen=True)
class MeasureView:
    container: Any
    content: Any


@dataclass
class RepeatRecord:
    start_measure: int
    end_measure: int
    times: int
    endings: list[dict[str, Any]]


@dataclass(frozen=True)
class VoltaRecord:
    start_measure: int
    end_measure: int
    for_pass: tuple[int, ...]


@dataclass(frozen=True)
class Marker:
    name: str
    measure: int


@dataclass(frozen=True)
class NavigationCommand:
    kind: str
    at_measure: int
    target_name: str | None = None
    al_fine: bool = False
    al_coda: bool = False


@dataclass(frozen=True)
class TempoCandidate:
    quarter_bpm: float
    beat_unit: str | None
    source: str


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _elements(element: Any, name: str) -> list[Any]:
    return [child for child in element.iter() if _local(child.tag) == name]


def _direct(element: Any, name: str) -> list[Any]:
    return [child for child in list(element) if _local(child.tag) == name]


def _first_text(element: Any, name: str) -> str | None:
    for child in element.iter():
        if _local(child.tag) == name and child.text and str(child.text).strip():
            return str(child.text).strip()
    return None


def _warn(warnings: list[str], message: str) -> None:
    if message not in warnings:
        warnings.append(message)


def _extract_xml(content: bytes, filename: str, max_bytes: int) -> bytes:
    if len(content) > max_bytes:
        raise ValueError("MusicXML file exceeds upload limit")
    if filename.casefold().endswith(".mxl"):
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            candidates = [
                item
                for item in archive.infolist()
                if not item.is_dir()
                and not item.filename.startswith("META-INF/")
                and item.filename.casefold().endswith((".xml", ".musicxml"))
            ]
            if not candidates:
                raise ValueError("MXL archive does not contain MusicXML")
            entry = candidates[0]
            if entry.file_size > max_bytes or (entry.compress_size == 0 and entry.file_size > 0):
                raise ValueError("unsafe MXL entry")
            if entry.compress_size and entry.file_size / entry.compress_size > 100:
                raise ValueError("MXL compression ratio is too high")
            return archive.read(entry)
    return content


def _measure_views(root: Any, warnings: list[str]) -> list[MeasureView]:
    if _local(root.tag) == "score-partwise":
        parts = _direct(root, "part")
        if not parts:
            raise ValueError("MusicXML document has no part")
        measures = [child for child in list(parts[0]) if _local(child.tag) == "measure"]
        counts = [len(_direct(part, "measure")) for part in parts]
        if any(count != len(measures) for count in counts[1:]):
            _warn(warnings, "parts contain different measure counts; the first part was used")
        return [MeasureView(measure, measure) for measure in measures]

    measures = _direct(root, "measure")
    if not measures:
        return []
    first_parts = _direct(measures[0], "part")
    if not first_parts:
        raise ValueError("MusicXML timewise score has no part")
    part_id = str(first_parts[0].attrib.get("id", ""))
    result: list[MeasureView] = []
    for number, measure in enumerate(measures, start=1):
        parts = _direct(measure, "part")
        selected = next(
            (part for part in parts if str(part.attrib.get("id", "")) == part_id),
            parts[0] if parts else None,
        )
        if selected is None:
            _warn(warnings, f"measure {number}: primary part is missing")
            continue
        result.append(MeasureView(measure, selected))
    return result


def _parse_meter(
    measure: MeasureView,
    number: int,
    current: MeasureState,
    warnings: list[str],
) -> MeasureState:
    time_elements = _elements(measure.content, "time")
    if not time_elements:
        return current
    if len(time_elements) > 1:
        _warn(warnings, f"measure {number}: multiple staff meters are unsupported; first used")
    time_element = time_elements[0]
    beats_values = [str(item.text or "").strip() for item in _direct(time_element, "beats")]
    beat_types = [str(item.text or "").strip() for item in _direct(time_element, "beat-type")]
    if len(beats_values) != 1 or len(beat_types) != 1:
        _warn(warnings, f"measure {number}: alternating or missing meter ignored")
        return current
    try:
        additive = [int(token.strip()) for token in beats_values[0].split("+")]
        beats = sum(additive)
        beat_type = int(beat_types[0])
    except ValueError:
        _warn(warnings, f"measure {number}: invalid time signature ignored")
        return current
    if any(value <= 0 for value in additive) or beats <= 0 or beat_type <= 0:
        _warn(warnings, f"measure {number}: invalid time signature ignored")
        return current
    if beat_type & (beat_type - 1):
        _warn(warnings, f"measure {number}: non-power-of-two meter ignored")
        return current
    beat_unit = _default_beat_unit(beats, beat_type)
    if beat_unit is None:
        _warn(warnings, f"measure {number}: meter denominator {beat_type} is unsupported")
        return current
    if len(additive) > 1:
        _warn(
            warnings,
            f"measure {number}: additive meter grouping flattened to {beats}/{beat_type}",
        )
    return MeasureState(beats, beat_type, current.quarter_bpm, beat_unit)


def _default_beat_unit(beats: int, beat_type: int) -> str | None:
    if beats >= 6 and beats % 3 == 0:
        return COMPOUND_BEAT_UNITS.get(beat_type)
    return SIMPLE_BEAT_UNITS.get(beat_type)


def _beat_count(state: MeasureState, beat_unit: str | None = None) -> float:
    unit = beat_unit or state.beat_unit
    return state.beats * (4 / state.beat_type) / NOTE_VALUE_QUARTERS[unit]


def _compatible_beat_unit(state: MeasureState, beat_unit: str) -> bool:
    count = _beat_count(state, beat_unit)
    return math.isfinite(count) and count > 0 and math.isclose(count, round(count), abs_tol=1e-9)


def _metronome_candidate(
    metronome: Any,
    number: int,
    warnings: list[str],
) -> TempoCandidate | None:
    per_minute = _first_text(metronome, "per-minute")
    unit_text = _first_text(metronome, "beat-unit")
    if per_minute is None or unit_text is None:
        _warn(warnings, f"measure {number}: incomplete metronome marking ignored")
        return None
    try:
        per_minute_value = float(per_minute)
    except ValueError:
        _warn(warnings, f"measure {number}: invalid metronome tempo ignored")
        return None
    if not math.isfinite(per_minute_value) or per_minute_value <= 0:
        _warn(warnings, f"measure {number}: invalid metronome tempo ignored")
        return None
    parsed = MUSICXML_BEAT_UNITS.get(unit_text.casefold())
    if parsed is None:
        _warn(warnings, f"measure {number}: metronome beat-unit {unit_text!r} is unsupported")
        return None
    parsed_beat_unit, quarter_length = parsed
    beat_unit: str | None = parsed_beat_unit
    dot_count = len(_elements(metronome, "beat-unit-dot"))
    if dot_count:
        quarter_length *= 2 - 1 / (2**dot_count)
        if dot_count == 1 and beat_unit in DOTTED_NOTE_VALUES:
            beat_unit = DOTTED_NOTE_VALUES[beat_unit]
        else:
            _warn(
                warnings,
                f"measure {number}: multiply-dotted metronome unit converted to quarter tempo",
            )
            beat_unit = None
    return TempoCandidate(per_minute_value * quarter_length, beat_unit, "metronome")


def _sound_tempo_candidate(sound: Any, number: int, warnings: list[str]) -> TempoCandidate | None:
    raw = sound.attrib.get("tempo")
    if raw is None:
        return None
    try:
        value = float(raw)
    except ValueError:
        _warn(warnings, f"measure {number}: invalid sound tempo ignored")
        return None
    if not math.isfinite(value) or value <= 0:
        _warn(warnings, f"measure {number}: invalid sound tempo ignored")
        return None
    return TempoCandidate(value, None, "sound")


def _parse_tempo(
    measure: MeasureView,
    number: int,
    current: MeasureState,
    warnings: list[str],
) -> tuple[MeasureState, bool]:
    candidates: list[TempoCandidate] = []
    seen_sounds: set[int] = set()
    directions = _direct(measure.content, "direction")
    for direction in directions:
        offset = _first_text(direction, "offset")
        if offset is not None:
            try:
                if not math.isclose(float(offset), 0, abs_tol=1e-9):
                    _warn(
                        warnings,
                        f"measure {number}: mid-measure tempo/navigation offset applied at boundary",
                    )
            except ValueError:
                _warn(warnings, f"measure {number}: invalid direction offset ignored")
        sound_candidates: list[TempoCandidate] = []
        for sound in _elements(direction, "sound"):
            seen_sounds.add(id(sound))
            candidate = _sound_tempo_candidate(sound, number, warnings)
            if candidate is not None:
                sound_candidates.append(candidate)
        metronome_candidates = [
            candidate
            for metronome in _elements(direction, "metronome")
            for candidate in [_metronome_candidate(metronome, number, warnings)]
            if candidate is not None
        ]
        if len(sound_candidates) > 1 or len(metronome_candidates) > 1:
            _warn(warnings, f"measure {number}: multiple tempo marks reduced to one boundary tempo")
        sound_candidate = sound_candidates[0] if sound_candidates else None
        metronome_candidate = metronome_candidates[0] if metronome_candidates else None
        if sound_candidate is not None and metronome_candidate is not None:
            if not math.isclose(
                sound_candidate.quarter_bpm,
                metronome_candidate.quarter_bpm,
                rel_tol=0.005,
                abs_tol=0.1,
            ):
                _warn(
                    warnings,
                    f"measure {number}: sound and metronome tempos disagree; sound tempo used",
                )
            candidates.append(
                TempoCandidate(
                    sound_candidate.quarter_bpm,
                    metronome_candidate.beat_unit,
                    "sound+metronome",
                )
            )
        elif sound_candidate is not None:
            candidates.append(sound_candidate)
        elif metronome_candidate is not None:
            candidates.append(metronome_candidate)

    for sound in _elements(measure.content, "sound"):
        if id(sound) in seen_sounds:
            continue
        candidate = _sound_tempo_candidate(sound, number, warnings)
        if candidate is not None:
            candidates.append(candidate)
    unique_tempos = {(round(candidate.quarter_bpm, 9), candidate.beat_unit) for candidate in candidates}
    if len(unique_tempos) > 1:
        _warn(warnings, f"measure {number}: multiple tempo changes cannot be represented; first used")
    if not candidates:
        words = " ".join(
            str(word.text or "") for direction in directions for word in _elements(direction, "words")
        ).casefold()
        if "rit" in words or "rall" in words or "accel" in words:
            _warn(warnings, f"measure {number}: textual tempo ramp requires an explicit target tempo")
        return current, False
    selected = candidates[0]
    beat_unit = current.beat_unit
    if selected.beat_unit is not None:
        if _compatible_beat_unit(current, selected.beat_unit):
            beat_unit = selected.beat_unit
        else:
            _warn(
                warnings,
                f"measure {number}: metronome beat-unit does not divide the meter; meter beat used",
            )
    resolved_bpm = selected.quarter_bpm / NOTE_VALUE_QUARTERS[beat_unit]
    if not math.isfinite(resolved_bpm):
        _warn(warnings, f"measure {number}: tempo exceeds the supported numeric range; ignored")
        return current, False
    return replace(current, quarter_bpm=selected.quarter_bpm, beat_unit=beat_unit), True


def _parse_divisions(
    measure: MeasureView,
    number: int,
    current: int | None,
    warnings: list[str],
) -> int | None:
    raw = _first_text(measure.content, "divisions")
    if raw is None:
        return current
    try:
        value = int(raw)
    except ValueError:
        _warn(warnings, f"measure {number}: invalid divisions ignored")
        return current
    if value <= 0:
        _warn(warnings, f"measure {number}: invalid divisions ignored")
        return current
    return value


def _measure_duration_quarters(
    measure: MeasureView,
    divisions: int | None,
    number: int,
    warnings: list[str],
) -> float | None:
    if divisions is None:
        if _elements(measure.content, "duration"):
            _warn(warnings, f"measure {number}: duration has no divisions; pickup not inferred")
        return None
    cursor = 0.0
    last_onset = 0.0
    maximum = 0.0
    saw_duration = False
    for element in list(measure.content):
        name = _local(element.tag)
        if name not in {"note", "backup", "forward"}:
            continue
        raw = _first_text(element, "duration")
        if raw is None:
            continue
        try:
            duration = float(raw) / divisions
        except ValueError:
            _warn(warnings, f"measure {number}: invalid note duration ignored")
            continue
        if not math.isfinite(duration) or duration < 0:
            _warn(warnings, f"measure {number}: invalid note duration ignored")
            continue
        saw_duration = True
        if name == "backup":
            cursor = max(0.0, cursor - duration)
        elif name == "forward":
            cursor += duration
            maximum = max(maximum, cursor)
        elif _elements(element, "chord"):
            maximum = max(maximum, last_onset + duration)
        else:
            last_onset = cursor
            cursor += duration
            maximum = max(maximum, cursor)
    return maximum if saw_duration else None


def _pickup_for_first_measure(
    measure: MeasureView,
    state: MeasureState,
    divisions: int | None,
    warnings: list[str],
) -> dict[str, int] | None:
    implicit = str(measure.container.attrib.get("implicit", "no")).casefold() == "yes"
    duration = _measure_duration_quarters(measure, divisions, 1, warnings)
    nominal = state.beats * (4 / state.beat_type)
    if not implicit:
        if duration is not None and duration + 1e-9 < nominal:
            _warn(warnings, "measure 1: short measure lacks implicit='yes'; pickup not inferred")
        return None
    if duration is None or duration <= 0:
        _warn(warnings, "measure 1: implicit pickup duration could not be determined")
        return None
    if duration + 1e-9 >= nominal:
        _warn(warnings, "measure 1: implicit measure is not shorter than its meter; pickup omitted")
        return None
    beats = duration / NOTE_VALUE_QUARTERS[state.beat_unit]
    rounded = round(beats)
    if rounded < 1 or not math.isclose(beats, rounded, abs_tol=1e-9):
        _warn(
            warnings,
            "measure 1: pickup is fractional in the selected beat-unit and cannot be represented",
        )
        return None
    if rounded >= round(_beat_count(state)):
        _warn(warnings, "measure 1: pickup must be shorter than a complete measure")
        return None
    return {"beats": rounded}


def _repeat_times(element: Any, number: int, warnings: list[str]) -> int | None:
    raw = element.attrib.get("times")
    if raw is None:
        return 2
    try:
        parsed = float(raw)
    except ValueError:
        _warn(warnings, f"measure {number}: invalid repeat times; repeat ignored")
        return None
    if not math.isfinite(parsed) or not parsed.is_integer():
        _warn(warnings, f"measure {number}: non-integral repeat times; repeat ignored")
        return None
    value = int(parsed)
    if value < 2:
        _warn(warnings, f"measure {number}: repeat times below 2 has no supported repeat effect")
        return None
    if value > MAX_REPEAT_TIMES:
        _warn(warnings, f"measure {number}: repeat times exceeds safe expansion limit; ignored")
        return None
    return value


def _ending_numbers(raw: str, number: int, warnings: list[str]) -> tuple[int, ...] | None:
    result: list[int] = []
    for token in raw.split(","):
        cleaned = token.strip().rstrip(".")
        range_match = re.fullmatch(r"(\d+)\s*-\s*(\d+)", cleaned)
        if range_match:
            start, end = (int(value) for value in range_match.groups())
            if start < 1 or end < start:
                _warn(warnings, f"measure {number}: invalid volta ending number {raw!r}")
                return None
            result.extend(range(start, end + 1))
            continue
        try:
            value = int(cleaned)
        except ValueError:
            _warn(warnings, f"measure {number}: invalid volta ending number {raw!r}")
            return None
        if value < 1:
            _warn(warnings, f"measure {number}: invalid volta ending number {raw!r}")
            return None
        result.append(value)
    unique = tuple(dict.fromkeys(result))
    if not unique:
        _warn(warnings, f"measure {number}: empty volta ending ignored")
        return None
    return unique


def _collect_repeats_and_voltas(
    measures: list[MeasureView], warnings: list[str]
) -> tuple[list[dict[str, Any]], list[VoltaRecord]]:
    repeat_stack: list[int] = []
    repeats: list[RepeatRecord] = []
    voltas: list[VoltaRecord] = []
    open_volta: tuple[int, tuple[int, ...]] | None = None
    for number, measure in enumerate(measures, start=1):
        for ending in _elements(measure.content, "ending"):
            ending_type = str(ending.attrib.get("type", ""))
            if ending_type == "start":
                passes = _ending_numbers(str(ending.attrib.get("number", "")), number, warnings)
                if passes is None:
                    continue
                if open_volta is not None:
                    _warn(warnings, f"measure {number}: nested or unclosed volta ending ignored")
                open_volta = (number, passes)
            elif ending_type in {"stop", "discontinue"}:
                if open_volta is None:
                    _warn(warnings, f"measure {number}: volta ending stop has no start")
                    continue
                start, passes = open_volta
                voltas.append(VoltaRecord(start, number, passes))
                open_volta = None
            else:
                _warn(warnings, f"measure {number}: unsupported volta ending type {ending_type!r}")

        for repeat in _elements(measure.content, "repeat"):
            direction = repeat.attrib.get("direction")
            if direction == "forward":
                repeat_stack.append(number)
                continue
            if direction != "backward":
                _warn(warnings, f"measure {number}: invalid repeat direction ignored")
                continue
            times = _repeat_times(repeat, number, warnings)
            start = repeat_stack.pop() if repeat_stack else 1
            if str(repeat.attrib.get("after-jump", "no")).casefold() == "yes":
                _warn(
                    warnings,
                    f"measure {number}: conditional after-jump repeat approximated as unconditional",
                )
            if times is not None:
                repeats.append(RepeatRecord(start, number, times, []))
    if open_volta is not None:
        _warn(warnings, "unclosed volta ending ignored")
    for start in repeat_stack:
        _warn(warnings, f"measure {start}: forward repeat has no backward repeat and was ignored")
    return _attach_voltas(repeats, voltas, warnings), voltas


def _attach_voltas(
    repeats: list[RepeatRecord],
    voltas: list[VoltaRecord],
    warnings: list[str],
) -> list[dict[str, Any]]:
    for volta in voltas:
        candidates = [
            repeat
            for repeat in repeats
            if repeat.start_measure <= volta.start_measure <= repeat.end_measure + 1
            and (volta.start_measure <= repeat.end_measure or bool(repeat.endings))
        ]
        candidates.sort(key=lambda repeat: (repeat.start_measure, -repeat.end_measure), reverse=True)
        if not candidates:
            _warn(
                warnings,
                f"measures {volta.start_measure}-{volta.end_measure}: volta is outside a repeat; ignored",
            )
            continue
        repeat = candidates[0]
        valid_passes = tuple(pass_number for pass_number in volta.for_pass if pass_number <= repeat.times)
        if valid_passes != volta.for_pass:
            _warn(
                warnings,
                f"measures {volta.start_measure}-{volta.end_measure}: volta references unavailable passes",
            )
        if not valid_passes:
            continue
        if any(
            volta.start_measure <= ending["measures"][1] and ending["measures"][0] <= volta.end_measure
            for ending in repeat.endings
        ):
            _warn(
                warnings,
                f"measures {volta.start_measure}-{volta.end_measure}: overlapping volta ignored",
            )
            continue
        repeat.end_measure = max(repeat.end_measure, volta.end_measure)
        repeat.endings.append(
            {
                "measures": [volta.start_measure, volta.end_measure],
                "forPass": list(valid_passes),
            }
        )

    accepted: list[RepeatRecord] = []
    for repeat in repeats:
        conflict = next(
            (other for other in accepted if _repeat_ranges_conflict(repeat, other)),
            None,
        )
        if conflict is not None:
            _warn(
                warnings,
                f"measures {repeat.start_measure}-{repeat.end_measure}: ambiguous repeat range ignored",
            )
            continue
        accepted.append(repeat)
    return [
        {
            "type": "repeat",
            "startMeasure": repeat.start_measure,
            "endMeasure": repeat.end_measure,
            "times": repeat.times,
            **({"endings": repeat.endings} if repeat.endings else {}),
        }
        for repeat in accepted
    ]


def _repeat_ranges_conflict(left: RepeatRecord, right: RepeatRecord) -> bool:
    identical = left.start_measure == right.start_measure and left.end_measure == right.end_measure
    crosses = (
        left.start_measure < right.start_measure <= left.end_measure < right.end_measure
        or right.start_measure < left.start_measure <= right.end_measure < left.end_measure
    )
    return identical or crosses


def _canonical_words(direction: Any) -> str:
    words = " ".join(str(item.text or "") for item in _elements(direction, "words"))
    return re.sub(r"[^a-z]", "", words.casefold())


def _marker_name(value: str | None) -> str:
    cleaned = (value or "").strip()
    return "default" if not cleaned or cleaned.casefold() == "yes" else cleaned


def _add_marker(markers: list[Marker], marker: Marker) -> None:
    if marker not in markers:
        markers.append(marker)


def _add_command(commands: list[NavigationCommand], command: NavigationCommand) -> None:
    for index, existing in enumerate(commands):
        if (
            existing.kind == command.kind
            and existing.at_measure == command.at_measure
            and existing.target_name == command.target_name
        ):
            commands[index] = replace(
                existing,
                al_fine=existing.al_fine or command.al_fine,
                al_coda=existing.al_coda or command.al_coda,
            )
            return
    commands.append(command)


def _collect_navigation(
    measures: list[MeasureView], warnings: list[str]
) -> tuple[list[NavigationCommand], list[Marker], list[int], list[Marker], list[Marker]]:
    commands: list[NavigationCommand] = []
    segnos: list[Marker] = []
    fines: list[int] = []
    to_codas: list[Marker] = []
    codas: list[Marker] = []
    for number, measure in enumerate(measures, start=1):
        for direction in _direct(measure.content, "direction"):
            canonical = _canonical_words(direction)
            al_fine = "alfine" in canonical
            al_coda = "alcoda" in canonical
            semantic_command_seen = False
            semantic_marker_seen = False
            sound_segno_names = [
                _marker_name(str(sound.attrib["segno"]))
                for sound in _elements(direction, "sound")
                if "segno" in sound.attrib
            ]
            sound_coda_names = [
                _marker_name(str(sound.attrib["coda"]))
                for sound in _elements(direction, "sound")
                if "coda" in sound.attrib
            ]
            for sound in _elements(direction, "sound"):
                if "segno" in sound.attrib:
                    semantic_marker_seen = True
                    _add_marker(segnos, Marker(_marker_name(str(sound.attrib["segno"])), number))
                if "fine" in sound.attrib:
                    semantic_marker_seen = True
                    if number not in fines:
                        fines.append(number)
                if "tocoda" in sound.attrib:
                    semantic_marker_seen = True
                    _add_marker(
                        to_codas,
                        Marker(_marker_name(str(sound.attrib["tocoda"])), number),
                    )
                if "coda" in sound.attrib:
                    semantic_marker_seen = True
                    _add_marker(codas, Marker(_marker_name(str(sound.attrib["coda"])), number))

                has_dc = str(sound.attrib.get("dacapo", "no")).casefold() == "yes"
                has_ds = "dalsegno" in sound.attrib
                if not has_dc and not has_ds:
                    if str(sound.attrib.get("forward-repeat", "no")).casefold() == "yes":
                        _warn(
                            warnings,
                            f"measure {number}: sound forward-repeat is unsupported and ignored",
                        )
                    continue
                semantic_command_seen = True
                if has_dc and has_ds:
                    _warn(warnings, f"measure {number}: simultaneous D.C. and D.S. ignored")
                    continue
                if sound.attrib.get("time-only") is not None:
                    _warn(
                        warnings,
                        f"measure {number}: pass-conditional navigation is unsupported and ignored",
                    )
                    continue
                if has_dc:
                    _add_command(commands, NavigationCommand("dc", number, None, al_fine, al_coda))
                else:
                    _add_command(
                        commands,
                        NavigationCommand(
                            "ds",
                            number,
                            _marker_name(str(sound.attrib.get("dalsegno", ""))),
                            al_fine,
                            al_coda,
                        ),
                    )

            for element in _elements(direction, "segno"):
                semantic_marker_seen = True
                name = _marker_name(
                    str(element.attrib.get("id", ""))
                    or (sound_segno_names[0] if len(sound_segno_names) == 1 else "")
                )
                _add_marker(segnos, Marker(name, number))
            for element in _elements(direction, "coda"):
                semantic_marker_seen = True
                name = _marker_name(
                    str(element.attrib.get("id", ""))
                    or (sound_coda_names[0] if len(sound_coda_names) == 1 else "")
                )
                _add_marker(codas, Marker(name, number))

            if not semantic_command_seen:
                is_dc = canonical.startswith("dc") or canonical.startswith("dacapo")
                is_ds = canonical.startswith("ds") or canonical.startswith("dalsegno")
                if is_dc and is_ds:
                    _warn(warnings, f"measure {number}: ambiguous navigation words ignored")
                elif is_dc:
                    _add_command(commands, NavigationCommand("dc", number, None, al_fine, al_coda))
                elif is_ds:
                    _add_command(commands, NavigationCommand("ds", number, None, al_fine, al_coda))
                elif not semantic_marker_seen and canonical == "fine" and number not in fines:
                    fines.append(number)
                elif not semantic_marker_seen and canonical in {"tocoda", "alcoda"}:
                    _add_marker(to_codas, Marker("default", number))
                elif not semantic_marker_seen and canonical == "coda":
                    _add_marker(codas, Marker("default", number))
                elif not semantic_marker_seen and canonical == "segno":
                    _add_marker(segnos, Marker("default", number))
                elif not semantic_marker_seen and any(
                    token in canonical for token in ("dacapo", "dalsegno", "tocoda")
                ):
                    _warn(warnings, f"measure {number}: unsupported navigation words ignored")
    return commands, segnos, fines, to_codas, codas


def _resolve_marker_measure(
    markers: list[Marker],
    target_name: str | None,
    label: str,
    at_measure: int,
    warnings: list[str],
) -> int | None:
    if target_name and target_name != "default":
        candidates = {marker.measure for marker in markers if marker.name == target_name}
    else:
        candidates = {marker.measure for marker in markers}
    if len(candidates) != 1:
        _warn(
            warnings,
            f"measure {at_measure}: {label} target is missing or ambiguous; navigation ignored",
        )
        return None
    return next(iter(candidates))


def _resolve_coda_pair(
    to_codas: list[Marker], codas: list[Marker], warnings: list[str]
) -> tuple[int, int] | None:
    if len({(marker.name, marker.measure) for marker in to_codas}) != 1:
        _warn(warnings, "To Coda target is missing or ambiguous")
        return None
    trigger = to_codas[0]
    if trigger.name != "default":
        target_measures = {marker.measure for marker in codas if marker.name == trigger.name}
    else:
        target_measures = {marker.measure for marker in codas}
    if len(target_measures) != 1:
        _warn(warnings, "Coda target is missing or ambiguous")
        return None
    target = next(iter(target_measures))
    if target == trigger.measure:
        _warn(warnings, "To Coda and Coda resolve to the same measure; coda ignored")
        return None
    return trigger.measure, target


def _navigation_jumps(measures: list[MeasureView], warnings: list[str]) -> list[dict[str, Any]]:
    commands, segnos, fines, to_codas, codas = _collect_navigation(measures, warnings)
    coda_pair = _resolve_coda_pair(to_codas, codas, warnings) if to_codas or codas else None
    jumps: list[dict[str, Any]] = []
    emitted_fine = False
    emitted_coda = False
    for command in commands:
        wants_fine = command.al_fine
        wants_coda = command.al_coda
        if not wants_fine and not wants_coda and len(commands) == 1:
            if fines and coda_pair is not None:
                _warn(
                    warnings,
                    f"measure {command.at_measure}: both Fine and Coda targets are ambiguous; navigation ignored",
                )
                continue
            wants_fine = bool(fines)
            wants_coda = coda_pair is not None
        if wants_fine and wants_coda:
            _warn(
                warnings,
                f"measure {command.at_measure}: simultaneous al Fine and al Coda ignored",
            )
            continue
        jump: dict[str, Any] = {"type": command.kind, "atMeasure": command.at_measure}
        if command.kind == "ds":
            segno_measure = _resolve_marker_measure(
                segnos, command.target_name, "Segno", command.at_measure, warnings
            )
            if segno_measure is None:
                continue
            jump["segnoMeasure"] = segno_measure
        if wants_fine:
            fine_measures = set(fines)
            if len(fine_measures) != 1:
                _warn(
                    warnings,
                    f"measure {command.at_measure}: Fine target is missing or ambiguous; navigation ignored",
                )
                continue
            jump["alFine"] = next(iter(fine_measures))
            emitted_fine = True
        if wants_coda:
            if coda_pair is None:
                _warn(
                    warnings,
                    f"measure {command.at_measure}: Coda route is incomplete; navigation ignored",
                )
                continue
            jump["alCoda"] = True
            emitted_coda = True
        jumps.append(jump)
    if emitted_coda and coda_pair is not None:
        jumps.append({"type": "coda", "toCodaMeasure": coda_pair[0], "codaMeasure": coda_pair[1]})
    if fines and not emitted_fine:
        _warn(warnings, "Fine marker is not attached to a valid D.C./D.S. route and was ignored")
    if (to_codas or codas) and not emitted_coda:
        _warn(warnings, "Coda markers are not attached to a valid D.C./D.S. route and were ignored")
    if segnos and not any(jump["type"] == "ds" for jump in jumps):
        _warn(warnings, "Segno marker is not attached to a valid D.S. route and was ignored")
    return jumps


def _sections(states: list[MeasureState]) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    section_start = 1
    for index, state in enumerate(states, start=1):
        next_state = states[index] if index < len(states) else None
        if next_state != state:
            rounded_bpm = round(state.bpm, 3)
            sections.append(
                {
                    "id": f"section-{len(sections) + 1}",
                    "startMeasure": section_start,
                    "endMeasure": index,
                    "timeSignature": {"num": state.beats, "denom": state.beat_type},
                    "bpm": rounded_bpm if rounded_bpm > 0 else state.bpm,
                    "beatUnit": state.beat_unit,
                }
            )
            section_start = index + 1
    return sections


def parse_musicxml_draft(content: bytes, filename: str, max_bytes: int) -> dict[str, Any]:
    xml = _extract_xml(content, filename, max_bytes)
    try:
        root = DefusedET.fromstring(xml)
    except Exception as exc:
        raise ValueError("invalid MusicXML document") from exc
    if _local(root.tag) not in {"score-partwise", "score-timewise"}:
        raise ValueError("unsupported MusicXML root")

    title = _first_text(root, "work-title") or _first_text(root, "movement-title")
    warnings: list[str] = []
    measures = _measure_views(root, warnings)
    if not measures:
        raise ValueError("MusicXML document has no measures")

    current = MeasureState()
    states: list[MeasureState] = []
    divisions: int | None = None
    anacrusis: dict[str, int] | None = None
    saw_tempo = False
    for number, measure in enumerate(measures, start=1):
        current = _parse_meter(measure, number, current, warnings)
        current, found_tempo = _parse_tempo(measure, number, current, warnings)
        saw_tempo = saw_tempo or found_tempo
        divisions = _parse_divisions(measure, number, divisions, warnings)
        if number == 1:
            anacrusis = _pickup_for_first_measure(measure, current, divisions, warnings)
        elif str(measure.container.attrib.get("implicit", "no")).casefold() == "yes":
            _warn(
                warnings,
                f"measure {number}: non-initial implicit measure cannot be represented as anacrusis",
            )
        states.append(current)

    if not saw_tempo:
        _warn(warnings, "tempo not found; quarter=100 draft default applied")
    repeat_jumps, _ = _collect_repeats_and_voltas(measures, warnings)
    navigation_jumps = _navigation_jumps(measures, warnings)
    result: dict[str, Any] = {
        "title": title,
        "totalMeasures": len(measures),
        "sections": _sections(states),
        "jumps": [*repeat_jumps, *navigation_jumps],
        "countIn": {"measures": 1, "useSectionMeter": True},
        "warnings": warnings,
    }
    if anacrusis is not None:
        result["anacrusis"] = anacrusis
    return result
