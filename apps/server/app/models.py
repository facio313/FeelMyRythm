from __future__ import annotations

import uuid
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def new_id() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    return datetime.now(UTC)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class User(TimestampMixin, Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str | None] = mapped_column(String(255))
    google_subject: Mapped[str | None] = mapped_column(String(255), unique=True)
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    email_verification_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    password_reset_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    account_delete_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    auth_generation: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class RefreshSession(Base):
    __tablename__ = "refresh_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[bytes] = mapped_column(LargeBinary(32), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Group(TimestampMixin, Base):
    __tablename__ = "groups"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(160))
    description: Mapped[str] = mapped_column(Text, default="")
    members: Mapped[list[GroupMember]] = relationship(back_populates="group", cascade="all, delete-orphan")


class GroupMember(Base):
    __tablename__ = "group_members"
    __table_args__ = (UniqueConstraint("group_id", "user_id", name="uq_group_member"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    group_id: Mapped[str] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16))
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    group: Mapped[Group] = relationship(back_populates="members")
    user: Mapped[User] = relationship()


class Project(TimestampMixin, Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    group_id: Mapped[str] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(180))
    description: Mapped[str] = mapped_column(Text, default="")


class RepertoireItem(TimestampMixin, Base):
    __tablename__ = "repertoire_items"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(240))
    composer: Mapped[str] = mapped_column(String(180), default="")
    notes: Mapped[str] = mapped_column(Text, default="")


class TempoMapRevision(Base):
    __tablename__ = "tempo_map_revisions"
    __table_args__ = (
        UniqueConstraint("repertoire_id", "revision", name="uq_tempo_map_revision"),
        Index("ix_tempo_map_latest", "repertoire_id", "revision"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    repertoire_id: Mapped[str] = mapped_column(
        ForeignKey("repertoire_items.id", ondelete="CASCADE"), index=True
    )
    revision: Mapped[int] = mapped_column(Integer)
    data: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_by_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Score(TimestampMixin, Base):
    __tablename__ = "scores"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    repertoire_id: Mapped[str] = mapped_column(
        ForeignKey("repertoire_items.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(16))
    instrument: Mapped[str] = mapped_column(String(120), default="")
    filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(120))
    storage_key: Mapped[str] = mapped_column(String(512), unique=True)
    staging_key: Mapped[str | None] = mapped_column(String(512), unique=True, index=True)
    upload_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    size_bytes: Mapped[int | None] = mapped_column(Integer)
    upload_status: Mapped[str] = mapped_column(String(16), default="pending")
    created_by_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))


class StorageDeletionJob(TimestampMixin, Base):
    __tablename__ = "storage_deletion_jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'leased', 'completed')",
            name="ck_storage_deletion_jobs_status",
        ),
        Index(
            "ix_storage_deletion_jobs_due",
            "status",
            "next_attempt_at",
            "lease_expires_at",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    storage_key: Mapped[str] = mapped_column(String(512), unique=True)
    reason: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16), default="pending")
    attempt_count: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    lease_owner: Mapped[str | None] = mapped_column(String(36))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(String(160))
    guard_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class MeasureMap(TimestampMixin, Base):
    __tablename__ = "measure_maps"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    score_id: Mapped[str] = mapped_column(
        ForeignKey("scores.id", ondelete="CASCADE"), unique=True, index=True
    )
    revision: Mapped[int] = mapped_column(Integer, default=1)
    regions: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    measure_number_offset: Mapped[int] = mapped_column(Integer, default=0)
    updated_by_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))


class Annotation(TimestampMixin, Base):
    __tablename__ = "annotations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    score_id: Mapped[str] = mapped_column(ForeignKey("scores.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    scope: Mapped[str] = mapped_column(String(16))
    revision: Mapped[int] = mapped_column(Integer, default=1)
    data: Mapped[dict[str, Any]] = mapped_column(JSON)


class PracticeLog(TimestampMixin, Base):
    __tablename__ = "practice_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    repertoire_id: Mapped[str] = mapped_column(
        ForeignKey("repertoire_items.id", ondelete="CASCADE"), index=True
    )
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    content: Mapped[str] = mapped_column(Text)
    anchors: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)


class Todo(TimestampMixin, Base):
    __tablename__ = "todos"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    repertoire_id: Mapped[str] = mapped_column(
        ForeignKey("repertoire_items.id", ondelete="CASCADE"), index=True
    )
    practice_log_id: Mapped[str | None] = mapped_column(
        ForeignKey("practice_logs.id", ondelete="CASCADE"), index=True
    )
    content: Mapped[str] = mapped_column(Text)
    assignee_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    due_date: Mapped[date | None] = mapped_column(Date)
    done: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))


class PracticeSession(TimestampMixin, Base):
    __tablename__ = "practice_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    room_id: Mapped[str] = mapped_column(String(36), unique=True, index=True)
    repertoire_id: Mapped[str] = mapped_column(
        ForeignKey("repertoire_items.id", ondelete="CASCADE"), index=True
    )
    leader_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    tempo_map_revision: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="idle")
    anchor_measure: Mapped[int | None] = mapped_column(Integer)
    anchor_pass: Mapped[int | None] = mapped_column(Integer)
    server_start_time_ns: Mapped[int | None] = mapped_column(BigInteger)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DeviceCalibration(TimestampMixin, Base):
    __tablename__ = "device_calibrations"
    __table_args__ = (
        UniqueConstraint("user_id", "device_fingerprint", "output_label", name="uq_device_calibration"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    device_fingerprint: Mapped[str] = mapped_column(String(255))
    output_label: Mapped[str] = mapped_column(String(255))
    offset_ms: Mapped[float] = mapped_column(Float)
