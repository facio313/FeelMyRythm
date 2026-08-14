from __future__ import annotations

import time
from typing import Any

from fastapi.testclient import TestClient
from starlette.testclient import WebSocketTestSession

from .conftest import auth, tempo_map


def _recv_until(socket: WebSocketTestSession, message_type: str, limit: int = 20) -> dict[str, Any]:
    for _ in range(limit):
        message = socket.receive_json()
        if message["type"] == message_type:
            return message
    raise AssertionError(f"did not receive {message_type}")


def _join(
    socket: WebSocketTestSession,
    room_id: str,
    token: str,
    *,
    bluetooth: bool = False,
) -> dict[str, Any]:
    socket.send_json(
        {
            "type": "JOIN_ROOM",
            "requestId": "join-1",
            "payload": {"roomId": room_id, "accessToken": token, "bluetooth": bluetooth},
        }
    )
    joined = _recv_until(socket, "JOINED")
    transport = _recv_until(socket, "TRANSPORT")
    _recv_until(socket, "ROOM_ROSTER")
    assert joined["requestId"] == "join-1"
    return transport


def test_websocket_clock_transport_permissions_roster_revision_and_late_join(
    client: TestClient, ensemble: dict[str, Any]
) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    leader_token = ensemble["leader"]["accessToken"]
    member_token = ensemble["member"]["accessToken"]
    owner_token = ensemble["owner"]["accessToken"]
    leader_headers = auth(leader_token)
    pinned_map = tempo_map(repertoire_id)
    pinned_map["jumps"] = [{"type": "repeat", "startMeasure": 25, "endMeasure": 32, "times": 2}]
    created_map = client.put(
        f"/api/repertoire/{repertoire_id}/tempomap",
        headers=leader_headers,
        json={"expectedRevision": 0, "data": pinned_map},
    )
    assert created_map.status_code == 200
    room_response = client.post("/api/rooms", headers=leader_headers, json={"repertoireId": repertoire_id})
    assert room_response.status_code == 201, room_response.text
    room_id = room_response.json()["roomId"]

    with client.websocket_connect(f"/ws/rooms/{room_id}") as member_ws:
        member_transport = _join(member_ws, room_id, member_token, bluetooth=True)
        assert member_transport["payload"]["tempoMapRevision"] == 1
        assert member_transport["payload"]["status"] == "idle"
        assert member_transport["payload"]["anchor"] is None
        assert member_transport["payload"]["serverStartTimeNs"] is None
        with client.websocket_connect(f"/ws/rooms/{room_id}") as leader_ws:
            _join(leader_ws, room_id, leader_token)
            roster = _recv_until(member_ws, "ROOM_ROSTER")
            assert {item["displayName"] for item in roster["payload"]["members"]} == {
                "Leader",
                "Member",
            }

            before_ping = time.time_ns()
            member_ws.send_json({"type": "PING", "requestId": "ping-1", "payload": {"t0": 123456}})
            pong = _recv_until(member_ws, "PONG")
            assert pong["requestId"] == "ping-1"
            assert pong["payload"]["t0"] == 123456
            assert pong["payload"]["serverReceiveTimeNs"] >= before_ping

            member_ws.send_json({"type": "READY", "payload": {"ready": True}, "requestId": "ready-1"})
            roster = _recv_until(member_ws, "ROOM_ROSTER")
            ready_member = next(
                item for item in roster["payload"]["members"] if item["displayName"] == "Member"
            )
            assert ready_member["bluetooth"] is True
            assert ready_member["rttMs"] is None
            assert ready_member["ready"] is True

            member_ws.send_json(
                {
                    "type": "CMD_START",
                    "requestId": "member-start",
                    "payload": {"measure": 26, "pass": 1, "countIn": True},
                }
            )
            denied = _recv_until(member_ws, "ERROR")
            assert denied["requestId"] == "member-start"
            assert denied["payload"]["code"] == "FORBIDDEN"

            leader_ws.send_json(
                {
                    "type": "CMD_START",
                    "requestId": "invalid-pass",
                    "payload": {"measure": 12, "pass": 2, "countIn": True},
                }
            )
            invalid_pass = _recv_until(leader_ws, "ERROR")
            assert invalid_pass["requestId"] == "invalid-pass"
            assert invalid_pass["payload"]["code"] == "INVALID_ANCHOR"

            before_start = time.time_ns()
            leader_ws.send_json(
                {
                    "type": "CMD_START",
                    "requestId": "leader-start",
                    "payload": {"measure": 26, "pass": 2, "countIn": True},
                }
            )
            leader_transport = _recv_until(leader_ws, "TRANSPORT")
            member_transport = _recv_until(member_ws, "TRANSPORT")
            for transport in (leader_transport, member_transport):
                assert transport["requestId"] == "leader-start"
                assert transport["payload"]["anchor"] == {"measure": 26, "pass": 2}
                assert transport["payload"]["status"] == "armed"
                assert transport["payload"]["serverStartTimeNs"] > before_start
            assert (
                leader_transport["payload"]["serverStartTimeNs"]
                == member_transport["payload"]["serverStartTimeNs"]
            )

            with client.websocket_connect(f"/ws/rooms/{room_id}") as late_ws:
                late_transport = _join(late_ws, room_id, owner_token)
                assert late_transport["payload"]["lateJoin"]["strategy"] == "next-measure-boundary"
                assert late_transport["payload"]["lateJoin"]["elapsedNs"] >= 0

                updated_map = client.put(
                    f"/api/repertoire/{repertoire_id}/tempomap",
                    headers=leader_headers,
                    json={
                        "expectedRevision": 1,
                        "data": tempo_map(repertoire_id, 1, total_measures=8),
                    },
                )
                assert updated_map.status_code == 200
                room_metadata = client.get(f"/api/rooms/{room_id}", headers=leader_headers)
                assert room_metadata.json()["tempoMapRevision"] == 1

            leader_ws.send_json(
                {
                    "type": "CMD_SEEK",
                    "requestId": "seek-1",
                    "payload": {"measure": 12, "pass": 1},
                }
            )
            seek_transport = _recv_until(leader_ws, "TRANSPORT")
            assert seek_transport["payload"]["anchor"] == {
                "measure": 12,
                "pass": 1,
            }
            assert seek_transport["payload"]["tempoMapRevision"] == 1
            _recv_until(member_ws, "TRANSPORT")
            leader_ws.send_json({"type": "CMD_STOP", "payload": {}, "requestId": "stop-1"})
            assert _recv_until(leader_ws, "TRANSPORT")["payload"]["status"] == "stopped"
            assert _recv_until(member_ws, "TRANSPORT")["payload"]["status"] == "stopped"

    session_rows = client.get(
        f"/api/repertoire/{repertoire_id}/practice-sessions",
        headers=auth(member_token),
    )
    assert session_rows.status_code == 200
    assert session_rows.json()[0]["tempoMapRevision"] == 1


def test_websocket_rejects_nonmember_and_room_ttl_expires(
    client: TestClient, ensemble: dict[str, Any]
) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    leader_headers = auth(ensemble["leader"]["accessToken"])
    assert (
        client.put(
            f"/api/repertoire/{repertoire_id}/tempomap",
            headers=leader_headers,
            json={"expectedRevision": 0, "data": tempo_map(repertoire_id)},
        ).status_code
        == 200
    )
    room_id = client.post("/api/rooms", headers=leader_headers, json={"repertoireId": repertoire_id}).json()[
        "roomId"
    ]
    with client.websocket_connect(f"/ws/rooms/{room_id}") as socket:
        socket.send_json(
            {
                "type": "JOIN_ROOM",
                "payload": {
                    "roomId": room_id,
                    "accessToken": ensemble["outsider"]["accessToken"],
                },
            }
        )
        error = socket.receive_json()
        assert error["type"] == "ERROR"
        assert error["payload"]["code"] == "UNAUTHORIZED"

    room = client.app.state.rooms.rooms[room_id]
    room.expires_at_ns = 0
    assert client.get(f"/api/rooms/{room_id}", headers=leader_headers).status_code == 404


def test_websocket_rechecks_transport_role_after_demotion(
    client: TestClient, ensemble: dict[str, Any]
) -> None:
    repertoire_id = ensemble["repertoire"]["id"]
    leader = ensemble["leader"]
    owner = ensemble["owner"]
    group_id = ensemble["group"]["id"]
    assert (
        client.put(
            f"/api/repertoire/{repertoire_id}/tempomap",
            headers=auth(leader["accessToken"]),
            json={"expectedRevision": 0, "data": tempo_map(repertoire_id)},
        ).status_code
        == 200
    )
    room_id = client.post(
        "/api/rooms",
        headers=auth(leader["accessToken"]),
        json={"repertoireId": repertoire_id},
    ).json()["roomId"]

    with client.websocket_connect(f"/ws/rooms/{room_id}") as socket:
        _join(socket, room_id, leader["accessToken"])
        demoted = client.patch(
            f"/api/groups/{group_id}/members/{leader['user']['id']}",
            headers=auth(owner["accessToken"]),
            json={"role": "member"},
        )
        assert demoted.status_code == 200
        socket.send_json(
            {
                "type": "CMD_START",
                "requestId": "stale-leader",
                "payload": {"measure": 1, "pass": 1, "countIn": True},
            }
        )
        roster = _recv_until(socket, "ROOM_ROSTER")
        assert roster["payload"]["members"][0]["role"] == "member"
        denied = _recv_until(socket, "ERROR")
        assert denied["requestId"] == "stale-leader"
        assert denied["payload"]["code"] == "FORBIDDEN"

        removed = client.delete(
            f"/api/groups/{group_id}/members/{leader['user']['id']}",
            headers=auth(owner["accessToken"]),
        )
        assert removed.status_code == 204
        socket.send_json({"type": "READY", "requestId": "removed-member", "payload": {"ready": True}})
        unauthorized = _recv_until(socket, "ERROR")
        assert unauthorized["requestId"] == "removed-member"
        assert unauthorized["payload"]["code"] == "UNAUTHORIZED"
