from __future__ import annotations

from copy import deepcopy
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.schemas import TempoMapWrite

from .conftest import auth, tempo_map


def _put_map(client: TestClient, repertoire_id: str, token: str, expected: int) -> Any:
    return client.put(
        f"/api/repertoire/{repertoire_id}/tempomap",
        headers=auth(token),
        json={"expectedRevision": expected, "data": tempo_map(repertoire_id, expected)},
    )


def test_role_boundaries_and_immutable_tempo_map_revisions(
    client: TestClient, ensemble: dict[str, Any]
) -> None:
    group_id = ensemble["group"]["id"]
    member_token = ensemble["member"]["accessToken"]
    leader_token = ensemble["leader"]["accessToken"]
    outsider_token = ensemble["outsider"]["accessToken"]
    repertoire_id = ensemble["repertoire"]["id"]

    denied_project = client.post(
        f"/api/groups/{group_id}/projects",
        headers=auth(member_token),
        json={"name": "Denied"},
    )
    assert denied_project.status_code == 403
    assert client.get(f"/api/groups/{group_id}", headers=auth(outsider_token)).status_code == 403
    assert _put_map(client, repertoire_id, member_token, 0).status_code == 403

    first = _put_map(client, repertoire_id, leader_token, 0)
    assert first.status_code == 200, first.text
    assert first.json()["revision"] == 1
    assert first.json()["data"]["revision"] == 1
    assert first.json()["data"]["repertoireItemId"] == repertoire_id

    stale = _put_map(client, repertoire_id, leader_token, 0)
    assert stale.status_code == 409
    assert stale.json()["detail"]["actualRevision"] == 1
    second = _put_map(client, repertoire_id, leader_token, 1)
    assert second.status_code == 200
    assert second.json()["revision"] == 2
    history = client.get(f"/api/repertoire/{repertoire_id}/tempomap/revisions", headers=auth(member_token))
    assert [item["revision"] for item in history.json()] == [2, 1]
    assert (
        client.get(
            f"/api/repertoire/{repertoire_id}/tempomap/revisions/1",
            headers=auth(member_token),
        ).json()["revision"]
        == 1
    )


@pytest.mark.parametrize("optional_values", ["omitted", "null", "populated"])
def test_tempo_map_responses_preserve_the_optional_field_contract(
    client: TestClient,
    ensemble: dict[str, Any],
    optional_values: str,
) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    headers = auth(ensemble["leader"]["accessToken"])
    payload = tempo_map(repertoire_id)
    payload["jumps"] = [
        {"type": "repeat", "startMeasure": 1, "endMeasure": 4, "times": 2},
        {"type": "dc", "atMeasure": 8},
        {"type": "ds", "atMeasure": 16, "segnoMeasure": 9},
        {"type": "coda", "toCodaMeasure": 24, "codaMeasure": 28},
    ]
    if optional_values != "omitted":
        populated = optional_values == "populated"
        payload["anacrusis"] = {"beats": 1} if populated else None
        payload["measureExpressions"] = (
            [
                {
                    "measure": 5,
                    "tempoChange": {"type": "aTempo", "targetBpm": 100},
                    "fermata": {"extraBeats": 0.5, "beat": 2},
                    "breath": {"durationSec": 1.25, "countIn": False},
                }
            ]
            if populated
            else None
        )
        payload["sections"][0].update(
            label="" if populated else None,
            tempoChange={"type": "rit", "targetBpm": 80} if populated else None,
            fermata={"extraBeats": 0.5} if populated else None,
            breath={"durationSec": 1.25, "countIn": False} if populated else None,
            accentPattern=[2, 1, 0, 1] if populated else None,
            subdivision=2 if populated else None,
        )
        payload["jumps"][0]["endings"] = [{"measures": [3, 4], "forPass": [2]}] if populated else None
        payload["jumps"][1].update(alFine=8 if populated else None, alCoda=False if populated else None)
        payload["jumps"][2].update(alFine=16 if populated else None, alCoda=True if populated else None)

    expected = tempo_map(repertoire_id, 1)
    expected["jumps"] = [
        {"type": "repeat", "startMeasure": 1, "endMeasure": 4, "times": 2},
        {"type": "dc", "atMeasure": 8},
        {"type": "ds", "atMeasure": 16, "segnoMeasure": 9},
        {"type": "coda", "toCodaMeasure": 24, "codaMeasure": 28},
    ]
    if optional_values == "populated":
        expected = {**payload, "revision": 1}

    path = f"/api/repertoire/{repertoire_id}/tempomap"
    written = client.put(path, headers=headers, json={"expectedRevision": 0, "data": payload})
    assert written.status_code == 200, written.text
    latest = client.get(path, headers=headers)
    revision = client.get(f"{path}/revisions/1", headers=headers)
    history = client.get(f"{path}/revisions", headers=headers)
    for response in (latest, revision, history):
        assert response.status_code == 200, response.text
    assert len(history.json()) == 1
    for response in (written.json(), latest.json(), revision.json(), history.json()[0]):
        assert response["data"] == expected


def test_tempo_expressions_preserve_values_and_immutable_revision_history(
    client: TestClient, ensemble: dict[str, Any]
) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    headers = auth(ensemble["leader"]["accessToken"])
    payload = tempo_map(repertoire_id, total_measures=6)
    base_section = payload["sections"][0]
    payload["sections"] = [
        {
            **base_section,
            "id": f"section-{index + 1}",
            "startMeasure": index * 2 + 1,
            "endMeasure": index * 2 + 2,
            "tempoChange": {"type": "aTempo", "targetBpm": target_bpm},
            "fermata": {"extraBeats": extra_beats},
            "breath": {"durationSec": duration, "countIn": count_in},
        }
        for index, (target_bpm, extra_beats, duration, count_in) in enumerate(
            [(80, 0.5, 0.25, False), (100, 1.5, 1.25, True), (120, 16, 300, False)]
        )
    ]
    path = f"/api/repertoire/{repertoire_id}/tempomap"
    first = client.put(path, headers=headers, json={"expectedRevision": 0, "data": payload})
    assert first.status_code == 200, first.text
    expected_first = {**payload, "revision": 1}
    assert first.json()["data"] == expected_first

    updated = deepcopy(expected_first)
    updated["sections"][0].update(
        tempoChange={"type": "aTempo", "targetBpm": 140},
        fermata={"extraBeats": 2.5},
        breath={"durationSec": 2.5, "countIn": True},
    )
    second = client.put(path, headers=headers, json={"expectedRevision": 1, "data": updated})
    assert second.status_code == 200, second.text
    expected_second = {**updated, "revision": 2}
    assert second.json()["data"] == expected_second

    latest = client.get(path, headers=headers)
    first_revision = client.get(f"{path}/revisions/1", headers=headers)
    history = client.get(f"{path}/revisions", headers=headers)
    for response in (latest, first_revision, history):
        assert response.status_code == 200, response.text
    assert latest.json()["data"] == expected_second
    assert first_revision.json()["data"] == expected_first
    assert [item["data"] for item in history.json()] == [expected_second, expected_first]


def test_tempo_expression_requests_reject_invalid_values_without_creating_revisions(
    client: TestClient, ensemble: dict[str, Any]
) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    headers = auth(ensemble["leader"]["accessToken"])
    path = f"/api/repertoire/{repertoire_id}/tempomap"
    invalid_sections = [
        *({"tempoChange": {"type": "aTempo", "targetBpm": value}} for value in [0, -1, "100", True]),
        {"tempoChange": {"type": "aTempo"}},
        {"tempoChange": {"type": "rit", "targetBpm": 100}},
        {"tempoChange": {"type": "accel", "targetBpm": 100}},
        *({"fermata": {"extraBeats": value}} for value in [0, -1, 16.01, "1", True]),
        {"fermata": {}},
        *({"breath": {"durationSec": value, "countIn": False}} for value in [0, -1, 300.01, "1", True]),
        *({"breath": {"durationSec": 1, "countIn": value}} for value in [0, 1, "false", None]),
        {"breath": {"durationSec": 1}},
        {"breath": {"countIn": True}},
    ]
    for section_update in invalid_sections:
        payload = tempo_map(repertoire_id)
        payload["sections"][0].update(section_update)
        response = client.put(path, headers=headers, json={"expectedRevision": 0, "data": payload})
        assert response.status_code == 422, (section_update, response.text)

    history = client.get(f"{path}/revisions", headers=headers)
    assert history.status_code == 200, history.text
    assert history.json() == []


def test_measure_expressions_save_in_one_section_and_preserve_legacy_revision_data(
    client: TestClient, ensemble: dict[str, Any]
) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    headers = auth(ensemble["leader"]["accessToken"])
    path = f"/api/repertoire/{repertoire_id}/tempomap"
    payload = tempo_map(repertoire_id, total_measures=8)
    payload["sections"][0].update(
        fermata={"extraBeats": 1, "beat": 4},
        breath={"durationSec": 2, "countIn": False},
    )
    payload["measureExpressions"] = [
        {"measure": 8},
        {
            "measure": 2,
            "tempoChange": {"type": "rit", "targetBpm": 80, "endMeasure": 3},
            "fermata": {"extraBeats": 0.5, "beat": 2},
        },
        {"measure": 3, "breath": {"durationSec": 0.25, "countIn": False}},
        {"measure": 4, "tempoChange": {"type": "aTempo", "targetBpm": 100}},
        {
            "measure": 6,
            "tempoChange": {"type": "accel", "targetBpm": 120, "endMeasure": 7},
            "fermata": {"extraBeats": 1.5, "beat": 1},
            "breath": {"durationSec": 1.25, "countIn": True},
        },
    ]
    written = client.put(path, headers=headers, json={"expectedRevision": 0, "data": payload})
    assert written.status_code == 200, written.text
    expected = {**payload, "revision": 1}
    assert written.json()["data"] == expected
    for route in (path, f"{path}/revisions/1"):
        response = client.get(route, headers=headers)
        assert response.status_code == 200, response.text
        assert response.json()["data"] == expected

    updated = deepcopy(expected)
    updated["measureExpressions"] = [{"measure": 8, "fermata": {"extraBeats": 0.5, "beat": 3}}]
    second = client.put(path, headers=headers, json={"expectedRevision": 1, "data": updated})
    assert second.status_code == 200, second.text
    history = client.get(f"{path}/revisions", headers=headers)
    assert history.status_code == 200, history.text
    assert [item["data"] for item in history.json()] == [{**updated, "revision": 2}, expected]
    assert expected["measureExpressions"][0] == {"measure": 8}


def test_measure_expression_requests_reject_bounds_duplicates_overlap_and_invalid_beats(
    client: TestClient, ensemble: dict[str, Any]
) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    headers = auth(ensemble["leader"]["accessToken"])
    path = f"/api/repertoire/{repertoire_id}/tempomap"
    invalid_expressions = [
        [{}],
        *([{"measure": value}] for value in [0, 9, 1.5, "2", True]),
        [{"measure": 2}, {"measure": 2, "breath": {"durationSec": 1, "countIn": False}}],
        *(
            [{"measure": 2, "tempoChange": {"type": "rit", "targetBpm": 80, "endMeasure": value}}]
            for value in [0, 1, 9, 2.5, "3", True]
        ),
        [{"measure": 2, "tempoChange": {"type": "aTempo", "targetBpm": 80, "endMeasure": 2}}],
        [
            {"measure": 4, "tempoChange": {"type": "aTempo", "targetBpm": 100}},
            {"measure": 2, "tempoChange": {"type": "rit", "targetBpm": 80, "endMeasure": 4}},
        ],
        *([{"measure": 2, "fermata": {"extraBeats": 1, "beat": value}}] for value in [0, 5, 1.5, "2", True]),
        [{"measure": 2, "breath": {"durationSec": 1}}],
        [{"measure": 2, "breath": {"durationSec": 1, "countIn": 0}}],
    ]
    for expressions in invalid_expressions:
        payload = tempo_map(repertoire_id, total_measures=8)
        payload["measureExpressions"] = expressions
        response = client.put(path, headers=headers, json={"expectedRevision": 0, "data": payload})
        assert response.status_code == 422, (expressions, response.text)
    history = client.get(f"{path}/revisions", headers=headers)
    assert history.status_code == 200, history.text
    assert history.json() == []


@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("beat", [1, 2, 3, 4, 5])
def test_fermata_beat_must_exist_in_pickup_measure(legacy: bool, beat: int) -> None:
    payload = tempo_map("repertoire", total_measures=1)
    payload["anacrusis"] = {"beats": 2}
    fermata = {"extraBeats": 0.5, "beat": beat}
    if legacy:
        payload["sections"][0]["fermata"] = fermata
    else:
        payload["measureExpressions"] = [{"measure": 1, "fermata": fermata}]
    if beat not in (3, 4):
        with pytest.raises(ValidationError, match="fermata beat"):
            TempoMapWrite.model_validate({"expectedRevision": 0, "data": payload})
    else:
        TempoMapWrite.model_validate({"expectedRevision": 0, "data": payload})


@pytest.mark.parametrize(
    ("previous_target", "change_type", "target", "valid"),
    [(140, "rit", 120, True), (60, "accel", 80, True), (60, "rit", 80, False), (140, "accel", 120, False)],
)
def test_measure_tempo_direction_uses_previous_mark_instead_of_section_bpm(
    previous_target: float, change_type: str, target: float, valid: bool
) -> None:
    payload = tempo_map("repertoire", total_measures=8)
    payload["measureExpressions"] = [
        {"measure": 1, "tempoChange": {"type": "aTempo", "targetBpm": previous_target}},
        {"measure": 2, "tempoChange": {"type": change_type, "targetBpm": target}},
    ]
    if valid:
        TempoMapWrite.model_validate({"expectedRevision": 0, "data": payload})
    else:
        with pytest.raises(ValidationError, match="effective starting BPM"):
            TempoMapWrite.model_validate({"expectedRevision": 0, "data": payload})


@pytest.mark.parametrize(
    ("span_end", "next_measure", "change_type", "target", "valid"),
    [
        (6, 7, "accel", 90, True),
        (6, 7, "rit", 90, False),
        (4, 5, "rit", 150, True),
        (4, 5, "accel", 150, False),
    ],
)
def test_measure_tempo_carries_across_its_span_and_resets_at_later_section_starts(
    span_end: int, next_measure: int, change_type: str, target: float, valid: bool
) -> None:
    payload = tempo_map("repertoire", total_measures=8)
    first = {**payload["sections"][0], "endMeasure": 4}
    second = {**first, "id": "section-2", "startMeasure": 5, "endMeasure": 8, "bpm": 200}
    payload["sections"] = [first, second]
    payload["measureExpressions"] = [
        {"measure": 2, "tempoChange": {"type": "rit", "targetBpm": 80, "endMeasure": span_end}},
        {"measure": next_measure, "tempoChange": {"type": change_type, "targetBpm": target}},
    ]
    if valid:
        TempoMapWrite.model_validate({"expectedRevision": 0, "data": payload})
    else:
        with pytest.raises(ValidationError, match="effective starting BPM"):
            TempoMapWrite.model_validate({"expectedRevision": 0, "data": payload})


@pytest.mark.parametrize(
    ("bpm", "total_measures", "measure", "change_type", "target"),
    [(107, 11, 10, "accel", 44), (120, 10, 8, "rit", 57)],
)
def test_measure_tempo_direction_matches_core_at_exact_section_ramp_boundary(
    bpm: float, total_measures: int, measure: int, change_type: str, target: float
) -> None:
    payload = tempo_map("repertoire", total_measures=total_measures)
    payload["sections"][0].update(bpm=bpm, tempoChange={"type": "rit", "targetBpm": 30})
    payload["measureExpressions"] = [
        {"measure": measure, "tempoChange": {"type": change_type, "targetBpm": target}}
    ]
    with pytest.raises(ValidationError, match="effective starting BPM"):
        TempoMapWrite.model_validate({"expectedRevision": 0, "data": payload})


@pytest.mark.parametrize("pickup", [False, True])
def test_measure_tempo_uses_section_ramp_position_with_pickup(pickup: bool) -> None:
    payload = tempo_map("repertoire", total_measures=2)
    payload["sections"][0]["tempoChange"] = {"type": "rit", "targetBpm": 40}
    payload["measureExpressions"] = [{"measure": 2, "tempoChange": {"type": "rit", "targetBpm": 75}}]
    if pickup:
        payload["anacrusis"] = {"beats": 2}
        # Two of six score beats have passed: the section baseline is 80 BPM.
        TempoMapWrite.model_validate({"expectedRevision": 0, "data": payload})
    else:
        # Four of eight beats have passed: the baseline is 70, so 75 is not rit.
        with pytest.raises(ValidationError, match="effective starting BPM"):
            TempoMapWrite.model_validate({"expectedRevision": 0, "data": payload})


@pytest.mark.parametrize("beat", [1, 2, 3])
def test_measure_fermata_uses_primary_beat_unit_in_compound_meter(beat: int) -> None:
    payload = tempo_map("repertoire", total_measures=2)
    payload["sections"][0].update(timeSignature={"num": 6, "denom": 8}, beatUnit="dottedQuarter")
    payload["measureExpressions"] = [{"measure": 2, "fermata": {"extraBeats": 0.5, "beat": beat}}]
    if beat <= 2:
        TempoMapWrite.model_validate({"expectedRevision": 0, "data": payload})
    else:
        with pytest.raises(ValidationError, match="fermata beat"):
            TempoMapWrite.model_validate({"expectedRevision": 0, "data": payload})


def test_nullable_measure_expression_fields_are_omitted_but_empty_override_record_survives() -> None:
    payload = tempo_map("repertoire", total_measures=2)
    payload["measureExpressions"] = [
        {"measure": 1, "tempoChange": None, "fermata": None, "breath": None},
        {
            "measure": 2,
            "tempoChange": {"type": "rit", "targetBpm": 80, "endMeasure": None},
            "fermata": {"extraBeats": 0.5, "beat": None},
        },
    ]
    model = TempoMapWrite.model_validate({"expectedRevision": 0, "data": payload})
    assert model.data.model_dump(by_alias=True)["measureExpressions"] == [
        {"measure": 1},
        {"measure": 2, "tempoChange": {"type": "rit", "targetBpm": 80}, "fermata": {"extraBeats": 0.5}},
    ]


@pytest.mark.parametrize("value", [float("inf"), float("-inf"), float("nan")])
@pytest.mark.parametrize("expression", ["tempoChange", "fermata", "breath"])
def test_tempo_expression_contract_rejects_nonfinite_numbers(expression: str, value: float) -> None:
    payload = tempo_map("repertoire")
    expressions = {
        "tempoChange": {"type": "aTempo", "targetBpm": value},
        "fermata": {"extraBeats": value},
        "breath": {"durationSec": value, "countIn": True},
    }
    payload["sections"][0][expression] = expressions[expression]
    with pytest.raises(ValidationError):
        TempoMapWrite.model_validate({"expectedRevision": 0, "data": payload})


def test_group_owner_controls_members_and_owner_cannot_be_removed(
    client: TestClient, ensemble: dict[str, Any]
) -> None:
    group_id = ensemble["group"]["id"]
    owner = ensemble["owner"]
    member = ensemble["member"]
    leader = ensemble["leader"]
    owner_headers = auth(owner["accessToken"])
    assert (
        client.patch(
            f"/api/groups/{group_id}/members/{member['user']['id']}",
            headers=auth(leader["accessToken"]),
            json={"role": "leader"},
        ).status_code
        == 403
    )
    promoted = client.patch(
        f"/api/groups/{group_id}/members/{member['user']['id']}",
        headers=owner_headers,
        json={"role": "leader"},
    )
    assert promoted.status_code == 200
    assert promoted.json()["role"] == "leader"
    assert (
        client.delete(
            f"/api/groups/{group_id}/members/{owner['user']['id']}", headers=owner_headers
        ).status_code
        == 409
    )


def test_tempo_map_validation_rejects_gaps(client: TestClient, ensemble: dict[str, Any]) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    malformed = tempo_map(repertoire_id)
    malformed["sections"][0]["startMeasure"] = 2
    response = client.put(
        f"/api/repertoire/{repertoire_id}/tempomap",
        headers=auth(ensemble["leader"]["accessToken"]),
        json={"expectedRevision": 0, "data": malformed},
    )
    assert response.status_code == 422


@pytest.mark.parametrize(
    "malformation",
    [
        "non-object-section",
        "missing-meter",
        "invalid-accent-count",
        "invalid-repeat-pass",
        "mismatched-repertoire",
        "mismatched-revision",
        "numeric-string",
    ],
)
def test_tempo_map_validation_rejects_every_malformed_contract_branch(
    client: TestClient,
    ensemble: dict[str, Any],
    malformation: str,
) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    malformed = tempo_map(repertoire_id)
    expected_revision = 0
    if malformation == "non-object-section":
        malformed["sections"] = [1]
    elif malformation == "missing-meter":
        del malformed["sections"][0]["timeSignature"]
    elif malformation == "invalid-accent-count":
        malformed["sections"][0]["accentPattern"] = [2, 1]
    elif malformation == "invalid-repeat-pass":
        malformed["jumps"] = [
            {
                "type": "repeat",
                "startMeasure": 1,
                "endMeasure": 4,
                "times": 2,
                "endings": [{"measures": [3, 4], "forPass": [3]}],
            }
        ]
    elif malformation == "mismatched-repertoire":
        malformed["repertoireItemId"] = "another-repertoire"
    elif malformation == "mismatched-revision":
        malformed["revision"] = 1
    elif malformation == "numeric-string":
        malformed["sections"][0]["bpm"] = "100"

    response = client.put(
        f"/api/repertoire/{repertoire_id}/tempomap",
        headers=auth(ensemble["leader"]["accessToken"]),
        json={"expectedRevision": expected_revision, "data": malformed},
    )
    assert response.status_code == 422, response.text
