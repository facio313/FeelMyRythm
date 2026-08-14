from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import MeasureMap, Score, StorageDeletionJob, utcnow
from app.storage import ObjectStoragePromotionError

from .conftest import auth


def _text_annotation(text: str, measure_number: int = 1) -> dict[str, Any]:
    return {
        "kind": "text",
        "page": 1,
        "measureNumber": measure_number,
        "payload": {"x": 0.5, "y": 0.5, "text": text, "anchorType": "measure"},
    }


def _pen_annotation() -> dict[str, Any]:
    return {
        "kind": "pen",
        "page": 1,
        "measureNumber": 1,
        "payload": {"points": [{"x": 0.1, "y": 0.2}, {"x": 0.2, "y": 0.3}]},
    }


def _uploaded_score(client: TestClient, ensemble: dict[str, Any]) -> dict[str, Any]:
    repertoire_id = ensemble["repertoire"]["id"]
    leader_headers = auth(ensemble["leader"]["accessToken"])
    payload = b"%PDF-1.7\nscore-data"
    presign = client.post(
        f"/api/repertoire/{repertoire_id}/scores/presign",
        headers=leader_headers,
        json={
            "filename": "part.pdf",
            "contentType": "application/pdf",
            "sizeBytes": len(payload),
            "kind": "part",
            "instrument": "violin",
        },
    )
    assert presign.status_code == 201, presign.text
    target = presign.json()
    assert target["storageKey"].startswith("staging/scores/")
    with client.app.state.database.session_factory() as db:
        pending = db.get(Score, target["scoreId"])
        assert pending is not None
        assert pending.upload_status == "pending"
        assert pending.staging_key == target["storageKey"]
        assert pending.storage_key.startswith(f"scores/{repertoire_id}/")
        assert pending.storage_key != pending.staging_key
        assert pending.upload_expires_at is not None
    upload = client.put(target["uploadUrl"], content=payload, headers=target["headers"])
    assert upload.status_code == 204, upload.text
    completed = client.post(
        f"/api/scores/{target['scoreId']}/complete",
        headers=leader_headers,
        json={"sizeBytes": len(payload)},
    )
    assert completed.status_code == 200, completed.text
    with client.app.state.database.session_factory() as db:
        promoted = db.get(Score, target["scoreId"])
        assert promoted is not None
        assert client.app.state.storage.exists(promoted.storage_key, len(payload))
        staging_job = db.scalar(
            select(StorageDeletionJob).where(StorageDeletionJob.storage_key == target["storageKey"])
        )
        assert staging_job is not None
        assert staging_job.guard_until is not None
    return completed.json()


def test_local_presigned_upload_download_and_score_permissions(
    client: TestClient, ensemble: dict[str, Any]
) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    denied = client.post(
        f"/api/repertoire/{repertoire_id}/scores/presign",
        headers=auth(ensemble["member"]["accessToken"]),
        json={
            "filename": "part.pdf",
            "contentType": "application/pdf",
            "sizeBytes": 5,
            "kind": "part",
            "instrument": "cello",
        },
    )
    assert denied.status_code == 403
    score = _uploaded_score(client, ensemble)
    assert score["uploadStatus"] == "ready"
    download = client.get(
        f"/api/scores/{score['id']}/download",
        headers=auth(ensemble["member"]["accessToken"]),
    )
    assert download.status_code == 200
    content = client.get(download.json()["url"])
    assert content.content.startswith(b"%PDF-1.7")


def test_presign_failure_does_not_leave_a_pending_score(
    client: TestClient, ensemble: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    repertoire_id = ensemble["repertoire"]["id"]

    def fail_target(*_: object, **__: object) -> None:
        raise RuntimeError("presign unavailable")

    monkeypatch.setattr(client.app.state.storage, "create_upload_target", fail_target)
    with pytest.raises(RuntimeError, match="presign unavailable"):
        client.post(
            f"/api/repertoire/{repertoire_id}/scores/presign",
            headers=auth(ensemble["leader"]["accessToken"]),
            json={
                "filename": "part.pdf",
                "contentType": "application/pdf",
                "sizeBytes": 5,
                "kind": "part",
                "instrument": "violin",
            },
        )

    with client.app.state.database.session_factory() as db:
        pending = db.scalar(
            select(func.count()).select_from(Score).where(Score.repertoire_id == repertoire_id)
        )
    assert pending == 0


def test_local_upload_requires_live_pending_row_and_exact_declared_size(
    client: TestClient,
    ensemble: dict[str, Any],
) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    headers = auth(ensemble["leader"]["accessToken"])

    def presign(filename: str, size: int) -> dict[str, Any]:
        response = client.post(
            f"/api/repertoire/{repertoire_id}/scores/presign",
            headers=headers,
            json={
                "filename": filename,
                "contentType": "application/pdf",
                "sizeBytes": size,
                "kind": "part",
                "instrument": "violin",
            },
        )
        assert response.status_code == 201, response.text
        return response.json()

    short = presign("short.pdf", 5)
    short_response = client.put(short["uploadUrl"], content=b"1234", headers=short["headers"])
    assert short_response.status_code == 409
    assert not client.app.state.storage.resolve_key(short["storageKey"]).exists()

    oversized = presign("oversized.pdf", 4)
    oversized_response = client.put(
        oversized["uploadUrl"],
        content=b"12345",
        headers=oversized["headers"],
    )
    assert oversized_response.status_code == 409
    assert not client.app.state.storage.resolve_key(oversized["storageKey"]).exists()

    deleted = presign("deleted.pdf", 4)
    assert client.delete(f"/api/scores/{deleted['scoreId']}", headers=headers).status_code == 204
    deleted_response = client.put(
        deleted["uploadUrl"],
        content=b"1234",
        headers=deleted["headers"],
    )
    assert deleted_response.status_code == 410
    assert not client.app.state.storage.resolve_key(deleted["storageKey"]).exists()

    expired = presign("expired.pdf", 4)
    with client.app.state.database.session_factory() as db:
        score = db.get(Score, expired["scoreId"])
        assert score is not None
        score.upload_expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    expired_response = client.put(
        expired["uploadUrl"],
        content=b"1234",
        headers=expired["headers"],
    )
    assert expired_response.status_code == 410
    assert not client.app.state.storage.resolve_key(expired["storageKey"]).exists()


def test_local_upload_rechecks_pending_row_after_stream_before_publish(
    client: TestClient,
    ensemble: dict[str, Any],
) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    headers = auth(ensemble["leader"]["accessToken"])
    response = client.post(
        f"/api/repertoire/{repertoire_id}/scores/presign",
        headers=headers,
        json={
            "filename": "raced.pdf",
            "contentType": "application/pdf",
            "sizeBytes": 4,
            "kind": "part",
            "instrument": "violin",
        },
    )
    target = response.json()

    def raced_body() -> Any:
        yield b"12"
        with client.app.state.database.session_factory() as db:
            score = db.get(Score, target["scoreId"])
            assert score is not None
            db.delete(score)
            db.commit()
        yield b"34"

    upload = client.put(target["uploadUrl"], content=raced_body(), headers=target["headers"])
    assert upload.status_code == 410
    assert not client.app.state.storage.resolve_key(target["storageKey"]).exists()


def test_complete_recovers_when_promote_succeeds_before_database_commit_failure(
    client: TestClient,
    ensemble: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    headers = auth(ensemble["leader"]["accessToken"])
    payload = b"complete-retry"
    presign = client.post(
        f"/api/repertoire/{repertoire_id}/scores/presign",
        headers=headers,
        json={
            "filename": "retry.pdf",
            "contentType": "application/pdf",
            "sizeBytes": len(payload),
            "kind": "part",
            "instrument": "violin",
        },
    ).json()
    assert client.put(presign["uploadUrl"], content=payload, headers=presign["headers"]).status_code == 204

    original_commit = Session.commit
    failed = False

    def fail_ready_commit(session: Session) -> None:
        nonlocal failed
        if not failed and any(isinstance(row, StorageDeletionJob) for row in session.new):
            failed = True
            raise RuntimeError("commit failed after promote")
        original_commit(session)

    monkeypatch.setattr(Session, "commit", fail_ready_commit)
    with pytest.raises(RuntimeError, match="commit failed after promote"):
        client.post(
            f"/api/scores/{presign['scoreId']}/complete",
            headers=headers,
            json={"sizeBytes": len(payload)},
        )

    with client.app.state.database.session_factory() as db:
        pending = db.get(Score, presign["scoreId"])
        assert pending is not None
        assert pending.upload_status == "pending"
        assert client.app.state.storage.exists(pending.storage_key, len(payload))
        assert db.scalar(select(func.count()).select_from(StorageDeletionJob)) == 0

    monkeypatch.setattr(Session, "commit", original_commit)
    retried = client.post(
        f"/api/scores/{presign['scoreId']}/complete",
        headers=headers,
        json={"sizeBytes": len(payload)},
    )
    assert retried.status_code == 200, retried.text
    assert retried.json()["uploadStatus"] == "ready"


def test_promote_failure_keeps_score_pending(
    client: TestClient,
    ensemble: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    score = _uploaded_score(client, ensemble)
    with client.app.state.database.session_factory() as db:
        row = db.get(Score, score["id"])
        assert row is not None
        row.upload_status = "pending"
        db.commit()

    def fail_promote(*_: object) -> None:
        raise ObjectStoragePromotionError("provider unavailable")

    monkeypatch.setattr(client.app.state.storage, "promote", fail_promote)
    response = client.post(
        f"/api/scores/{score['id']}/complete",
        headers=auth(ensemble["leader"]["accessToken"]),
        json={"sizeBytes": score["sizeBytes"]},
    )
    assert response.status_code == 409
    with client.app.state.database.session_factory() as db:
        pending = db.get(Score, score["id"])
        assert pending is not None
        assert pending.upload_status == "pending"


def test_measure_map_and_annotation_revision_visibility(client: TestClient, ensemble: dict[str, Any]) -> None:
    score = _uploaded_score(client, ensemble)
    leader_headers = auth(ensemble["leader"]["accessToken"])
    member_headers = auth(ensemble["member"]["accessToken"])
    first_map = client.put(
        f"/api/scores/{score['id']}/measure-map",
        headers=leader_headers,
        json={
            "expectedRevision": 0,
            "measureNumberOffset": 0,
            "regions": [
                {
                    "page": 1,
                    "measureNumber": 1,
                    "rect": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.1},
                }
            ],
        },
    )
    assert first_map.status_code == 200
    assert first_map.json()["revision"] == 1
    stale = client.put(
        f"/api/scores/{score['id']}/measure-map",
        headers=leader_headers,
        json={"expectedRevision": 0, "measureNumberOffset": 0, "regions": []},
    )
    assert stale.status_code == 409

    invalid_annotation = client.post(
        f"/api/scores/{score['id']}/annotations",
        headers=member_headers,
        json={"scope": "private", "data": {"text": "not renderable"}},
    )
    assert invalid_annotation.status_code == 422

    private = client.post(
        f"/api/scores/{score['id']}/annotations",
        headers=member_headers,
        json={"scope": "private", "data": _pen_annotation()},
    ).json()
    project = client.post(
        f"/api/scores/{score['id']}/annotations",
        headers=member_headers,
        json={"scope": "project", "data": _text_annotation("crescendo")},
    ).json()
    member_rows = client.get(f"/api/scores/{score['id']}/annotations", headers=member_headers).json()
    assert {item["id"] for item in member_rows} == {private["id"], project["id"]}
    leader_rows = client.get(f"/api/scores/{score['id']}/annotations", headers=leader_headers).json()
    assert [item["id"] for item in leader_rows] == [project["id"]]
    assert (
        client.put(
            f"/api/annotations/{project['id']}",
            headers=member_headers,
            json={"expectedRevision": 0, "data": _text_annotation("stale")},
        ).status_code
        == 409
    )
    updated = client.put(
        f"/api/annotations/{project['id']}",
        headers=member_headers,
        json={"expectedRevision": 1, "data": _text_annotation("forte")},
    )
    assert updated.json()["revision"] == 2


def test_repertoire_access_reports_membership_role_and_denies_outsiders(
    client: TestClient, ensemble: dict[str, Any]
) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    for identity, expected_role in (
        (ensemble["owner"], "owner"),
        (ensemble["leader"], "leader"),
        (ensemble["member"], "member"),
    ):
        response = client.get(
            f"/api/repertoire/{repertoire_id}/access",
            headers=auth(identity["accessToken"]),
        )
        assert response.status_code == 200, response.text
        assert response.json() == {"role": expected_role}

    denied = client.get(
        f"/api/repertoire/{repertoire_id}/access",
        headers=auth(ensemble["outsider"]["accessToken"]),
    )
    assert denied.status_code == 403


def test_repertoire_annotations_span_scores_and_preserve_private_visibility(
    client: TestClient, ensemble: dict[str, Any]
) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    member_headers = auth(ensemble["member"]["accessToken"])
    leader_headers = auth(ensemble["leader"]["accessToken"])
    first_score = _uploaded_score(client, ensemble)
    second_score = _uploaded_score(client, ensemble)

    member_private = client.post(
        f"/api/scores/{first_score['id']}/annotations",
        headers=member_headers,
        json={"scope": "private", "data": _text_annotation("member", 12)},
    ).json()
    member_project = client.post(
        f"/api/scores/{first_score['id']}/annotations",
        headers=member_headers,
        json={"scope": "project", "data": _text_annotation("shared one", 13)},
    ).json()
    leader_private = client.post(
        f"/api/scores/{second_score['id']}/annotations",
        headers=leader_headers,
        json={"scope": "private", "data": _text_annotation("leader", 12)},
    ).json()
    leader_project = client.post(
        f"/api/scores/{second_score['id']}/annotations",
        headers=leader_headers,
        json={"scope": "project", "data": _text_annotation("shared two", 14)},
    ).json()

    member_response = client.get(f"/api/repertoire/{repertoire_id}/annotations", headers=member_headers)
    assert member_response.status_code == 200, member_response.text
    assert {row["id"] for row in member_response.json()} == {
        member_private["id"],
        member_project["id"],
        leader_project["id"],
    }
    assert {row["scoreId"] for row in member_response.json()} == {
        first_score["id"],
        second_score["id"],
    }

    leader_response = client.get(f"/api/repertoire/{repertoire_id}/annotations", headers=leader_headers)
    assert leader_response.status_code == 200, leader_response.text
    assert {row["id"] for row in leader_response.json()} == {
        member_project["id"],
        leader_private["id"],
        leader_project["id"],
    }
    denied = client.get(
        f"/api/repertoire/{repertoire_id}/annotations",
        headers=auth(ensemble["outsider"]["accessToken"]),
    )
    assert denied.status_code == 403


def test_repertoire_score_count_only_includes_ready_uploads(
    client: TestClient, ensemble: dict[str, Any]
) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    leader_headers = auth(ensemble["leader"]["accessToken"])
    payload = b"%PDF-1.7\npending-score"
    presign = client.post(
        f"/api/repertoire/{repertoire_id}/scores/presign",
        headers=leader_headers,
        json={
            "filename": "pending.pdf",
            "contentType": "application/pdf",
            "sizeBytes": len(payload),
            "kind": "full",
            "instrument": "",
        },
    )
    assert presign.status_code == 201, presign.text
    target = presign.json()
    pending_repertoire = client.get(f"/api/repertoire/{repertoire_id}", headers=leader_headers)
    assert pending_repertoire.json()["scoreCount"] == 0
    pending_list = client.get(f"/api/repertoire/{repertoire_id}/scores", headers=leader_headers)
    assert pending_list.status_code == 200
    assert pending_list.json() == []
    assert client.get(f"/api/scores/{target['scoreId']}", headers=leader_headers).status_code == 404

    assert client.put(target["uploadUrl"], content=payload, headers=target["headers"]).status_code == 204
    completed = client.post(
        f"/api/scores/{target['scoreId']}/complete",
        headers=leader_headers,
        json={"sizeBytes": len(payload)},
    )
    assert completed.status_code == 200, completed.text
    repeated = client.post(
        f"/api/scores/{target['scoreId']}/complete",
        headers=leader_headers,
        json={"sizeBytes": len(payload)},
    )
    assert repeated.status_code == 200
    assert repeated.json()["id"] == target["scoreId"]
    ready_repertoire = client.get(f"/api/repertoire/{repertoire_id}", headers=leader_headers)
    assert ready_repertoire.json()["scoreCount"] == 1


@pytest.mark.parametrize("endpoint", ["measure-map", "settings"])
def test_first_measure_map_insert_integrity_error_rolls_back_as_conflict(
    client: TestClient,
    ensemble: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    endpoint: str,
) -> None:
    score = _uploaded_score(client, ensemble)
    leader_headers = auth(ensemble["leader"]["accessToken"])
    original_commit = Session.commit
    original_rollback = Session.rollback
    rollback_calls: list[Session] = []

    def fail_measure_map_insert(session: Session) -> None:
        if any(isinstance(row, MeasureMap) for row in session.new):
            raise IntegrityError("INSERT INTO measure_maps", {}, RuntimeError("concurrent insert"))
        original_commit(session)

    def track_rollback(session: Session) -> None:
        rollback_calls.append(session)
        original_rollback(session)

    monkeypatch.setattr(Session, "commit", fail_measure_map_insert)
    monkeypatch.setattr(Session, "rollback", track_rollback)
    payload: dict[str, Any] = {
        "expectedRevision": 0,
        "measureNumberOffset": 0,
        "regions": [],
    }
    if endpoint == "settings":
        payload = {
            "kind": "full",
            "instrument": "Changed",
            "expectedMeasureMapRevision": 0,
            "measureNumberOffset": 0,
            "regions": [],
        }

    response = client.put(f"/api/scores/{score['id']}/{endpoint}", headers=leader_headers, json=payload)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["message"] == "measure map was concurrently updated"
    assert len(rollback_calls) == 1
    assert client.get(f"/api/scores/{score['id']}/measure-map", headers=leader_headers).status_code == 404
    persisted_score = client.get(f"/api/scores/{score['id']}", headers=leader_headers).json()
    assert persisted_score["kind"] == "part"
    assert persisted_score["instrument"] == "violin"


def test_score_settings_update_is_atomic_on_measure_map_conflict(
    client: TestClient, ensemble: dict[str, Any]
) -> None:
    score = _uploaded_score(client, ensemble)
    leader_headers = auth(ensemble["leader"]["accessToken"])
    settings = client.put(
        f"/api/scores/{score['id']}/settings",
        headers=leader_headers,
        json={
            "kind": "full",
            "instrument": "Cello",
            "expectedMeasureMapRevision": 0,
            "measureNumberOffset": 10,
            "regions": [
                {
                    "page": 1,
                    "measureNumber": 1,
                    "rect": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.1},
                }
            ],
        },
    )
    assert settings.status_code == 200, settings.text
    assert settings.json()["score"]["instrument"] == "Cello"
    assert settings.json()["measureMap"]["revision"] == 1
    assert settings.json()["measureMap"]["measureNumberOffset"] == 10

    stale = client.put(
        f"/api/scores/{score['id']}/settings",
        headers=leader_headers,
        json={
            "kind": "part",
            "instrument": "Bass",
            "expectedMeasureMapRevision": 0,
            "measureNumberOffset": 20,
            "regions": [],
        },
    )
    assert stale.status_code == 409
    persisted_score = client.get(f"/api/scores/{score['id']}", headers=leader_headers).json()
    persisted_map = client.get(f"/api/scores/{score['id']}/measure-map", headers=leader_headers).json()
    assert persisted_score["kind"] == "full"
    assert persisted_score["instrument"] == "Cello"
    assert persisted_map["measureNumberOffset"] == 10


def test_logs_todos_and_calibrations(client: TestClient, ensemble: dict[str, Any]) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    member = ensemble["member"]
    member_headers = auth(member["accessToken"])
    log = client.post(
        f"/api/repertoire/{repertoire_id}/logs",
        headers=member_headers,
        json={"content": "Measure 26 crescendo", "anchors": [{"measureNumber": 26}]},
    )
    assert log.status_code == 201
    todo = client.post(
        f"/api/repertoire/{repertoire_id}/todos",
        headers=member_headers,
        json={
            "content": "Practice bowing",
            "practiceLogId": log.json()["id"],
            "assigneeId": member["user"]["id"],
            "dueDate": "2026-09-01",
        },
    )
    assert todo.status_code == 201, todo.text
    toggled = client.patch(f"/api/todos/{todo.json()['id']}", headers=member_headers, json={"done": True})
    assert toggled.json()["done"] is True
    assert (
        client.get(
            f"/api/repertoire/{repertoire_id}/logs",
            headers=auth(ensemble["outsider"]["accessToken"]),
        ).status_code
        == 403
    )

    calibration = client.put(
        "/api/calibrations",
        headers=member_headers,
        json={"deviceFingerprint": "iphone-1", "outputLabel": "speaker", "offsetMs": 12.5},
    )
    assert calibration.status_code == 200
    replaced = client.put(
        "/api/calibrations",
        headers=member_headers,
        json={"deviceFingerprint": "iphone-1", "outputLabel": "speaker", "offsetMs": 8.5},
    )
    assert replaced.json()["id"] == calibration.json()["id"]
    assert replaced.json()["offsetMs"] == 8.5


def test_log_anchors_require_a_renderable_shape_and_matching_repertoire(
    client: TestClient, ensemble: dict[str, Any]
) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    leader_headers = auth(ensemble["leader"]["accessToken"])
    for anchors in ([{}], [{"scoreId": "partial", "page": 1, "x": 0.2}]):
        response = client.post(
            f"/api/repertoire/{repertoire_id}/logs",
            headers=leader_headers,
            json={"content": "Invalid anchor", "anchors": anchors},
        )
        assert response.status_code == 422

    matching_score = _uploaded_score(client, ensemble)
    score_measure_anchor = client.post(
        f"/api/repertoire/{repertoire_id}/logs",
        headers=leader_headers,
        json={
            "content": "Part-specific measure",
            "anchors": [{"measureNumber": 8, "scoreId": matching_score["id"]}],
        },
    )
    assert score_measure_anchor.status_code == 201, score_measure_anchor.text

    other_repertoire = client.post(
        f"/api/projects/{ensemble['project']['id']}/repertoire",
        headers=leader_headers,
        json={"title": "Other piece", "composer": "", "notes": ""},
    ).json()
    other_score = _uploaded_score(client, {**ensemble, "repertoire": other_repertoire})
    cross_repertoire = client.post(
        f"/api/repertoire/{repertoire_id}/logs",
        headers=leader_headers,
        json={
            "content": "Wrong score",
            "anchors": [{"scoreId": other_score["id"], "page": 1, "x": 0.2, "y": 0.3}],
        },
    )
    assert cross_repertoire.status_code == 422


def test_musicxml_parser_builds_tempo_and_repeat_draft(client: TestClient, ensemble: dict[str, Any]) -> None:
    xml = b"""<?xml version="1.0"?>
    <score-partwise version="4.0">
      <work><work-title>Etude</work-title></work>
      <part-list><score-part id="P1"><part-name>Violin</part-name></score-part></part-list>
      <part id="P1">
        <measure number="1"><attributes><time><beats>6</beats><beat-type>8</beat-type></time></attributes>
          <direction><direction-type><metronome><beat-unit>quarter</beat-unit><beat-unit-dot/>
            <per-minute>72</per-minute></metronome></direction-type><sound tempo="108"/></direction>
          <barline><repeat direction="forward"/></barline></measure>
        <measure number="2"><barline><repeat direction="backward" times="2"/></barline></measure>
      </part>
    </score-partwise>"""
    response = client.post(
        f"/api/repertoire/{ensemble['repertoire']['id']}/musicxml/draft",
        headers=auth(ensemble["leader"]["accessToken"]),
        files={"file": ("etude.musicxml", xml, "application/vnd.recordare.musicxml+xml")},
    )
    assert response.status_code == 200, response.text
    draft = response.json()
    assert draft["title"] == "Etude"
    assert draft["totalMeasures"] == 2
    assert draft["sections"][0]["beatUnit"] == "dottedQuarter"
    assert draft["sections"][0]["bpm"] == 72
    assert draft["anacrusis"] is None
    assert draft["jumps"] == [{"type": "repeat", "startMeasure": 1, "endMeasure": 2, "times": 2}]
