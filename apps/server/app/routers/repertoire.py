from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..access import require_project, require_repertoire
from ..auth import get_current_user
from ..db import get_db
from ..models import PracticeLog, RepertoireItem, Score, TempoMapRow, Todo, User
from ..rooms import manager
from ..schemas import (
    PracticeLogCreateIn,
    PracticeLogOut,
    RepertoireCreateIn,
    RepertoireOut,
    TempoMapOut,
    TempoMapPutIn,
    TodoCreateIn,
    TodoOut,
)

router = APIRouter(prefix="/api", tags=["repertoire"])


def _to_out(db: Session, item: RepertoireItem) -> RepertoireOut:
    has_map = (
        db.execute(select(TempoMapRow.id).where(TempoMapRow.repertoire_id == item.id)).scalar_one_or_none()
        is not None
    )
    score_count = db.execute(
        select(func.count()).select_from(Score).where(Score.repertoire_id == item.id)
    ).scalar_one()
    open_todos = db.execute(
        select(func.count()).select_from(Todo).where(Todo.repertoire_id == item.id, Todo.done.is_(False))
    ).scalar_one()
    return RepertoireOut(
        id=item.id,
        project_id=item.project_id,
        title=item.title,
        composer=item.composer,
        has_tempo_map=has_map,
        score_count=score_count,
        open_todo_count=open_todos,
    )


@router.post("/projects/{project_id}/repertoire", response_model=RepertoireOut)
def create_repertoire(
    project_id: str,
    body: RepertoireCreateIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RepertoireOut:
    require_project(db, user, project_id)
    item = RepertoireItem(project_id=project_id, title=body.title, composer=body.composer)
    db.add(item)
    db.commit()
    return _to_out(db, item)


@router.get("/projects/{project_id}/repertoire", response_model=list[RepertoireOut])
def list_repertoire(
    project_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[RepertoireOut]:
    require_project(db, user, project_id)
    rows = db.execute(select(RepertoireItem).where(RepertoireItem.project_id == project_id)).scalars().all()
    return [_to_out(db, r) for r in rows]


@router.get("/repertoire/{repertoire_id}", response_model=RepertoireOut)
def get_repertoire(
    repertoire_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> RepertoireOut:
    item = require_repertoire(db, user, repertoire_id)
    return _to_out(db, item)


# ---------- 템포맵 (revision 관리, 설계문서 §8) ----------


@router.get("/repertoire/{repertoire_id}/tempomap", response_model=TempoMapOut)
def get_tempomap(
    repertoire_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> TempoMapOut:
    require_repertoire(db, user, repertoire_id)
    row = db.execute(
        select(TempoMapRow).where(TempoMapRow.repertoire_id == repertoire_id)
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "템포맵이 아직 없습니다")
    return TempoMapOut(revision=row.revision, data=row.data)


@router.put("/repertoire/{repertoire_id}/tempomap", response_model=TempoMapOut)
async def put_tempomap(
    repertoire_id: str,
    body: TempoMapPutIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TempoMapOut:
    require_repertoire(db, user, repertoire_id)
    row = db.execute(
        select(TempoMapRow).where(TempoMapRow.repertoire_id == repertoire_id)
    ).scalar_one_or_none()
    if row is None:
        if body.base_revision != 0:
            raise HTTPException(409, "서버에 템포맵이 없습니다. baseRevision=0으로 생성하세요")
        row = TempoMapRow(repertoire_id=repertoire_id, revision=1, data=body.data)
        db.add(row)
    else:
        if body.base_revision != row.revision:
            raise HTTPException(
                409, f"다른 사람이 먼저 수정했습니다 (서버 revision {row.revision}). 다시 불러오세요"
            )
        row.revision += 1
        row.data = body.data
    db.commit()

    # 이 곡의 활성 세션에 revision 변경 알림 (설계문서 §6.3 TEMPOMAP_UPDATED)
    await manager.notify_tempomap_updated(repertoire_id, row.revision)
    return TempoMapOut(revision=row.revision, data=row.data)


# ---------- 연습일지 · 할일 (기능 5) ----------


@router.get("/repertoire/{repertoire_id}/logs", response_model=list[PracticeLogOut])
def list_logs(
    repertoire_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[PracticeLogOut]:
    require_repertoire(db, user, repertoire_id)
    rows = db.execute(
        select(PracticeLog, User.display_name)
        .join(User, User.id == PracticeLog.user_id)
        .where(PracticeLog.repertoire_id == repertoire_id)
        .order_by(PracticeLog.created_at.desc())
    ).all()
    return [
        PracticeLogOut(
            id=log.id,
            repertoire_id=log.repertoire_id,
            author_name=name,
            content=log.content,
            anchors=log.anchors or [],
            created_at=log.created_at.isoformat(),
        )
        for log, name in rows
    ]


@router.post("/repertoire/{repertoire_id}/logs", response_model=PracticeLogOut)
def create_log(
    repertoire_id: str,
    body: PracticeLogCreateIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PracticeLogOut:
    require_repertoire(db, user, repertoire_id)
    log = PracticeLog(
        repertoire_id=repertoire_id,
        user_id=user.id,
        content=body.content,
        anchors=[a.model_dump(by_alias=True) for a in body.anchors],
    )
    db.add(log)
    db.commit()
    return PracticeLogOut(
        id=log.id,
        repertoire_id=log.repertoire_id,
        author_name=user.display_name,
        content=log.content,
        anchors=body.anchors,
        created_at=log.created_at.isoformat(),
    )


@router.get("/repertoire/{repertoire_id}/todos", response_model=list[TodoOut])
def list_todos(
    repertoire_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[TodoOut]:
    require_repertoire(db, user, repertoire_id)
    rows = db.execute(select(Todo).where(Todo.repertoire_id == repertoire_id)).scalars().all()
    return [
        TodoOut(id=t.id, repertoire_id=t.repertoire_id, content=t.content, assignee=t.assignee, done=t.done)
        for t in rows
    ]


@router.post("/repertoire/{repertoire_id}/todos", response_model=TodoOut)
def create_todo(
    repertoire_id: str,
    body: TodoCreateIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TodoOut:
    require_repertoire(db, user, repertoire_id)
    todo = Todo(repertoire_id=repertoire_id, content=body.content, assignee=body.assignee)
    db.add(todo)
    db.commit()
    return TodoOut(
        id=todo.id, repertoire_id=todo.repertoire_id, content=todo.content, assignee=todo.assignee, done=False
    )


@router.patch("/todos/{todo_id}", response_model=TodoOut)
def toggle_todo(
    todo_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> TodoOut:
    todo = db.get(Todo, todo_id)
    if todo is None:
        raise HTTPException(404, "할일이 없습니다")
    require_repertoire(db, user, todo.repertoire_id)
    todo.done = not todo.done
    db.commit()
    return TodoOut(
        id=todo.id, repertoire_id=todo.repertoire_id, content=todo.content, assignee=todo.assignee,
        done=todo.done,
    )
