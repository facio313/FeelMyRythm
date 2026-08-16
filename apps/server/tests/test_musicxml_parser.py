from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app.musicxml import parse_musicxml_draft
from app.schemas import MusicXmlDraftOut, TempoMapData

FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "musicxml"


def _parse_fixture(name: str) -> dict[str, Any]:
    content = (FIXTURE_ROOT / name).read_bytes()
    return parse_musicxml_draft(content, name, 1_000_000)


def _validate_as_tempo_map(draft: dict[str, Any]) -> TempoMapData:
    payload = {
        "id": "fixture-map",
        "repertoireItemId": "fixture-repertoire",
        "revision": 0,
        "totalMeasures": draft["totalMeasures"],
        "sections": draft["sections"],
        "jumps": draft["jumps"],
        "countIn": draft["countIn"],
    }
    if "anacrusis" in draft:
        payload["anacrusis"] = draft["anacrusis"]
    return TempoMapData.model_validate(payload)


def test_pickup_tempo_and_meter_changes_form_valid_sections() -> None:
    draft = _parse_fixture("tempo-pickup.musicxml")

    assert draft["title"] == "Pickup Study"
    assert draft["totalMeasures"] == 4
    assert draft["anacrusis"] == {"beats": 1}
    assert draft["sections"] == [
        {
            "id": "section-1",
            "startMeasure": 1,
            "endMeasure": 2,
            "timeSignature": {"num": 4, "denom": 4},
            "bpm": 120.0,
            "beatUnit": "quarter",
        },
        {
            "id": "section-2",
            "startMeasure": 3,
            "endMeasure": 4,
            "timeSignature": {"num": 6, "denom": 8},
            "bpm": 72.0,
            "beatUnit": "dottedQuarter",
        },
    ]
    assert draft["warnings"] == []
    assert MusicXmlDraftOut.model_validate(draft).model_dump(by_alias=True)["anacrusis"] == {"beats": 1}
    _validate_as_tempo_map(draft)


def test_volta_endings_extend_the_repeat_for_each_pass() -> None:
    draft = _parse_fixture("volta.musicxml")

    assert draft["jumps"] == [
        {
            "type": "repeat",
            "startMeasure": 1,
            "endMeasure": 4,
            "times": 2,
            "endings": [
                {"measures": [3, 3], "forPass": [1]},
                {"measures": [4, 4], "forPass": [2]},
            ],
        }
    ]
    _validate_as_tempo_map(draft)


def test_da_capo_al_fine_is_mapped_to_core_navigation() -> None:
    draft = _parse_fixture("dc-al-fine.musicxml")

    assert draft["jumps"] == [{"type": "dc", "atMeasure": 6, "alFine": 3}]
    _validate_as_tempo_map(draft)


def test_dal_segno_al_coda_is_mapped_to_core_navigation() -> None:
    draft = _parse_fixture("ds-al-coda.musicxml")

    assert draft["jumps"] == [
        {
            "type": "ds",
            "atMeasure": 6,
            "segnoMeasure": 2,
            "alCoda": True,
        },
        {"type": "coda", "toCodaMeasure": 4, "codaMeasure": 7},
    ]
    _validate_as_tempo_map(draft)


def test_ambiguous_or_conditional_navigation_is_warned_and_not_guessed() -> None:
    draft = _parse_fixture("ambiguous-navigation.musicxml")

    assert draft["jumps"] == []
    warnings = "\n".join(draft["warnings"])
    assert "pass-conditional navigation is unsupported" in warnings
    assert "sound forward-repeat is unsupported" in warnings
    assert "Coda target is missing or ambiguous" in warnings
    assert "Segno target is missing or ambiguous" in warnings
    assert "Coda markers are not attached" in warnings
    assert "Segno marker is not attached" in warnings
    _validate_as_tempo_map(draft)


def test_musicxml_draft_openapi_marks_anacrusis_optional_and_nullable(
    client: TestClient,
) -> None:
    document = client.get("/openapi.json").json()
    schema = document["components"]["schemas"]["MusicXmlDraftOut"]

    assert "anacrusis" not in schema["required"]
    assert schema["properties"]["anacrusis"]["anyOf"] == [
        {"$ref": "#/components/schemas/TempoMapAnacrusis"},
        {"type": "null"},
    ]
