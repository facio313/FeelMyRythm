from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import desc, select

from ..access import require_repertoire
from ..dependencies import CurrentUser, DbSession
from ..models import PracticeSession, TempoMapRevision
from ..rooms import RoomMissingError
from ..schemas import PracticeSessionOut, RoomCreate, RoomOut

router = APIRouter(prefix="/api", tags=["practice rooms"])


@router.post("/rooms", response_model=RoomOut, status_code=status.HTTP_201_CREATED)
def create_room(body: RoomCreate, request: Request, db: DbSession, user: CurrentUser) -> RoomOut:
    require_repertoire(db, user, body.repertoire_id, "leader")
    latest = db.scalar(
        select(TempoMapRevision)
        .where(TempoMapRevision.repertoire_id == body.repertoire_id)
        .order_by(desc(TempoMapRevision.revision))
        .limit(1)
    )
    if latest is None:
        raise HTTPException(status_code=409, detail="a tempo map is required before opening a room")
    room = request.app.state.rooms.create_room(
        repertoire_id=body.repertoire_id,
        leader_id=user.id,
        tempo_map_revision=latest.revision,
        total_measures=int(latest.data["totalMeasures"]),
    )
    return RoomOut(
        room_id=room.room_id,
        join_code=room.join_code,
        repertoire_id=room.repertoire_id,
        leader_id=room.leader_id,
        tempo_map_revision=room.tempo_map_revision,
        expires_at=request.app.state.rooms.expires_at(room),
    )


@router.get("/rooms/{room_id}", response_model=RoomOut)
def get_room(room_id: str, request: Request, db: DbSession, user: CurrentUser) -> RoomOut:
    try:
        room = request.app.state.rooms.get(room_id)
    except RoomMissingError as exc:
        raise HTTPException(status_code=404, detail="room not found or expired") from exc
    require_repertoire(db, user, room.repertoire_id)
    return RoomOut(
        room_id=room.room_id,
        join_code=room.join_code,
        repertoire_id=room.repertoire_id,
        leader_id=room.leader_id,
        tempo_map_revision=room.tempo_map_revision,
        expires_at=request.app.state.rooms.expires_at(room),
    )


@router.get("/repertoire/{repertoire_id}/practice-sessions", response_model=list[PracticeSessionOut])
def list_practice_sessions(repertoire_id: str, db: DbSession, user: CurrentUser) -> list[PracticeSessionOut]:
    require_repertoire(db, user, repertoire_id)
    rows = db.scalars(
        select(PracticeSession)
        .where(PracticeSession.repertoire_id == repertoire_id)
        .order_by(desc(PracticeSession.created_at))
    ).all()
    return [PracticeSessionOut.model_validate(row) for row in rows]


@router.get("/practice-sessions/{session_id}", response_model=PracticeSessionOut)
def get_practice_session(session_id: str, db: DbSession, user: CurrentUser) -> PracticeSessionOut:
    row = db.get(PracticeSession, session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="practice session not found")
    require_repertoire(db, user, row.repertoire_id)
    return PracticeSessionOut.model_validate(row)
