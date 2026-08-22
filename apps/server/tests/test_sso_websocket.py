from __future__ import annotations

from typing import Any, cast

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from starlette.testclient import WebSocketTestSession

from app.config import Settings

from .conftest import auth, tempo_map

SSO_EDGE_SECRET = "test-fmr-websocket-edge-secret-with-at-least-32-characters"


def _sso_headers(subject: str, email: str, *, edge_secret: str = SSO_EDGE_SECRET) -> dict[str, str]:
    return {
        "Remote-User": subject,
        "Remote-Email": email,
        "Remote-Name": "Central musician",
        "Remote-Groups": "user",
        "X-Portfolio-Edge-Secret": edge_secret,
    }


def _managed_sso_settings(settings: Settings) -> Settings:
    return settings.model_copy(
        update={
            "portfolio_branch": "main",
            "portfolio_auth_mode": "sso",
            "deployment_profile": "managed_local_sso",
            "sso_enabled": True,
            "sso_edge_secret": SecretStr(SSO_EDGE_SECRET),
        }
    )


def _receive_until(socket: WebSocketTestSession, message_type: str, limit: int = 10) -> dict[str, Any]:
    for _ in range(limit):
        message = cast(dict[str, Any], socket.receive_json())
        if message["type"] == message_type:
            return message
    raise AssertionError(f"did not receive {message_type}")


def _assert_unauthorized(
    client: TestClient,
    path: str,
    join_frame: dict[str, Any],
    headers: dict[str, str] | None = None,
) -> None:
    connection = (
        client.websocket_connect(path) if headers is None else client.websocket_connect(path, headers=headers)
    )
    with connection as socket:
        socket.send_json(join_frame)
        error = socket.receive_json()
        assert error["type"] == "ERROR"
        assert error["payload"]["code"] == "UNAUTHORIZED"


def test_sso_websockets_require_matching_subject_and_edge_secret(
    client: TestClient,
    ensemble: dict[str, Any],
    settings: Settings,
) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    leader = ensemble["leader"]
    leader_headers = auth(leader["accessToken"])
    created_map = client.put(
        f"/api/repertoire/{repertoire_id}/tempomap",
        headers=leader_headers,
        json={"expectedRevision": 0, "data": tempo_map(repertoire_id)},
    )
    assert created_map.status_code == 200, created_map.text
    room_response = client.post(
        "/api/rooms",
        headers=leader_headers,
        json={"repertoireId": repertoire_id},
    )
    assert room_response.status_code == 201, room_response.text
    room_id = room_response.json()["roomId"]

    cast(FastAPI, client.app).state.settings = _managed_sso_settings(settings)
    subject = "central-leader"
    email = leader["user"]["email"]
    exchange = client.post("/api/auth/sso", headers=_sso_headers(subject, email))
    assert exchange.status_code == 200, exchange.text
    access_token = exchange.json()["accessToken"]

    endpoints = (
        (
            f"/ws/rooms/{room_id}",
            {
                "type": "JOIN_ROOM",
                "requestId": "sso-room",
                "payload": {"roomId": room_id, "accessToken": access_token},
            },
            "JOINED",
        ),
        (
            f"/ws/repertoires/{repertoire_id}/annotations",
            {
                "type": "JOIN_ANNOTATIONS",
                "requestId": "sso-annotations",
                "payload": {"repertoireId": repertoire_id, "accessToken": access_token},
            },
            "ANNOTATION_JOINED",
        ),
    )

    for path, join_frame, joined_type in endpoints:
        _assert_unauthorized(client, path, join_frame)
        _assert_unauthorized(
            client,
            path,
            join_frame,
            _sso_headers(subject, email, edge_secret="wrong-edge-secret"),
        )
        _assert_unauthorized(client, path, join_frame, _sso_headers("different-subject", email))

        with client.websocket_connect(path, headers=_sso_headers(subject, email)) as socket:
            socket.send_json(join_frame)
            joined = _receive_until(socket, joined_type)
            assert joined["requestId"] == join_frame["requestId"]
