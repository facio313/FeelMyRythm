from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import (
    Annotation,
    Group,
    GroupMember,
    PracticeLog,
    Project,
    RepertoireItem,
    Score,
    Todo,
    User,
)

ROLE_LEVEL = {"member": 1, "leader": 2, "owner": 3}


def group_membership(db: Session, user_id: str, group_id: str) -> GroupMember | None:
    return db.scalar(
        select(GroupMember).where(
            GroupMember.group_id == group_id,
            GroupMember.user_id == user_id,
        )
    )


def require_group(
    db: Session, user: User, group_id: str, minimum_role: str = "member"
) -> tuple[Group, GroupMember]:
    group = db.get(Group, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="group not found")
    membership = group_membership(db, user.id, group_id)
    if membership is None:
        raise HTTPException(status_code=403, detail="group membership required")
    if ROLE_LEVEL[membership.role] < ROLE_LEVEL[minimum_role]:
        raise HTTPException(status_code=403, detail=f"{minimum_role} role required")
    return group, membership


def require_project(
    db: Session, user: User, project_id: str, minimum_role: str = "member"
) -> tuple[Project, GroupMember]:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    _, membership = require_group(db, user, project.group_id, minimum_role)
    return project, membership


def require_repertoire(
    db: Session, user: User, repertoire_id: str, minimum_role: str = "member"
) -> tuple[RepertoireItem, GroupMember]:
    repertoire = db.get(RepertoireItem, repertoire_id)
    if repertoire is None:
        raise HTTPException(status_code=404, detail="repertoire item not found")
    _, membership = require_project(db, user, repertoire.project_id, minimum_role)
    return repertoire, membership


def require_score(
    db: Session, user: User, score_id: str, minimum_role: str = "member"
) -> tuple[Score, GroupMember]:
    score = db.get(Score, score_id)
    if score is None:
        raise HTTPException(status_code=404, detail="score not found")
    _, membership = require_repertoire(db, user, score.repertoire_id, minimum_role)
    return score, membership


def require_log(
    db: Session, user: User, log_id: str, minimum_role: str = "member"
) -> tuple[PracticeLog, GroupMember]:
    log = db.get(PracticeLog, log_id)
    if log is None:
        raise HTTPException(status_code=404, detail="practice log not found")
    _, membership = require_repertoire(db, user, log.repertoire_id, minimum_role)
    return log, membership


def require_todo(db: Session, user: User, todo_id: str) -> tuple[Todo, GroupMember]:
    todo = db.get(Todo, todo_id)
    if todo is None:
        raise HTTPException(status_code=404, detail="todo not found")
    _, membership = require_repertoire(db, user, todo.repertoire_id)
    return todo, membership


def can_edit_annotation(annotation: Annotation, user: User, membership: GroupMember) -> bool:
    return annotation.author_id == user.id or ROLE_LEVEL[membership.role] >= ROLE_LEVEL["leader"]
