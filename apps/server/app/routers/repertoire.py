from __future__ import annotations

from typing import cast

from fastapi import APIRouter, File, HTTPException, Request, Response, UploadFile, status
from sqlalchemy import desc, select
from sqlalchemy.exc import IntegrityError

from ..access import (
    ROLE_LEVEL,
    group_membership,
    require_log,
    require_project,
    require_repertoire,
    require_todo,
)
from ..dependencies import CurrentUser, DbSession
from ..models import PracticeLog, Project, RepertoireItem, Score, TempoMapRevision, Todo, User
from ..musicxml import parse_musicxml_draft
from ..schemas import (
    LogAnchor,
    MusicXmlDraftOut,
    PracticeLogCreate,
    PracticeLogOut,
    PracticeLogUpdate,
    RepertoireAccessOut,
    RepertoireCreate,
    RepertoireOut,
    RepertoireUpdate,
    Role,
    TempoMapOut,
    TempoMapWrite,
    TodoCreate,
    TodoOut,
    TodoUpdate,
)
from ..serializers import log_out, repertoire_out, tempo_map_out, todo_out
from .storage_cleanup import enqueue_score_cleanup

router = APIRouter(prefix="/api", tags=["repertoire"])


def _validate_log_anchor_scores(db: DbSession, repertoire_id: str, anchors: list[LogAnchor]) -> None:
    score_ids = {anchor.score_id for anchor in anchors if anchor.score_id is not None}
    if not score_ids:
        return
    valid_ids = set(
        db.scalars(
            select(Score.id).where(
                Score.repertoire_id == repertoire_id,
                Score.id.in_(score_ids),
            )
        ).all()
    )
    if valid_ids != score_ids:
        raise HTTPException(status_code=422, detail="anchor score must belong to the repertoire")


@router.post(
    "/projects/{project_id}/repertoire",
    response_model=RepertoireOut,
    status_code=status.HTTP_201_CREATED,
)
def create_repertoire(
    project_id: str, body: RepertoireCreate, db: DbSession, user: CurrentUser
) -> RepertoireOut:
    require_project(db, user, project_id, "leader")
    item = RepertoireItem(project_id=project_id, **body.model_dump())
    db.add(item)
    db.commit()
    db.refresh(item)
    return repertoire_out(db, item)


@router.get("/projects/{project_id}/repertoire", response_model=list[RepertoireOut])
def list_repertoire(project_id: str, db: DbSession, user: CurrentUser) -> list[RepertoireOut]:
    require_project(db, user, project_id)
    rows = db.scalars(
        select(RepertoireItem).where(RepertoireItem.project_id == project_id).order_by(RepertoireItem.title)
    ).all()
    return [repertoire_out(db, row) for row in rows]


@router.get("/repertoire/{repertoire_id}", response_model=RepertoireOut)
def get_repertoire(repertoire_id: str, db: DbSession, user: CurrentUser) -> RepertoireOut:
    item, _ = require_repertoire(db, user, repertoire_id)
    return repertoire_out(db, item)


@router.get("/repertoire/{repertoire_id}/access", response_model=RepertoireAccessOut)
def get_repertoire_access(repertoire_id: str, db: DbSession, user: CurrentUser) -> RepertoireAccessOut:
    _, membership = require_repertoire(db, user, repertoire_id)
    return RepertoireAccessOut(role=cast(Role, membership.role))


@router.patch("/repertoire/{repertoire_id}", response_model=RepertoireOut)
def update_repertoire(
    repertoire_id: str, body: RepertoireUpdate, db: DbSession, user: CurrentUser
) -> RepertoireOut:
    item, _ = require_repertoire(db, user, repertoire_id, "leader")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(item, field, value)
    db.commit()
    db.refresh(item)
    return repertoire_out(db, item)


@router.delete("/repertoire/{repertoire_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_repertoire(
    repertoire_id: str,
    request: Request,
    db: DbSession,
    user: CurrentUser,
) -> Response:
    require_repertoire(db, user, repertoire_id, "leader")
    item = db.scalar(select(RepertoireItem).where(RepertoireItem.id == repertoire_id).with_for_update())
    assert item is not None
    scores = db.scalars(
        select(Score)
        .where(Score.repertoire_id == repertoire_id)
        .order_by(Score.storage_key)
        .with_for_update()
    ).all()
    enqueue_score_cleanup(
        db,
        scores,
        request.app.state.settings,
        reason="repertoire",
    )
    db.delete(item)
    db.commit()
    return Response(status_code=204)


@router.get("/repertoire/{repertoire_id}/tempomap", response_model=TempoMapOut)
def get_latest_tempo_map(repertoire_id: str, db: DbSession, user: CurrentUser) -> TempoMapOut:
    require_repertoire(db, user, repertoire_id)
    row = db.scalar(
        select(TempoMapRevision)
        .where(TempoMapRevision.repertoire_id == repertoire_id)
        .order_by(desc(TempoMapRevision.revision))
        .limit(1)
    )
    if row is None:
        raise HTTPException(status_code=404, detail="tempo map not found")
    return tempo_map_out(row)


@router.get("/repertoire/{repertoire_id}/tempomap/revisions", response_model=list[TempoMapOut])
def list_tempo_map_revisions(repertoire_id: str, db: DbSession, user: CurrentUser) -> list[TempoMapOut]:
    require_repertoire(db, user, repertoire_id)
    rows = db.scalars(
        select(TempoMapRevision)
        .where(TempoMapRevision.repertoire_id == repertoire_id)
        .order_by(desc(TempoMapRevision.revision))
    ).all()
    return [tempo_map_out(row) for row in rows]


@router.get("/repertoire/{repertoire_id}/tempomap/revisions/{revision}", response_model=TempoMapOut)
def get_tempo_map_revision(
    repertoire_id: str, revision: int, db: DbSession, user: CurrentUser
) -> TempoMapOut:
    require_repertoire(db, user, repertoire_id)
    row = db.scalar(
        select(TempoMapRevision).where(
            TempoMapRevision.repertoire_id == repertoire_id,
            TempoMapRevision.revision == revision,
        )
    )
    if row is None:
        raise HTTPException(status_code=404, detail="tempo map revision not found")
    return tempo_map_out(row)


@router.put("/repertoire/{repertoire_id}/tempomap", response_model=TempoMapOut)
def put_tempo_map(
    repertoire_id: str,
    body: TempoMapWrite,
    db: DbSession,
    user: CurrentUser,
) -> TempoMapOut:
    require_repertoire(db, user, repertoire_id, "leader")
    if body.data.repertoire_item_id != repertoire_id:
        raise HTTPException(status_code=422, detail="tempo map repertoireItemId must match the URL")
    if body.data.revision != body.expected_revision:
        raise HTTPException(status_code=422, detail="tempo map revision must match expectedRevision")
    latest = db.scalar(
        select(TempoMapRevision)
        .where(TempoMapRevision.repertoire_id == repertoire_id)
        .order_by(desc(TempoMapRevision.revision))
        .limit(1)
        .with_for_update()
    )
    actual = latest.revision if latest else 0
    if body.expected_revision != actual:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "tempo map revision conflict",
                "expectedRevision": body.expected_revision,
                "actualRevision": actual,
            },
        )
    revision = actual + 1
    data = body.data.model_dump(by_alias=True, exclude_none=True)
    data["repertoireItemId"] = repertoire_id
    data["revision"] = revision
    row = TempoMapRevision(
        repertoire_id=repertoire_id,
        revision=revision,
        data=data,
        created_by_id=user.id,
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="tempo map was concurrently updated") from exc
    db.refresh(row)
    return tempo_map_out(row)


@router.post("/repertoire/{repertoire_id}/musicxml/draft", response_model=MusicXmlDraftOut)
async def musicxml_draft(
    repertoire_id: str,
    request: Request,
    db: DbSession,
    user: CurrentUser,
    file: UploadFile = File(...),
) -> MusicXmlDraftOut:
    require_repertoire(db, user, repertoire_id, "leader")
    content = await file.read(request.app.state.settings.max_upload_bytes + 1)
    try:
        draft = parse_musicxml_draft(
            content,
            file.filename or "score.musicxml",
            request.app.state.settings.max_upload_bytes,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return MusicXmlDraftOut.model_validate(draft)


@router.post(
    "/repertoire/{repertoire_id}/logs",
    response_model=PracticeLogOut,
    status_code=status.HTTP_201_CREATED,
)
def create_log(
    repertoire_id: str, body: PracticeLogCreate, db: DbSession, user: CurrentUser
) -> PracticeLogOut:
    require_repertoire(db, user, repertoire_id)
    _validate_log_anchor_scores(db, repertoire_id, body.anchors)
    row = PracticeLog(
        repertoire_id=repertoire_id,
        author_id=user.id,
        content=body.content,
        anchors=[anchor.model_dump(by_alias=True, exclude_none=True) for anchor in body.anchors],
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return log_out(row, user)


@router.get("/repertoire/{repertoire_id}/logs", response_model=list[PracticeLogOut])
def list_logs(repertoire_id: str, db: DbSession, user: CurrentUser) -> list[PracticeLogOut]:
    require_repertoire(db, user, repertoire_id)
    rows = db.execute(
        select(PracticeLog, User)
        .join(User, User.id == PracticeLog.author_id)
        .where(PracticeLog.repertoire_id == repertoire_id)
        .order_by(desc(PracticeLog.created_at))
    ).all()
    return [log_out(row, author) for row, author in rows]


@router.get("/logs/{log_id}", response_model=PracticeLogOut)
def get_log(log_id: str, db: DbSession, user: CurrentUser) -> PracticeLogOut:
    row, _ = require_log(db, user, log_id)
    author = db.get(User, row.author_id)
    assert author is not None
    return log_out(row, author)


@router.patch("/logs/{log_id}", response_model=PracticeLogOut)
def update_log(log_id: str, body: PracticeLogUpdate, db: DbSession, user: CurrentUser) -> PracticeLogOut:
    row, membership = require_log(db, user, log_id)
    if row.author_id != user.id and ROLE_LEVEL[membership.role] < ROLE_LEVEL["leader"]:
        raise HTTPException(status_code=403, detail="log author or leader role required")
    if body.content is not None:
        row.content = body.content
    if body.anchors is not None:
        _validate_log_anchor_scores(db, row.repertoire_id, body.anchors)
        row.anchors = [anchor.model_dump(by_alias=True, exclude_none=True) for anchor in body.anchors]
    db.commit()
    db.refresh(row)
    author = db.get(User, row.author_id)
    assert author is not None
    return log_out(row, author)


@router.delete("/logs/{log_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_log(log_id: str, db: DbSession, user: CurrentUser) -> Response:
    row, membership = require_log(db, user, log_id)
    if row.author_id != user.id and ROLE_LEVEL[membership.role] < ROLE_LEVEL["leader"]:
        raise HTTPException(status_code=403, detail="log author or leader role required")
    db.delete(row)
    db.commit()
    return Response(status_code=204)


def _validate_assignee(db: DbSession, repertoire: RepertoireItem, assignee_id: str | None) -> None:
    if assignee_id is None:
        return
    project = db.get(Project, repertoire.project_id)
    assert project is not None
    if group_membership(db, assignee_id, project.group_id) is None:
        raise HTTPException(status_code=422, detail="assignee must be a project group member")


@router.post("/repertoire/{repertoire_id}/todos", response_model=TodoOut, status_code=status.HTTP_201_CREATED)
def create_todo(repertoire_id: str, body: TodoCreate, db: DbSession, user: CurrentUser) -> TodoOut:
    repertoire, _ = require_repertoire(db, user, repertoire_id)
    _validate_assignee(db, repertoire, body.assignee_id)
    if body.practice_log_id:
        log, _ = require_log(db, user, body.practice_log_id)
        if log.repertoire_id != repertoire_id:
            raise HTTPException(status_code=422, detail="practice log belongs to another repertoire")
    row = Todo(
        repertoire_id=repertoire_id,
        created_by_id=user.id,
        **body.model_dump(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return todo_out(row)


@router.get("/repertoire/{repertoire_id}/todos", response_model=list[TodoOut])
def list_todos(repertoire_id: str, db: DbSession, user: CurrentUser) -> list[TodoOut]:
    require_repertoire(db, user, repertoire_id)
    rows = db.scalars(
        select(Todo).where(Todo.repertoire_id == repertoire_id).order_by(Todo.done, Todo.due_date)
    ).all()
    return [todo_out(row) for row in rows]


@router.get("/todos/{todo_id}", response_model=TodoOut)
def get_todo(todo_id: str, db: DbSession, user: CurrentUser) -> TodoOut:
    row, _ = require_todo(db, user, todo_id)
    return todo_out(row)


@router.patch("/todos/{todo_id}", response_model=TodoOut)
def update_todo(todo_id: str, body: TodoUpdate, db: DbSession, user: CurrentUser) -> TodoOut:
    row, membership = require_todo(db, user, todo_id)
    if (
        row.created_by_id != user.id
        and row.assignee_id != user.id
        and ROLE_LEVEL[membership.role] < ROLE_LEVEL["leader"]
    ):
        raise HTTPException(status_code=403, detail="todo owner, assignee, or leader role required")
    repertoire = db.get(RepertoireItem, row.repertoire_id)
    assert repertoire is not None
    if "assignee_id" in body.model_fields_set:
        _validate_assignee(db, repertoire, body.assignee_id)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return todo_out(row)


@router.delete("/todos/{todo_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_todo(todo_id: str, db: DbSession, user: CurrentUser) -> Response:
    row, membership = require_todo(db, user, todo_id)
    if row.created_by_id != user.id and ROLE_LEVEL[membership.role] < ROLE_LEVEL["leader"]:
        raise HTTPException(status_code=403, detail="todo creator or leader role required")
    db.delete(row)
    db.commit()
    return Response(status_code=204)
