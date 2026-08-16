from __future__ import annotations

from typing import cast

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import (
    Annotation,
    DeviceCalibration,
    Group,
    GroupMember,
    MeasureMap,
    OmrDraftJob,
    PracticeLog,
    Project,
    RepertoireItem,
    Score,
    TempoMapRevision,
    Todo,
    User,
)
from .schemas import (
    AnnotationOut,
    DeviceCalibrationOut,
    GroupMemberOut,
    GroupOut,
    LogAnchor,
    MeasureMapOut,
    OmrDraftOut,
    PracticeLogOut,
    ProjectOut,
    RepertoireOut,
    Role,
    ScoreOut,
    TempoMapOut,
    TodoOut,
    UserOut,
)


def user_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        email_verified_at=user.email_verified_at,
        has_password=user.password_hash is not None,
    )


def group_out(group: Group, membership: GroupMember) -> GroupOut:
    return GroupOut(
        id=group.id,
        name=group.name,
        description=group.description,
        my_role=cast(Role, membership.role),
        created_at=group.created_at,
        updated_at=group.updated_at,
    )


def member_out(member: GroupMember) -> GroupMemberOut:
    return GroupMemberOut(
        user_id=member.user_id,
        email=member.user.email,
        display_name=member.user.display_name,
        role=cast(Role, member.role),
        joined_at=member.joined_at,
    )


def project_out(project: Project) -> ProjectOut:
    return ProjectOut.model_validate(project)


def latest_tempo_revision(db: Session, repertoire_id: str) -> int:
    return int(
        db.scalar(
            select(func.coalesce(func.max(TempoMapRevision.revision), 0)).where(
                TempoMapRevision.repertoire_id == repertoire_id
            )
        )
        or 0
    )


def repertoire_out(db: Session, item: RepertoireItem) -> RepertoireOut:
    score_count = int(
        db.scalar(
            select(func.count())
            .select_from(Score)
            .where(Score.repertoire_id == item.id, Score.upload_status == "ready")
        )
        or 0
    )
    open_todo_count = int(
        db.scalar(
            select(func.count())
            .select_from(Todo)
            .where(
                Todo.repertoire_id == item.id,
                Todo.done.is_(False),
            )
        )
        or 0
    )
    return RepertoireOut(
        id=item.id,
        project_id=item.project_id,
        title=item.title,
        composer=item.composer,
        notes=item.notes,
        current_tempo_map_revision=latest_tempo_revision(db, item.id),
        score_count=score_count,
        open_todo_count=open_todo_count,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


def tempo_map_out(row: TempoMapRevision) -> TempoMapOut:
    return TempoMapOut.model_validate(row)


def score_out(score: Score) -> ScoreOut:
    return ScoreOut.model_validate(score)


def measure_map_out(row: MeasureMap) -> MeasureMapOut:
    return MeasureMapOut.model_validate(row)


def omr_draft_out(row: OmrDraftJob) -> OmrDraftOut:
    return OmrDraftOut.model_validate(row)


def annotation_out(row: Annotation) -> AnnotationOut:
    return AnnotationOut.model_validate(row)


def log_out(row: PracticeLog, author: User) -> PracticeLogOut:
    return PracticeLogOut(
        id=row.id,
        repertoire_id=row.repertoire_id,
        author_id=row.author_id,
        author_name=author.display_name,
        content=row.content,
        anchors=[LogAnchor.model_validate(anchor) for anchor in row.anchors],
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def todo_out(row: Todo) -> TodoOut:
    return TodoOut.model_validate(row)


def calibration_out(row: DeviceCalibration) -> DeviceCalibrationOut:
    return DeviceCalibrationOut.model_validate(row)
