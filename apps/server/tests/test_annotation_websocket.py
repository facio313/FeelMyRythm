from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from starlette.testclient import WebSocketTestSession

from .conftest import auth


def _text_annotation(text: str, measure_number: int = 1) -> dict[str, Any]:
    return {
        "kind": "text",
        "page": 1,
        "measureNumber": measure_number,
        "payload": {
            "x": 0.4,
            "y": 0.3,
            "text": text,
            "anchorType": "measure",
        },
    }


def _uploaded_score(client: TestClient, ensemble: dict[str, Any]) -> dict[str, Any]:
    repertoire_id = ensemble["repertoire"]["id"]
    headers = auth(ensemble["leader"]["accessToken"])
    payload = b"%PDF-1.7\nannotation-sync"
    presign = client.post(
        f"/api/repertoire/{repertoire_id}/scores/presign",
        headers=headers,
        json={
            "filename": "annotation-part.pdf",
            "contentType": "application/pdf",
            "sizeBytes": len(payload),
            "kind": "part",
            "instrument": "violin",
        },
    )
    assert presign.status_code == 201, presign.text
    target = presign.json()
    assert client.put(target["uploadUrl"], content=payload, headers=target["headers"]).status_code == 204
    completed = client.post(
        f"/api/scores/{target['scoreId']}/complete",
        headers=headers,
        json={"sizeBytes": len(payload)},
    )
    assert completed.status_code == 200, completed.text
    return completed.json()


def _join_annotations(
    socket: WebSocketTestSession,
    repertoire_id: str,
    access_token: str,
) -> list[dict[str, Any]]:
    socket.send_json(
        {
            "type": "JOIN_ANNOTATIONS",
            "requestId": "annotation-join",
            "payload": {
                "repertoireId": repertoire_id,
                "accessToken": access_token,
            },
        }
    )
    joined = socket.receive_json()
    assert joined["type"] == "ANNOTATION_JOINED"
    assert joined["requestId"] == "annotation-join"
    assert joined["payload"]["repertoireId"] == repertoire_id
    assert joined["payload"]["userId"]
    snapshot = socket.receive_json()
    assert snapshot["type"] == "ANNOTATION_SNAPSHOT"
    assert snapshot["payload"]["repertoireId"] == repertoire_id
    return snapshot["payload"]["annotations"]


def test_annotation_socket_snapshot_visibility_events_and_reconnect(
    client: TestClient,
    ensemble: dict[str, Any],
) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    score_id = _uploaded_score(client, ensemble)["id"]
    leader_token = ensemble["leader"]["accessToken"]
    member_token = ensemble["member"]["accessToken"]
    member_headers = auth(member_token)
    leader_headers = auth(leader_token)

    private_row = client.post(
        f"/api/scores/{score_id}/annotations",
        headers=member_headers,
        json={"scope": "private", "data": _text_annotation("private")},
    ).json()
    project_row = client.post(
        f"/api/scores/{score_id}/annotations",
        headers=member_headers,
        json={"scope": "project", "data": _text_annotation("shared")},
    ).json()

    path = f"/ws/repertoires/{repertoire_id}/annotations"
    with client.websocket_connect(path) as leader_ws:
        leader_snapshot = _join_annotations(leader_ws, repertoire_id, leader_token)
        assert [item["id"] for item in leader_snapshot] == [project_row["id"]]

        with client.websocket_connect(path) as member_ws:
            member_snapshot = _join_annotations(member_ws, repertoire_id, member_token)
            assert {item["id"] for item in member_snapshot} == {
                private_row["id"],
                project_row["id"],
            }

            created_private = client.post(
                f"/api/scores/{score_id}/annotations",
                headers=member_headers,
                json={"scope": "private", "data": _text_annotation("private live")},
            )
            assert created_private.status_code == 201
            member_private_event = member_ws.receive_json()
            assert member_private_event["type"] == "ANNOTATION_EVENT"
            assert member_private_event["payload"]["annotationId"] == created_private.json()["id"]

            created_project = client.post(
                f"/api/scores/{score_id}/annotations",
                headers=member_headers,
                json={"scope": "project", "data": _text_annotation("shared live")},
            )
            assert created_project.status_code == 201
            for socket in (leader_ws, member_ws):
                event = socket.receive_json()
                assert event["type"] == "ANNOTATION_EVENT"
                assert event["payload"]["operation"] == "upsert"
                assert event["payload"]["annotationId"] == created_project.json()["id"]
                assert event["payload"]["annotation"]["revision"] == 1

            updated = client.put(
                f"/api/annotations/{created_project.json()['id']}",
                headers=leader_headers,
                json={
                    "expectedRevision": 1,
                    "data": _text_annotation("leader update", 2),
                },
            )
            assert updated.status_code == 200
            for socket in (leader_ws, member_ws):
                event = socket.receive_json()
                assert event["payload"]["operation"] == "upsert"
                assert event["payload"]["revision"] == 2
                assert event["payload"]["annotation"]["data"]["payload"]["text"] == "leader update"

            deleted = client.delete(
                f"/api/annotations/{created_project.json()['id']}",
                headers=member_headers,
            )
            assert deleted.status_code == 204
            for socket in (leader_ws, member_ws):
                event = socket.receive_json()
                assert event["payload"] == {
                    "eventId": event["payload"]["eventId"],
                    "repertoireId": repertoire_id,
                    "operation": "delete",
                    "annotationId": created_project.json()["id"],
                    "revision": 2,
                    "scope": "project",
                    "authorId": ensemble["member"]["user"]["id"],
                    "annotation": None,
                }

            member_ws.send_json(
                {
                    "type": "ANNOTATION_PING",
                    "requestId": "keepalive",
                    "payload": {"nonce": "nonce-1"},
                }
            )
            assert member_ws.receive_json() == {
                "type": "ANNOTATION_PONG",
                "requestId": "keepalive",
                "payload": {"nonce": "nonce-1"},
            }

    missed = client.post(
        f"/api/scores/{score_id}/annotations",
        headers=member_headers,
        json={"scope": "project", "data": _text_annotation("created while disconnected")},
    )
    assert missed.status_code == 201
    with client.websocket_connect(path) as reconnected:
        recovered = _join_annotations(reconnected, repertoire_id, leader_token)
        recovered_ids = {item["id"] for item in recovered}
        assert missed.json()["id"] in recovered_ids
        assert created_project.json()["id"] not in recovered_ids


def test_annotation_socket_rejects_invalid_first_frame_and_nonmember(
    client: TestClient,
    ensemble: dict[str, Any],
) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    path = f"/ws/repertoires/{repertoire_id}/annotations"
    with client.websocket_connect(path) as invalid:
        invalid.send_json({"type": "ANNOTATION_PING", "payload": {"nonce": "too-soon"}})
        assert invalid.receive_json()["payload"]["code"] == "INVALID_MESSAGE"

    with client.websocket_connect(path) as outsider:
        outsider.send_json(
            {
                "type": "JOIN_ANNOTATIONS",
                "payload": {
                    "repertoireId": repertoire_id,
                    "accessToken": ensemble["outsider"]["accessToken"],
                },
            }
        )
        error = outsider.receive_json()
        assert error["type"] == "ERROR"
        assert error["payload"]["code"] == "UNAUTHORIZED"
