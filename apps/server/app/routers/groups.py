from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..access import require_group, require_project, role_in_group
from ..auth import get_current_user
from ..db import get_db
from ..models import Group, GroupMember, Project, User
from ..schemas import (
    GroupCreateIn,
    GroupMemberOut,
    GroupOut,
    MemberAddIn,
    ProjectCreateIn,
    ProjectOut,
)

router = APIRouter(prefix="/api", tags=["groups"])


@router.post("/groups", response_model=GroupOut)
def create_group(
    body: GroupCreateIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> GroupOut:
    group = Group(name=body.name, owner_id=user.id)
    db.add(group)
    db.flush()
    db.add(GroupMember(group_id=group.id, user_id=user.id, role="owner"))
    db.commit()
    return GroupOut(id=group.id, name=group.name, my_role="owner")


@router.get("/groups", response_model=list[GroupOut])
def my_groups(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[GroupOut]:
    rows = db.execute(
        select(Group, GroupMember.role).join(GroupMember).where(GroupMember.user_id == user.id)
    ).all()
    return [GroupOut(id=g.id, name=g.name, my_role=role) for g, role in rows]


@router.get("/groups/{group_id}/members", response_model=list[GroupMemberOut])
def group_members(
    group_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[GroupMemberOut]:
    require_group(db, user, group_id)
    rows = db.execute(
        select(User, GroupMember.role).join(GroupMember, GroupMember.user_id == User.id).where(
            GroupMember.group_id == group_id
        )
    ).all()
    return [
        GroupMemberOut(user_id=u.id, display_name=u.display_name, email=u.email, role=role)
        for u, role in rows
    ]


@router.post("/groups/{group_id}/members", response_model=list[GroupMemberOut])
def add_member(
    group_id: str,
    body: MemberAddIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[GroupMemberOut]:
    require_group(db, user, group_id, leader=True)
    target = db.execute(select(User).where(User.email == body.email)).scalar_one_or_none()
    if target is None:
        raise HTTPException(404, "해당 이메일의 사용자가 없습니다 (먼저 가입해야 합니다)")
    if role_in_group(db, target, group_id) is not None:
        raise HTTPException(409, "이미 그룹 멤버입니다")
    db.add(GroupMember(group_id=group_id, user_id=target.id, role=body.role))
    db.commit()
    return group_members(group_id, user, db)


# ---------- 프로젝트 ----------


@router.post("/groups/{group_id}/projects", response_model=ProjectOut)
def create_project(
    group_id: str,
    body: ProjectCreateIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProjectOut:
    require_group(db, user, group_id, leader=True)
    project = Project(group_id=group_id, name=body.name, description=body.description)
    db.add(project)
    db.commit()
    return ProjectOut(id=project.id, group_id=group_id, name=project.name, description=project.description)


@router.get("/groups/{group_id}/projects", response_model=list[ProjectOut])
def list_projects(
    group_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[ProjectOut]:
    require_group(db, user, group_id)
    rows = db.execute(select(Project).where(Project.group_id == group_id)).scalars().all()
    return [ProjectOut(id=p.id, group_id=p.group_id, name=p.name, description=p.description) for p in rows]


@router.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(
    project_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> ProjectOut:
    p = require_project(db, user, project_id)
    return ProjectOut(id=p.id, group_id=p.group_id, name=p.name, description=p.description)
