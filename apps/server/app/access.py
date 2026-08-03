"""권한 헬퍼: 그룹 멤버십 기반 접근 제어"""

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Group, GroupMember, Project, RepertoireItem, Score, User


def role_in_group(db: Session, user: User, group_id: str) -> str | None:
    row = db.execute(
        select(GroupMember).where(GroupMember.group_id == group_id, GroupMember.user_id == user.id)
    ).scalar_one_or_none()
    return row.role if row else None


def require_group(db: Session, user: User, group_id: str, *, leader: bool = False) -> Group:
    group = db.get(Group, group_id)
    if group is None:
        raise HTTPException(404, "그룹이 없습니다")
    role = role_in_group(db, user, group_id)
    if role is None:
        raise HTTPException(403, "그룹 멤버가 아닙니다")
    if leader and role not in ("owner", "leader"):
        raise HTTPException(403, "리더 이상 권한이 필요합니다")
    return group


def require_project(db: Session, user: User, project_id: str) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "프로젝트가 없습니다")
    require_group(db, user, project.group_id)
    return project


def require_repertoire(db: Session, user: User, repertoire_id: str) -> RepertoireItem:
    item = db.get(RepertoireItem, repertoire_id)
    if item is None:
        raise HTTPException(404, "곡이 없습니다")
    require_project(db, user, item.project_id)
    return item


def require_score(db: Session, user: User, score_id: str) -> Score:
    score = db.get(Score, score_id)
    if score is None:
        raise HTTPException(404, "악보가 없습니다")
    require_repertoire(db, user, score.repertoire_id)
    return score


def is_leader_for_repertoire(db: Session, user: User, repertoire_id: str) -> bool:
    item = db.get(RepertoireItem, repertoire_id)
    if item is None:
        return False
    project = db.get(Project, item.project_id)
    if project is None:
        return False
    return role_in_group(db, user, project.group_id) in ("owner", "leader")
