from __future__ import annotations

import asyncio
import contextlib
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, cast

from fastapi import WebSocket
from sqlalchemy import select

from .config import Settings
from .db import Database
from .models import GroupMember, PracticeSession, Project, RepertoireItem, TempoMapRevision, utcnow
from .redis_rooms import RedisRoomBackend, RoomLockTimeoutError
from .schemas import (
    Anchor,
    LateJoinMetadata,
    Role,
    RosterMember,
    ServerEnvelope,
    ServerMessageType,
    TempoMapCoda,
    TempoMapDaCapo,
    TempoMapDalSegno,
    TempoMapData,
    TempoMapRepeat,
    TransportPayload,
    TransportStatus,
)

MAX_TIMELINE_ENTRIES = 100_000


class RoomMissingError(LookupError):
    pass


class TransportPermissionError(PermissionError):
    pass


class RoomMembershipError(PermissionError):
    pass


class RoomConnectionReplacedError(PermissionError):
    pass


@dataclass
class Participant:
    websocket: WebSocket
    user_id: str
    display_name: str
    role: Role
    calibrated: bool
    bluetooth: bool
    connection_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    ready: bool = False
    rtt_ms: float | None = None


@dataclass
class Room:
    room_id: str
    session_id: str
    repertoire_id: str
    leader_id: str
    tempo_map_revision: int
    total_measures: int
    valid_anchors: frozenset[tuple[int, int]]
    ttl_ns: int
    status: TransportStatus = "idle"
    anchor_measure: int | None = None
    anchor_pass: int | None = None
    server_start_time_ns: int | None = None
    count_in: bool = True
    expires_at_ns: int = 0
    participants: dict[str, Participant] = field(default_factory=dict)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def touch(self) -> None:
        self.expires_at_ns = time.time_ns() + self.ttl_ns


class RoomManager:
    def __init__(self, database: Database, settings: Settings) -> None:
        self.database = database
        self.settings = settings
        self.rooms: dict[str, Room] = {}
        self._cleanup_task: asyncio.Task[None] | None = None
        self.redis = RedisRoomBackend(settings, self._handle_redis_event) if settings.redis_url else None
        self.instance_id = self.redis.instance_id if self.redis is not None else str(uuid.uuid4())

    async def start(self) -> None:
        if self.redis is not None:
            await self.redis.start()
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def stop(self) -> None:
        if self._cleanup_task:
            self._cleanup_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._cleanup_task
            self._cleanup_task = None
        if self.redis is not None:
            await self.redis.stop()

    def check_health(self) -> None:
        if self.redis is not None:
            self.redis.sync.ping()

    async def _cleanup_loop(self) -> None:
        while True:
            await asyncio.sleep(self.settings.room_cleanup_interval_seconds)
            await self.expire_rooms()

    async def expire_rooms(self) -> None:
        now = time.time_ns()
        if self.redis is not None:
            due_room_ids = await asyncio.to_thread(self.redis.due_room_ids, now)
            for room_id in due_room_ids:
                try:
                    async with self.redis.room_lock(room_id):
                        state = await asyncio.to_thread(self.redis.load_room, room_id)
                        if state is not None and int(state["expiresAtNs"]) > now:
                            continue
                        roster = await asyncio.to_thread(self.redis.roster, room_id)
                        if state is not None and roster:
                            state["expiresAtNs"] = (
                                now + self.settings.room_presence_ttl_seconds * 1_000_000_000
                            )
                            await asyncio.to_thread(self.redis.save_room, room_id, state)
                            continue
                        session_id = await asyncio.to_thread(self.redis.remove_room, room_id)
                        self.rooms.pop(room_id, None)
                        if session_id is not None:
                            self._persist_ended_session(session_id)
                        await self.redis.publish(room_id, "expired", {})
                except RoomLockTimeoutError:
                    continue
            return
        expired = [
            room_id
            for room_id, room in self.rooms.items()
            if not room.participants and room.expires_at_ns <= now
        ]
        for room_id in expired:
            room = self.rooms.pop(room_id)
            self._persist(room, ended=True)

    def create_room(
        self,
        *,
        repertoire_id: str,
        leader_id: str,
        tempo_map_revision: int,
        total_measures: int,
    ) -> Room:
        with self.database.session_factory() as db:
            tempo_map_row = db.scalar(
                select(TempoMapRevision).where(
                    TempoMapRevision.repertoire_id == repertoire_id,
                    TempoMapRevision.revision == tempo_map_revision,
                )
            )
            if tempo_map_row is None:
                raise ValueError("the pinned tempo map revision does not exist")
            tempo_map = TempoMapData.model_validate(tempo_map_row.data)
        if tempo_map.total_measures != total_measures:
            raise ValueError("the pinned tempo map totalMeasures is inconsistent")
        room_id = str(uuid.uuid4())
        session = PracticeSession(
            room_id=room_id,
            repertoire_id=repertoire_id,
            leader_id=leader_id,
            tempo_map_revision=tempo_map_revision,
        )
        with self.database.session_factory() as db:
            db.add(session)
            db.commit()
            db.refresh(session)
        room = Room(
            room_id=room_id,
            session_id=session.id,
            repertoire_id=repertoire_id,
            leader_id=leader_id,
            tempo_map_revision=tempo_map_revision,
            total_measures=total_measures,
            valid_anchors=tempo_map_anchors(tempo_map),
            ttl_ns=self.settings.room_ttl_seconds * 1_000_000_000,
        )
        room.touch()
        self.rooms[room_id] = room
        self._save_shared(room)
        return room

    def get(self, room_id: str) -> Room:
        if self.redis is not None:
            state = self.redis.load_room(room_id)
            if state is None:
                self.rooms.pop(room_id, None)
                raise RoomMissingError(room_id)
            if int(state["expiresAtNs"]) <= time.time_ns():
                roster = self.redis.roster(room_id)
                if not roster:
                    session_id = self.redis.remove_room(room_id)
                    self.rooms.pop(room_id, None)
                    if session_id is not None:
                        self._persist_ended_session(session_id)
                    raise RoomMissingError(room_id)
                state["expiresAtNs"] = (
                    time.time_ns() + self.settings.room_presence_ttl_seconds * 1_000_000_000
                )
                self.redis.save_room(room_id, state)
            room = self.rooms.get(room_id)
            if room is None:
                room = self._room_from_state(state)
                self.rooms[room_id] = room
            else:
                self._apply_state(room, state)
            self._load_persisted_transport(room)
            return room
        room = self.rooms.get(room_id)
        if room is None or (not room.participants and room.expires_at_ns <= time.time_ns()):
            if room is not None:
                self.rooms.pop(room_id, None)
                self._persist(room, ended=True)
            raise RoomMissingError(room_id)
        return room

    async def join(self, room: Room, participant: Participant, request_id: str | None = None) -> None:
        # Commit the shared-room/presence mutations before exposing the participant to this
        # process. A lock timeout must not leave a half-joined local connection behind.
        await self._touch_shared(room)
        if self.redis is not None:
            previous = await asyncio.to_thread(
                self.redis.register_participant,
                room.room_id,
                self._participant_state(participant),
            )
            if previous is not None and previous.get("connectionId") != participant.connection_id:
                await self.redis.publish(
                    room.room_id,
                    "replace",
                    {
                        "userId": participant.user_id,
                        "connectionId": previous.get("connectionId"),
                        "instanceId": previous.get("instanceId"),
                    },
                )
        old = room.participants.get(participant.user_id)
        if old is not None and old.websocket is not participant.websocket:
            with contextlib.suppress(Exception):
                await old.websocket.close(code=4000, reason="replaced by a newer connection")
        room.participants[participant.user_id] = participant
        await self.send(
            participant.websocket,
            "JOINED",
            {"userId": participant.user_id, "role": participant.role},
            request_id,
        )
        await self.send_transport(room, participant.websocket, late_join=True)
        await self.broadcast_roster(room)

    async def leave(self, room: Room, user_id: str, websocket: WebSocket) -> None:
        participant = room.participants.get(user_id)
        if participant is not None and participant.websocket is websocket:
            room.participants.pop(user_id, None)
            shared_available = self.redis is None
            if self.redis is not None:
                shared_available = await asyncio.to_thread(self.redis.load_room, room.room_id) is not None
            if self.redis is None:
                room.touch()
            if self.redis is not None:
                with contextlib.suppress(Exception):
                    await asyncio.to_thread(
                        self.redis.remove_participant,
                        room.room_id,
                        user_id,
                        participant.connection_id,
                    )
            if shared_available:
                await self.broadcast_roster(room)

    @staticmethod
    async def send(
        websocket: WebSocket,
        message_type: ServerMessageType,
        payload: dict[str, Any],
        request_id: str | None = None,
    ) -> None:
        envelope = ServerEnvelope(type=message_type, request_id=request_id, payload=payload)
        await websocket.send_json(envelope.model_dump(by_alias=True))

    async def broadcast(
        self,
        room: Room,
        message_type: ServerMessageType,
        payload: dict[str, Any],
        request_id: str | None = None,
    ) -> None:
        stale: list[str] = []
        for user_id, participant in list(room.participants.items()):
            try:
                await self.send(participant.websocket, message_type, payload, request_id)
            except Exception:
                stale.append(user_id)
        for user_id in stale:
            room.participants.pop(user_id, None)

    def transport_payload(self, room: Room, *, late_join: bool) -> TransportPayload:
        now_ns = time.time_ns()
        if (
            room.status == "armed"
            and room.server_start_time_ns is not None
            and now_ns >= room.server_start_time_ns
        ):
            room.status = "playing"
            self._persist(room)
            self._save_shared(room)
        metadata = None
        if late_join and room.server_start_time_ns is not None:
            metadata = LateJoinMetadata(
                server_now_ns=now_ns,
                elapsed_ns=max(0, now_ns - room.server_start_time_ns),
                strategy="next-measure-boundary",
            )
        anchor = None
        if room.anchor_measure is not None and room.anchor_pass is not None:
            anchor = Anchor.model_validate({"measure": room.anchor_measure, "pass": room.anchor_pass})
        return TransportPayload(
            room_id=room.room_id,
            repertoire_id=room.repertoire_id,
            tempo_map_revision=room.tempo_map_revision,
            status=room.status,
            anchor=anchor,
            server_start_time_ns=room.server_start_time_ns,
            count_in=room.count_in,
            late_join=metadata,
        )

    async def send_transport(self, room: Room, websocket: WebSocket, *, late_join: bool) -> None:
        payload = self.transport_payload(room, late_join=late_join)
        await self.send(websocket, "TRANSPORT", payload.model_dump(by_alias=True))

    async def broadcast_transport(self, room: Room, request_id: str | None = None) -> None:
        payload = self.transport_payload(room, late_join=False)
        raw_payload = payload.model_dump(by_alias=True)
        await self.broadcast(
            room,
            "TRANSPORT",
            raw_payload,
            request_id,
        )
        if self.redis is not None:
            await self.redis.publish(
                room.room_id,
                "transport",
                {"message": raw_payload, "requestId": request_id},
            )

    async def broadcast_roster(self, room: Room) -> None:
        if self.redis is not None:
            raw_members = await asyncio.to_thread(self.redis.roster, room.room_id)
            members = [
                RosterMember(
                    user_id=str(item["userId"]),
                    display_name=str(item["displayName"]),
                    role=cast(Role, item["role"]),
                    ready=bool(item["ready"]),
                    rtt_ms=float(item["rttMs"]) if item.get("rttMs") is not None else None,
                    calibrated=bool(item["calibrated"]),
                    bluetooth=bool(item["bluetooth"]),
                ).model_dump(by_alias=True)
                for item in raw_members
            ]
        else:
            members = [
                RosterMember(
                    user_id=participant.user_id,
                    display_name=participant.display_name,
                    role=participant.role,
                    ready=participant.ready,
                    rtt_ms=participant.rtt_ms,
                    calibrated=participant.calibrated,
                    bluetooth=participant.bluetooth,
                ).model_dump(by_alias=True)
                for participant in room.participants.values()
            ]
        members.sort(key=lambda item: str(item["userId"]))
        payload = {"members": members}
        await self.broadcast(room, "ROOM_ROSTER", payload)
        if self.redis is not None:
            await self.redis.publish(room.room_id, "roster", {"message": payload})

    async def synchronize_participant(self, room: Room, participant: Participant) -> None:
        self.refresh_participant_role(room, participant)
        if self.redis is not None:
            async with self.redis.room_lock(room.room_id):
                state = await asyncio.to_thread(self.redis.load_room, room.room_id)
                if state is None:
                    raise RoomMissingError(room.room_id)
                self._apply_state(room, state)
                self._load_persisted_transport(room)
                room.touch()
                await asyncio.to_thread(
                    self.redis.save_room,
                    room.room_id,
                    self._room_state(room),
                )
                current = await asyncio.to_thread(
                    self.redis.update_participant,
                    room.room_id,
                    self._participant_state(participant),
                )
            if not current:
                raise RoomConnectionReplacedError("room connection was replaced")
            return
        room.touch()

    async def _touch_shared(self, room: Room) -> None:
        if self.redis is None:
            room.touch()
            return
        async with self.redis.room_lock(room.room_id):
            state = await asyncio.to_thread(self.redis.load_room, room.room_id)
            if state is None:
                raise RoomMissingError(room.room_id)
            self._apply_state(room, state)
            self._load_persisted_transport(room)
            room.touch()
            await asyncio.to_thread(
                self.redis.save_room,
                room.room_id,
                self._room_state(room),
            )

    def refresh_participant_role(self, room: Room, participant: Participant) -> bool:
        with self.database.session_factory() as db:
            current_role = db.scalar(
                select(GroupMember.role)
                .join(Project, Project.group_id == GroupMember.group_id)
                .join(RepertoireItem, RepertoireItem.project_id == Project.id)
                .where(
                    RepertoireItem.id == room.repertoire_id,
                    GroupMember.user_id == participant.user_id,
                )
            )
        if current_role not in {"owner", "leader", "member"}:
            raise RoomMembershipError("room membership is no longer active")
        changed = participant.role != current_role
        participant.role = cast(Role, current_role)
        return changed

    def require_transport_role(self, room: Room, participant: Participant) -> None:
        self.refresh_participant_role(room, participant)
        if participant.role not in {"owner", "leader"}:
            raise TransportPermissionError("leader role required for transport commands")

    @staticmethod
    def require_anchor(room: Room, measure: int, pass_number: int) -> None:
        if (measure, pass_number) not in room.valid_anchors:
            raise ValueError("anchor measure/pass is not in the pinned tempo map timeline")

    async def start_transport(
        self,
        room: Room,
        participant: Participant,
        measure: int,
        pass_number: int,
        count_in: bool,
        request_id: str | None,
    ) -> None:
        await self.synchronize_participant(room, participant)
        async with room.lock:
            async with self._shared_room_lock(room, participant):
                self.require_transport_role(room, participant)
                self.require_anchor(room, measure, pass_number)
                room.anchor_measure = measure
                room.anchor_pass = pass_number
                room.count_in = count_in
                room.server_start_time_ns = time.time_ns() + self.settings.room_lead_time_ms * 1_000_000
                room.status = "armed"
                room.touch()
                self._persist(room)
                self._save_shared(room)
                await self.broadcast_transport(room, request_id)

    async def stop_transport(self, room: Room, participant: Participant, request_id: str | None) -> None:
        await self.synchronize_participant(room, participant)
        async with room.lock:
            async with self._shared_room_lock(room, participant):
                self.require_transport_role(room, participant)
                room.status = "stopped"
                room.server_start_time_ns = None
                room.touch()
                self._persist(room)
                self._save_shared(room)
                await self.broadcast_transport(room, request_id)

    async def seek_transport(
        self,
        room: Room,
        participant: Participant,
        measure: int,
        pass_number: int,
        request_id: str | None,
    ) -> None:
        await self.synchronize_participant(room, participant)
        async with room.lock:
            async with self._shared_room_lock(room, participant):
                self.require_transport_role(room, participant)
                self.require_anchor(room, measure, pass_number)
                room.anchor_measure = measure
                room.anchor_pass = pass_number
                room.server_start_time_ns = time.time_ns() + self.settings.room_lead_time_ms * 1_000_000
                room.status = "armed"
                room.touch()
                self._persist(room)
                self._save_shared(room)
                await self.broadcast_transport(room, request_id)

    @asynccontextmanager
    async def _shared_room_lock(
        self,
        room: Room,
        participant: Participant | None = None,
    ) -> AsyncIterator[None]:
        if self.redis is None:
            yield
            return
        async with self.redis.room_lock(room.room_id):
            state = await asyncio.to_thread(self.redis.load_room, room.room_id)
            if state is None:
                raise RoomMissingError(room.room_id)
            self._apply_state(room, state)
            self._load_persisted_transport(room)
            if participant is not None:
                current = await asyncio.to_thread(
                    self.redis.update_participant,
                    room.room_id,
                    self._participant_state(participant),
                )
                if not current:
                    raise RoomConnectionReplacedError("room connection was replaced")
            yield

    async def _handle_redis_event(self, event: dict[str, Any]) -> None:
        room_id = event.get("roomId")
        kind = event.get("kind")
        payload = event.get("payload")
        if not isinstance(room_id, str) or not isinstance(kind, str) or not isinstance(payload, dict):
            return
        room = self.rooms.get(room_id)
        if kind == "expired":
            if room is None:
                return
            self.rooms.pop(room_id, None)
            for connected_participant in list(room.participants.values()):
                with contextlib.suppress(Exception):
                    await connected_participant.websocket.close(code=4404, reason="room expired")
            return
        if room is None:
            return
        if kind == "replace":
            if payload.get("instanceId") != self.instance_id:
                return
            user_id = payload.get("userId")
            connection_id = payload.get("connectionId")
            if not isinstance(user_id, str) or not isinstance(connection_id, str):
                return
            replacement = room.participants.get(user_id)
            if replacement is None or replacement.connection_id != connection_id:
                return
            room.participants.pop(user_id, None)
            with contextlib.suppress(Exception):
                await replacement.websocket.close(code=4000, reason="replaced by a newer connection")
            return
        message = payload.get("message")
        if not isinstance(message, dict):
            return
        if kind == "transport":
            request_id = payload.get("requestId")
            await self.broadcast(
                room,
                "TRANSPORT",
                message,
                request_id if isinstance(request_id, str) else None,
            )
        elif kind == "roster":
            await self.broadcast(room, "ROOM_ROSTER", message)

    def _participant_state(self, participant: Participant) -> dict[str, Any]:
        return {
            "userId": participant.user_id,
            "displayName": participant.display_name,
            "role": participant.role,
            "ready": participant.ready,
            "rttMs": participant.rtt_ms,
            "calibrated": participant.calibrated,
            "bluetooth": participant.bluetooth,
            "connectionId": participant.connection_id,
            "instanceId": self.instance_id,
        }

    def _room_state(self, room: Room) -> dict[str, Any]:
        return {
            "roomId": room.room_id,
            "sessionId": room.session_id,
            "repertoireId": room.repertoire_id,
            "leaderId": room.leader_id,
            "tempoMapRevision": room.tempo_map_revision,
            "totalMeasures": room.total_measures,
            "validAnchors": [list(anchor) for anchor in sorted(room.valid_anchors)],
            "ttlNs": room.ttl_ns,
            "status": room.status,
            "anchorMeasure": room.anchor_measure,
            "anchorPass": room.anchor_pass,
            "serverStartTimeNs": room.server_start_time_ns,
            "countIn": room.count_in,
            "expiresAtNs": room.expires_at_ns,
        }

    def _room_from_state(self, state: dict[str, Any]) -> Room:
        room = Room(
            room_id=str(state["roomId"]),
            session_id=str(state["sessionId"]),
            repertoire_id=str(state["repertoireId"]),
            leader_id=str(state["leaderId"]),
            tempo_map_revision=int(state["tempoMapRevision"]),
            total_measures=int(state["totalMeasures"]),
            valid_anchors=frozenset((int(anchor[0]), int(anchor[1])) for anchor in state["validAnchors"]),
            ttl_ns=int(state["ttlNs"]),
        )
        self._apply_state(room, state)
        return room

    @staticmethod
    def _apply_state(room: Room, state: dict[str, Any]) -> None:
        status = state["status"]
        if status not in {"idle", "armed", "playing", "stopped"}:
            raise ValueError("invalid shared room status")
        room.status = cast(TransportStatus, status)
        room.anchor_measure = int(state["anchorMeasure"]) if state.get("anchorMeasure") is not None else None
        room.anchor_pass = int(state["anchorPass"]) if state.get("anchorPass") is not None else None
        room.server_start_time_ns = (
            int(state["serverStartTimeNs"]) if state.get("serverStartTimeNs") is not None else None
        )
        room.count_in = bool(state["countIn"])
        room.expires_at_ns = int(state["expiresAtNs"])

    def _load_persisted_transport(self, room: Room) -> None:
        with self.database.session_factory() as db:
            row = db.get(PracticeSession, room.session_id)
            if row is None or row.ended_at is not None:
                raise RoomMissingError(room.room_id)
            if row.status not in {"idle", "armed", "playing", "stopped"}:
                raise ValueError("invalid persisted room status")
            room.status = cast(TransportStatus, row.status)
            room.anchor_measure = row.anchor_measure
            room.anchor_pass = row.anchor_pass
            room.server_start_time_ns = row.server_start_time_ns

    def _save_shared(self, room: Room) -> None:
        if self.redis is not None:
            self.redis.save_room(room.room_id, self._room_state(room))

    def _persist(self, room: Room, *, ended: bool = False) -> None:
        with self.database.session_factory() as db:
            row = db.get(PracticeSession, room.session_id)
            if row is None:
                return
            row.status = "stopped" if ended else room.status
            row.anchor_measure = room.anchor_measure
            row.anchor_pass = room.anchor_pass
            row.server_start_time_ns = room.server_start_time_ns
            row.tempo_map_revision = room.tempo_map_revision
            if ended:
                row.ended_at = utcnow()
            db.commit()

    def _persist_ended_session(self, session_id: str) -> None:
        with self.database.session_factory() as db:
            row = db.get(PracticeSession, session_id)
            if row is None or row.ended_at is not None:
                return
            row.status = "stopped"
            row.server_start_time_ns = None
            row.ended_at = utcnow()
            db.commit()

    @staticmethod
    def expires_at(room: Room) -> datetime:
        return datetime.fromtimestamp(room.expires_at_ns / 1_000_000_000, tz=UTC)


def tempo_map_anchors(tempo_map: TempoMapData) -> frozenset[tuple[int, int]]:
    route = _apply_navigation(tempo_map, _build_repeat_route(tempo_map))
    passes: dict[int, int] = {}
    anchors: set[tuple[int, int]] = set()
    for measure in route:
        pass_number = passes.get(measure, 0) + 1
        passes[measure] = pass_number
        anchors.add((measure, pass_number))
    if not anchors:
        raise ValueError("the pinned tempo map expands to an empty timeline")
    return frozenset(anchors)


def _build_repeat_route(tempo_map: TempoMapData) -> list[int]:
    repeats = [jump for jump in tempo_map.jumps if isinstance(jump, TempoMapRepeat)]
    route: list[int] = []

    def strictly_inside(inner: TempoMapRepeat, outer: TempoMapRepeat) -> bool:
        return (
            inner.start_measure >= outer.start_measure
            and inner.end_measure <= outer.end_measure
            and (inner.start_measure != outer.start_measure or inner.end_measure != outer.end_measure)
        )

    def direct_repeats(
        start_measure: int,
        end_measure: int,
        container: TempoMapRepeat | None,
    ) -> list[TempoMapRepeat]:
        candidates = [
            repeat
            for repeat in repeats
            if repeat is not container
            and repeat.start_measure >= start_measure
            and repeat.end_measure <= end_measure
        ]
        return sorted(
            [
                candidate
                for candidate in candidates
                if not any(
                    other is not candidate and strictly_inside(candidate, other) for other in candidates
                )
            ],
            key=lambda repeat: repeat.start_measure,
        )

    def included_by_voltas(
        measure: int,
        contexts: list[tuple[TempoMapRepeat, int]],
    ) -> bool:
        for repeat, pass_number in contexts:
            endings = [
                ending
                for ending in repeat.endings or []
                if ending.measures[0] <= measure <= ending.measures[1]
            ]
            if endings and not any(pass_number in ending.for_pass for ending in endings):
                return False
        return True

    def append(measure: int) -> None:
        if len(route) >= MAX_TIMELINE_ENTRIES:
            raise ValueError("tempo map expansion exceeds the supported timeline size")
        route.append(measure)

    def expand_span(
        start_measure: int,
        end_measure: int,
        contexts: list[tuple[TempoMapRepeat, int]],
        container: TempoMapRepeat | None = None,
    ) -> None:
        children = direct_repeats(start_measure, end_measure, container)
        child_index = 0
        measure = start_measure
        while measure <= end_measure:
            child = children[child_index] if child_index < len(children) else None
            if child is not None and child.start_measure == measure:
                for pass_number in range(1, child.times + 1):
                    expand_span(
                        child.start_measure,
                        child.end_measure,
                        [*contexts, (child, pass_number)],
                        child,
                    )
                measure = child.end_measure + 1
                child_index += 1
                continue
            if included_by_voltas(measure, contexts):
                append(measure)
            measure += 1

    expand_span(1, tempo_map.total_measures, [])
    return route


def _apply_navigation(tempo_map: TempoMapData, repeat_route: list[int]) -> list[int]:
    navigation: list[tuple[TempoMapDaCapo | TempoMapDalSegno, int, int]] = []
    for order, jump in enumerate(tempo_map.jumps):
        if not isinstance(jump, TempoMapDaCapo | TempoMapDalSegno):
            continue
        trigger_index = _last_index(repeat_route, jump.at_measure)
        if trigger_index < 0:
            raise ValueError("tempo map navigation trigger is absent after repeat expansion")
        navigation.append((jump, trigger_index, order))
    navigation.sort(key=lambda item: item[2])
    coda = next((jump for jump in tempo_map.jumps if isinstance(jump, TempoMapCoda)), None)
    executed: set[int] = set()
    active_fine: int | None = None
    coda_armed = False
    coda_used = False
    route_index = 0
    result: list[int] = []
    while route_index < len(repeat_route):
        if len(result) >= MAX_TIMELINE_ENTRIES:
            raise ValueError("tempo map navigation exceeds the supported timeline size")
        measure = repeat_route[route_index]
        result.append(measure)
        if active_fine == measure:
            break
        if coda_armed and not coda_used and coda is not None and measure == coda.to_coda_measure:
            coda_index = next(
                (
                    index
                    for index, candidate in enumerate(repeat_route)
                    if index > route_index and candidate == coda.coda_measure
                ),
                -1,
            )
            if coda_index < 0:
                coda_index = _first_index(repeat_route, coda.coda_measure)
            if coda_index < 0:
                raise ValueError("tempo map Coda is absent after repeat expansion")
            coda_used = True
            route_index = coda_index
            continue
        point = next(
            (item for item in navigation if item[1] == route_index and item[2] not in executed),
            None,
        )
        if point is not None:
            jump, _, order = point
            executed.add(order)
            active_fine = jump.al_fine
            coda_armed = jump.al_coda is True
            if isinstance(jump, TempoMapDaCapo):
                route_index = 0
            else:
                route_index = _first_index(repeat_route, jump.segno_measure)
                if route_index < 0:
                    raise ValueError("tempo map Segno is absent after repeat expansion")
            continue
        route_index += 1
    return result


def _first_index(values: list[int], target: int) -> int:
    try:
        return values.index(target)
    except ValueError:
        return -1


def _last_index(values: list[int], target: int) -> int:
    for index in range(len(values) - 1, -1, -1):
        if values[index] == target:
            return index
    return -1
