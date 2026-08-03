from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def uid() -> str:
    return uuid4().hex


def now_utc() -> datetime:
    return datetime.now(UTC)


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(128))
    display_name: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class Group(Base):
    __tablename__ = "groups"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(128))
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"))


class GroupMember(Base):
    __tablename__ = "group_members"
    group_id: Mapped[str] = mapped_column(ForeignKey("groups.id"), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    role: Mapped[str] = mapped_column(String(16), default="member")  # owner | leader | member


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    group_id: Mapped[str] = mapped_column(ForeignKey("groups.id"), index=True)
    name: Mapped[str] = mapped_column(String(128))
    description: Mapped[str] = mapped_column(Text, default="")


class RepertoireItem(Base):
    __tablename__ = "repertoire_items"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    title: Mapped[str] = mapped_column(String(255))
    composer: Mapped[str] = mapped_column(String(128), default="")


class TempoMapRow(Base):
    """곡당 1행. 수정마다 revision 증가 (동기화 일관성의 근거, 설계문서 §8)"""

    __tablename__ = "tempo_maps"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    repertoire_id: Mapped[str] = mapped_column(ForeignKey("repertoire_items.id"), unique=True, index=True)
    revision: Mapped[int] = mapped_column(Integer, default=0)
    data: Mapped[dict] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class Score(Base):
    __tablename__ = "scores"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    repertoire_id: Mapped[str] = mapped_column(ForeignKey("repertoire_items.id"), index=True)
    kind: Mapped[str] = mapped_column(String(8), default="full")  # full(총보) | part
    instrument: Mapped[str] = mapped_column(String(64), default="")
    filename: Mapped[str] = mapped_column(String(255))
    stored_name: Mapped[str] = mapped_column(String(64))
    content_type: Mapped[str] = mapped_column(String(128), default="application/octet-stream")
    measure_map: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    measure_number_offset: Mapped[int] = mapped_column(Integer, default=0)


class Annotation(Base):
    """악보 필기 오버레이 — 사용자·범위별 1행 upsert"""

    __tablename__ = "annotations"
    __table_args__ = (UniqueConstraint("score_id", "user_id", "scope"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    score_id: Mapped[str] = mapped_column(ForeignKey("scores.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    scope: Mapped[str] = mapped_column(String(16), default="private")  # private | project
    data: Mapped[dict] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class PracticeLog(Base):
    __tablename__ = "practice_logs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    repertoire_id: Mapped[str] = mapped_column(ForeignKey("repertoire_items.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    content: Mapped[str] = mapped_column(Text)
    anchors: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class Todo(Base):
    __tablename__ = "todos"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    repertoire_id: Mapped[str] = mapped_column(ForeignKey("repertoire_items.id"), index=True)
    content: Mapped[str] = mapped_column(Text)
    assignee: Mapped[str] = mapped_column(String(64), default="")
    done: Mapped[bool] = mapped_column(Boolean, default=False)


class DeviceCalibration(Base):
    """기기+출력장치별 오디오 지연 오프셋 (설계문서 §6.5)"""

    __tablename__ = "device_calibrations"
    __table_args__ = (UniqueConstraint("user_id", "device_label", "output_label"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    device_label: Mapped[str] = mapped_column(String(128))
    output_label: Mapped[str] = mapped_column(String(128), default="default")
    offset_ms: Mapped[int] = mapped_column(Integer, default=0)
