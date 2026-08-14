from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from ..access import group_membership, require_group, require_project
from ..dependencies import CurrentUser, DbSession
from ..models import Group, GroupMember, Project, RepertoireItem, Score, User
from ..schemas import (
    GroupCreate,
    GroupMemberCreate,
    GroupMemberOut,
    GroupMemberUpdate,
    GroupOut,
    GroupUpdate,
    ProjectCreate,
    ProjectOut,
    ProjectUpdate,
)
from ..security import normalize_email
from ..serializers import group_out, member_out, project_out
from .storage_cleanup import enqueue_score_cleanup

router = APIRouter(prefix="/api", tags=["groups and projects"])


@router.post("/groups", response_model=GroupOut, status_code=status.HTTP_201_CREATED)
def create_group(body: GroupCreate, db: DbSession, user: CurrentUser) -> GroupOut:
    group = Group(name=body.name, description=body.description)
    membership = GroupMember(group=group, user_id=user.id, role="owner")
    db.add_all([group, membership])
    db.commit()
    db.refresh(group)
    db.refresh(membership)
    return group_out(group, membership)


@router.get("/groups", response_model=list[GroupOut])
def list_groups(db: DbSession, user: CurrentUser) -> list[GroupOut]:
    rows = db.execute(
        select(Group, GroupMember)
        .join(GroupMember, GroupMember.group_id == Group.id)
        .where(GroupMember.user_id == user.id)
        .order_by(Group.name)
    ).all()
    return [group_out(group, membership) for group, membership in rows]


@router.get("/groups/{group_id}", response_model=GroupOut)
def get_group(group_id: str, db: DbSession, user: CurrentUser) -> GroupOut:
    group, membership = require_group(db, user, group_id)
    return group_out(group, membership)


@router.patch("/groups/{group_id}", response_model=GroupOut)
def update_group(group_id: str, body: GroupUpdate, db: DbSession, user: CurrentUser) -> GroupOut:
    group, membership = require_group(db, user, group_id, "owner")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(group, field, value)
    db.commit()
    db.refresh(group)
    return group_out(group, membership)


@router.delete("/groups/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_group(group_id: str, request: Request, db: DbSession, user: CurrentUser) -> Response:
    require_group(db, user, group_id, "owner")
    group = db.scalar(select(Group).where(Group.id == group_id).with_for_update())
    assert group is not None
    projects = db.scalars(select(Project).where(Project.group_id == group_id).with_for_update()).all()
    project_ids = [project.id for project in projects]
    repertoire = (
        db.scalars(
            select(RepertoireItem).where(RepertoireItem.project_id.in_(project_ids)).with_for_update()
        ).all()
        if project_ids
        else []
    )
    repertoire_ids = [item.id for item in repertoire]
    scores = (
        db.scalars(
            select(Score)
            .where(Score.repertoire_id.in_(repertoire_ids))
            .order_by(Score.storage_key)
            .with_for_update()
        ).all()
        if repertoire_ids
        else []
    )
    enqueue_score_cleanup(
        db,
        scores,
        request.app.state.settings,
        reason="group",
    )
    db.delete(group)
    db.commit()
    return Response(status_code=204)


@router.get("/groups/{group_id}/members", response_model=list[GroupMemberOut])
def list_members(group_id: str, db: DbSession, user: CurrentUser) -> list[GroupMemberOut]:
    require_group(db, user, group_id)
    rows = db.scalars(
        select(GroupMember)
        .options(selectinload(GroupMember.user))
        .where(GroupMember.group_id == group_id)
        .order_by(GroupMember.joined_at)
    ).all()
    return [member_out(row) for row in rows]


@router.post("/groups/{group_id}/members", response_model=GroupMemberOut, status_code=status.HTTP_201_CREATED)
def add_member(group_id: str, body: GroupMemberCreate, db: DbSession, user: CurrentUser) -> GroupMemberOut:
    require_group(db, user, group_id, "owner")
    target = db.scalar(select(User).where(User.email == normalize_email(str(body.email))))
    if target is None:
        raise HTTPException(status_code=404, detail="registered user not found")
    if not target.is_active or target.email_verified_at is None:
        raise HTTPException(status_code=409, detail="user must verify their email before joining a group")
    if group_membership(db, target.id, group_id):
        raise HTTPException(status_code=409, detail="user is already a member")
    row = GroupMember(group_id=group_id, user_id=target.id, role=body.role)
    db.add(row)
    db.commit()
    loaded_row = db.scalar(
        select(GroupMember).options(selectinload(GroupMember.user)).where(GroupMember.id == row.id)
    )
    assert loaded_row is not None
    return member_out(loaded_row)


@router.patch("/groups/{group_id}/members/{member_id}", response_model=GroupMemberOut)
def update_member(
    group_id: str,
    member_id: str,
    body: GroupMemberUpdate,
    db: DbSession,
    user: CurrentUser,
) -> GroupMemberOut:
    require_group(db, user, group_id, "owner")
    row = db.scalar(
        select(GroupMember)
        .options(selectinload(GroupMember.user))
        .where(GroupMember.group_id == group_id, GroupMember.user_id == member_id)
    )
    if row is None:
        raise HTTPException(status_code=404, detail="group member not found")
    if row.role == "owner":
        raise HTTPException(status_code=409, detail="owner role cannot be changed")
    row.role = body.role
    db.commit()
    return member_out(row)


@router.delete("/groups/{group_id}/members/{member_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(group_id: str, member_id: str, db: DbSession, user: CurrentUser) -> Response:
    require_group(db, user, group_id, "owner")
    row = db.scalar(
        select(GroupMember).where(
            GroupMember.group_id == group_id,
            GroupMember.user_id == member_id,
        )
    )
    if row is None:
        raise HTTPException(status_code=404, detail="group member not found")
    if row.role == "owner":
        raise HTTPException(status_code=409, detail="owner cannot be removed")
    db.delete(row)
    db.commit()
    return Response(status_code=204)


@router.post("/groups/{group_id}/projects", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
def create_project(group_id: str, body: ProjectCreate, db: DbSession, user: CurrentUser) -> ProjectOut:
    require_group(db, user, group_id, "leader")
    project = Project(group_id=group_id, name=body.name, description=body.description)
    db.add(project)
    db.commit()
    db.refresh(project)
    return project_out(project)


@router.get("/groups/{group_id}/projects", response_model=list[ProjectOut])
def list_projects(group_id: str, db: DbSession, user: CurrentUser) -> list[ProjectOut]:
    require_group(db, user, group_id)
    rows = db.scalars(select(Project).where(Project.group_id == group_id).order_by(Project.name)).all()
    return [project_out(row) for row in rows]


@router.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(project_id: str, db: DbSession, user: CurrentUser) -> ProjectOut:
    project, _ = require_project(db, user, project_id)
    return project_out(project)


@router.patch("/projects/{project_id}", response_model=ProjectOut)
def update_project(project_id: str, body: ProjectUpdate, db: DbSession, user: CurrentUser) -> ProjectOut:
    project, _ = require_project(db, user, project_id, "leader")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(project, field, value)
    db.commit()
    db.refresh(project)
    return project_out(project)


@router.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project_id: str, request: Request, db: DbSession, user: CurrentUser) -> Response:
    require_project(db, user, project_id, "leader")
    project = db.scalar(select(Project).where(Project.id == project_id).with_for_update())
    assert project is not None
    repertoire = db.scalars(
        select(RepertoireItem).where(RepertoireItem.project_id == project_id).with_for_update()
    ).all()
    repertoire_ids = [item.id for item in repertoire]
    scores = (
        db.scalars(
            select(Score)
            .where(Score.repertoire_id.in_(repertoire_ids))
            .order_by(Score.storage_key)
            .with_for_update()
        ).all()
        if repertoire_ids
        else []
    )
    enqueue_score_cleanup(
        db,
        scores,
        request.app.state.settings,
        reason="project",
    )
    db.delete(project)
    db.commit()
    return Response(status_code=204)
