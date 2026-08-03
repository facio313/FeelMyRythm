"""실시간 세션(방) 관리 — 설계문서 §6.3.

방 상태는 메모리에 유지한다 (단일 프로세스 전제, 수평 확장 시 Redis pub/sub로 대체).
서버는 박을 스트리밍하지 않는다: "무엇을(revision), 어디서(anchor), 언제(serverStartTime)"만 합의.
"""

import secrets
import string
import time
from dataclasses import dataclass, field

from fastapi import WebSocket

from .schemas import RosterMember, TransportState

#: CMD_START 수신 → 시작까지 리드타임 (최악 RTT + 재생 준비 여유, 설계문서 §6.3)
LEAD_MS = 3000

_ROOM_CODE_ALPHABET = string.ascii_uppercase + string.digits


def server_ms() -> int:
    """서버 권위 시각 (epoch ms). PING 수신 즉시 캡처해 사용한다."""
    return time.time_ns() // 1_000_000


@dataclass
class Member:
    conn_id: str
    user_id: str
    display_name: str
    is_leader: bool
    ws: WebSocket
    rtt_ms: float | None = None


@dataclass
class Room:
    id: str
    repertoire_id: str
    creator_id: str
    tempo_map_revision: int = 0
    status: str = "idle"  # idle | playing
    anchor: dict | None = None
    server_start_time: int | None = None
    count_in: bool = True
    members: dict[str, Member] = field(default_factory=dict)

    def transport_state(self) -> TransportState:
        return TransportState(
            room_id=self.id,
            repertoire_id=self.repertoire_id,
            tempo_map_revision=self.tempo_map_revision,
            status=self.status,  # type: ignore[arg-type]
            anchor=self.anchor,
            server_start_time=self.server_start_time,
            count_in=self.count_in,
        )

    def roster(self) -> list[RosterMember]:
        return [
            RosterMember(
                user_id=m.user_id,
                display_name=m.display_name,
                is_leader=m.is_leader,
                rtt_ms=m.rtt_ms,
            )
            for m in self.members.values()
        ]


class RoomManager:
    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}

    def create(self, repertoire_id: str, creator_id: str, tempo_map_revision: int) -> Room:
        room_id = "".join(secrets.choice(_ROOM_CODE_ALPHABET) for _ in range(6))
        while room_id in self.rooms:
            room_id = "".join(secrets.choice(_ROOM_CODE_ALPHABET) for _ in range(6))
        room = Room(
            id=room_id,
            repertoire_id=repertoire_id,
            creator_id=creator_id,
            tempo_map_revision=tempo_map_revision,
        )
        self.rooms[room_id] = room
        return room

    def get(self, room_id: str) -> Room | None:
        return self.rooms.get(room_id)

    async def broadcast(self, room: Room, message: dict) -> None:
        dead: list[str] = []
        for conn_id, member in list(room.members.items()):
            try:
                await member.ws.send_json(message)
            except Exception:
                dead.append(conn_id)
        for conn_id in dead:
            room.members.pop(conn_id, None)

    async def broadcast_transport(self, room: Room) -> None:
        await self.broadcast(
            room, {"type": "TRANSPORT", "state": room.transport_state().model_dump(by_alias=True)}
        )

    async def broadcast_roster(self, room: Room) -> None:
        await self.broadcast(
            room,
            {"type": "ROOM_ROSTER", "members": [m.model_dump(by_alias=True) for m in room.roster()]},
        )

    async def notify_tempomap_updated(self, repertoire_id: str, revision: int) -> None:
        """템포맵 수정 시 해당 곡의 모든 방에 알림 (설계문서 §6.3 TEMPOMAP_UPDATED)"""
        for room in self.rooms.values():
            if room.repertoire_id == repertoire_id:
                room.tempo_map_revision = revision
                await self.broadcast(room, {"type": "TEMPOMAP_UPDATED", "revision": revision})

    def remove_if_empty(self, room: Room) -> None:
        if not room.members:
            self.rooms.pop(room.id, None)


manager = RoomManager()
