from __future__ import annotations

import asyncio
import contextlib
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, cast

from fastapi import WebSocket
from sqlalchemy import select

from .config import Settings
from .db import Database
from .models import GroupMember, PracticeSession, Project, RepertoireItem, TempoMapRevision, utcnow
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


@dataclass
class Participant:
    websocket: WebSocket
    user_id: str
    display_name: str
    role: Role
    calibrated: bool
    bluetooth: bool
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

    def start(self) -> None:
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def stop(self) -> None:
        if self._cleanup_task:
            self._cleanup_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._cleanup_task
            self._cleanup_task = None

    async def _cleanup_loop(self) -> None:
        while True:
            await asyncio.sleep(self.settings.room_cleanup_interval_seconds)
            await self.expire_rooms()

    async def expire_rooms(self) -> None:
        now = time.time_ns()
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
        return room

    def get(self, room_id: str) -> Room:
        room = self.rooms.get(room_id)
        if room is None or (not room.participants and room.expires_at_ns <= time.time_ns()):
            if room is not None:
                self.rooms.pop(room_id, None)
                self._persist(room, ended=True)
            raise RoomMissingError(room_id)
        return room

    async def join(self, room: Room, participant: Participant, request_id: str | None = None) -> None:
        old = room.participants.get(participant.user_id)
        if old is not None and old.websocket is not participant.websocket:
            with contextlib.suppress(Exception):
                await old.websocket.close(code=4000, reason="replaced by a newer connection")
        room.participants[participant.user_id] = participant
        room.touch()
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
            room.touch()
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
        await self.broadcast(
            room,
            "TRANSPORT",
            payload.model_dump(by_alias=True),
            request_id,
        )

    async def broadcast_roster(self, room: Room) -> None:
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
        await self.broadcast(room, "ROOM_ROSTER", {"members": members})

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
        async with room.lock:
            self.require_transport_role(room, participant)
            self.require_anchor(room, measure, pass_number)
            room.anchor_measure = measure
            room.anchor_pass = pass_number
            room.count_in = count_in
            room.server_start_time_ns = time.time_ns() + self.settings.room_lead_time_ms * 1_000_000
            room.status = "armed"
            room.touch()
            self._persist(room)
            await self.broadcast_transport(room, request_id)

    async def stop_transport(self, room: Room, participant: Participant, request_id: str | None) -> None:
        async with room.lock:
            self.require_transport_role(room, participant)
            room.status = "stopped"
            room.server_start_time_ns = None
            room.touch()
            self._persist(room)
            await self.broadcast_transport(room, request_id)

    async def seek_transport(
        self,
        room: Room,
        participant: Participant,
        measure: int,
        pass_number: int,
        request_id: str | None,
    ) -> None:
        async with room.lock:
            self.require_transport_role(room, participant)
            self.require_anchor(room, measure, pass_number)
            room.anchor_measure = measure
            room.anchor_pass = pass_number
            room.server_start_time_ns = time.time_ns() + self.settings.room_lead_time_ms * 1_000_000
            room.status = "armed"
            room.touch()
            self._persist(room)
            await self.broadcast_transport(room, request_id)

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
