from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Any

import pytest
import redis
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketTestSession

from app.config import Settings
from app.main import create_app

from .conftest import FakeMailSender, auth, register, tempo_map


def _recv_until(socket: WebSocketTestSession, message_type: str, limit: int = 20) -> dict[str, Any]:
    for _ in range(limit):
        message = socket.receive_json()
        if message["type"] == message_type:
            return message
    raise AssertionError(f"did not receive {message_type}")


def _join(socket: WebSocketTestSession, room_id: str, access_token: str) -> None:
    socket.send_json(
        {
            "type": "JOIN_ROOM",
            "payload": {
                "roomId": room_id,
                "accessToken": access_token,
                "bluetooth": False,
            },
        }
    )
    _recv_until(socket, "JOINED")
    _recv_until(socket, "TRANSPORT")
    _recv_until(socket, "ROOM_ROSTER")


def _create_ensemble(client: TestClient) -> dict[str, Any]:
    owner = register(client, "redis-owner@example.com", "Redis Owner")
    leader = register(client, "redis-leader@example.com", "Redis Leader")
    member = register(client, "redis-member@example.com", "Redis Member")
    group = client.post(
        "/api/groups",
        headers=auth(owner["accessToken"]),
        json={"name": "Redis Ensemble", "description": ""},
    ).json()
    for identity, role in ((leader, "leader"), (member, "member")):
        response = client.post(
            f"/api/groups/{group['id']}/members",
            headers=auth(owner["accessToken"]),
            json={"email": identity["user"]["email"], "role": role},
        )
        assert response.status_code == 201, response.text
    project = client.post(
        f"/api/groups/{group['id']}/projects",
        headers=auth(leader["accessToken"]),
        json={"name": "Redis Project", "description": ""},
    ).json()
    repertoire = client.post(
        f"/api/projects/{project['id']}/repertoire",
        headers=auth(leader["accessToken"]),
        json={"title": "Redis Piece", "composer": "", "notes": ""},
    ).json()
    return {"leader": leader, "member": member, "repertoire": repertoire}


@pytest.mark.skipif(
    not os.environ.get("FMR_REDIS_TEST_URL"),
    reason="FMR_REDIS_TEST_URL is required for the multi-instance Redis integration test",
)
def test_two_instances_share_room_roster_transport_and_recovery(tmp_path: Path) -> None:
    redis_url = os.environ["FMR_REDIS_TEST_URL"]
    key_prefix = f"fmr-test-{uuid.uuid4().hex}"
    shared_settings = Settings(
        environment="test",
        database_url=f"sqlite:///{tmp_path / 'redis-rooms.db'}",
        auto_create_schema=True,
        jwt_secret="redis-room-test-secret-generated-at-runtime-123456789",
        public_api_base_url="http://testserver",
        local_uploads_dir=tmp_path / "uploads",
        storage_worker_enabled=False,
        room_lead_time_ms=100,
        room_ttl_seconds=60,
        room_cleanup_interval_seconds=60,
        redis_url=redis_url,
        redis_key_prefix=key_prefix,
    )
    sender = FakeMailSender()
    app_one = create_app(shared_settings, mail_sender=sender)
    app_two = create_app(shared_settings, mail_sender=sender)

    try:
        with TestClient(app_one) as first, TestClient(app_two) as second:
            ensemble = _create_ensemble(first)
            repertoire_id = ensemble["repertoire"]["id"]
            leader_token = ensemble["leader"]["accessToken"]
            member_token = ensemble["member"]["accessToken"]
            saved_map = first.put(
                f"/api/repertoire/{repertoire_id}/tempomap",
                headers=auth(leader_token),
                json={"expectedRevision": 0, "data": tempo_map(repertoire_id)},
            )
            assert saved_map.status_code == 200, saved_map.text
            created = first.post(
                "/api/rooms",
                headers=auth(leader_token),
                json={"repertoireId": repertoire_id},
            )
            assert created.status_code == 201, created.text
            room_id = created.json()["roomId"]

            recovered = second.get(f"/api/rooms/{room_id}", headers=auth(member_token))
            assert recovered.status_code == 200
            assert recovered.json()["tempoMapRevision"] == 1

            with first.websocket_connect(f"/ws/rooms/{room_id}") as member_ws:
                _join(member_ws, room_id, member_token)
                with second.websocket_connect(f"/ws/rooms/{room_id}") as leader_ws:
                    _join(leader_ws, room_id, leader_token)
                    member_roster = _recv_until(member_ws, "ROOM_ROSTER")
                    assert {item["displayName"] for item in member_roster["payload"]["members"]} == {
                        "Redis Leader",
                        "Redis Member",
                    }

                    member_ws.send_json(
                        {"type": "READY", "requestId": "redis-ready", "payload": {"ready": True}}
                    )
                    ready_roster = _recv_until(leader_ws, "ROOM_ROSTER")
                    ready_member = next(
                        item
                        for item in ready_roster["payload"]["members"]
                        if item["displayName"] == "Redis Member"
                    )
                    assert ready_member["ready"] is True

                    leader_ws.send_json(
                        {
                            "type": "CMD_START",
                            "requestId": "redis-start",
                            "payload": {"measure": 2, "pass": 1, "countIn": True},
                        }
                    )
                    leader_transport = _recv_until(leader_ws, "TRANSPORT")
                    member_transport = _recv_until(member_ws, "TRANSPORT")
                    assert leader_transport["payload"]["anchor"] == {"measure": 2, "pass": 1}
                    assert member_transport["payload"] == leader_transport["payload"]
                    assert member_transport["requestId"] == "redis-start"

            lock_probe = redis.Redis.from_url(redis_url, decode_responses=True)
            lock_key = f"{key_prefix}:rooms:{room_id}:lock"
            assert lock_probe.get(lock_key) is None, (
                lock_probe.get(lock_key),
                lock_probe.pttl(lock_key),
            )
            lock_probe.close()
            with second.websocket_connect(f"/ws/rooms/{room_id}") as late_ws:
                _join(late_ws, room_id, member_token)
                late_ws.send_json({"type": "PING", "requestId": "redis-ping", "payload": {"t0": 123}})
                assert _recv_until(late_ws, "PONG")["requestId"] == "redis-ping"
                refreshed_transport = _recv_until(late_ws, "TRANSPORT")
                assert refreshed_transport["payload"]["anchor"] == {"measure": 2, "pass": 1}
    finally:
        cleanup = redis.Redis.from_url(redis_url, decode_responses=True)
        keys = list(cleanup.scan_iter(match=f"{key_prefix}:*"))
        if keys:
            cleanup.delete(*keys)
        cleanup.close()
