from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..access import require_repertoire
from ..auth import get_current_user
from ..db import get_db
from ..models import TempoMapRow, User
from ..rooms import manager
from ..schemas import RoomCreated, RoomCreateIn

router = APIRouter(prefix="/api", tags=["rooms"])


@router.post("/rooms", response_model=RoomCreated)
def create_room(
    body: RoomCreateIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> RoomCreated:
    require_repertoire(db, user, body.repertoire_id)
    row = db.execute(
        select(TempoMapRow).where(TempoMapRow.repertoire_id == body.repertoire_id)
    ).scalar_one_or_none()
    revision = row.revision if row else 0
    room = manager.create(body.repertoire_id, user.id, revision)
    return RoomCreated(room_id=room.id)
