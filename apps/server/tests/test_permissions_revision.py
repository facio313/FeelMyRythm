from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

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
