"""Pydantic 스키마 — 클라이언트 타입(packages/protocol)의 단일 원천.

TODO(설계문서 §11): OpenAPI → openapi-typescript 생성 파이프라인으로 protocol 패키지를 자동화.
"""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


# ---------- 인증 ----------


class RegisterIn(CamelModel):
    email: EmailStr
    password: str = Field(min_length=8)
    display_name: str = Field(min_length=1, max_length=64)


class LoginIn(CamelModel):
    email: EmailStr
    password: str


class UserOut(CamelModel):
    id: str
    email: str
    display_name: str


class AuthResponse(CamelModel):
    token: str
    user: UserOut


# ---------- 그룹 · 프로젝트 · 레파토리 ----------


class GroupCreateIn(CamelModel):
    name: str = Field(min_length=1, max_length=128)


class GroupOut(CamelModel):
    id: str
    name: str
    my_role: Literal["owner", "leader", "member"]


class MemberAddIn(CamelModel):
    email: EmailStr
    role: Literal["leader", "member"] = "member"


class GroupMemberOut(CamelModel):
    user_id: str
    display_name: str
    email: str
    role: str


class ProjectCreateIn(CamelModel):
    name: str = Field(min_length=1, max_length=128)
    description: str = ""


class ProjectOut(CamelModel):
    id: str
    group_id: str
    name: str
    description: str


class RepertoireCreateIn(CamelModel):
    title: str = Field(min_length=1, max_length=255)
    composer: str = ""


class RepertoireOut(CamelModel):
    id: str
    project_id: str
    title: str
    composer: str
    has_tempo_map: bool
    score_count: int
    open_todo_count: int


# ---------- 템포맵 ----------


class TempoMapPutIn(CamelModel):
    """base_revision이 서버와 다르면 409 (동시 수정 감지)"""

    base_revision: int
    data: dict[str, Any]


class TempoMapOut(CamelModel):
    revision: int
    data: dict[str, Any]


# ---------- 악보 ----------


class MeasureRect(CamelModel):
    x: float
    y: float
    w: float
    h: float


class MeasureRegion(CamelModel):
    page: int
    measure_number: int
    rect: MeasureRect


class MeasureMapPutIn(CamelModel):
    regions: list[MeasureRegion]
    measure_number_offset: int = 0


class ScoreOut(CamelModel):
    id: str
    repertoire_id: str
    kind: Literal["full", "part"]
    instrument: str
    filename: str
    content_type: str
    measure_number_offset: int
    has_measure_map: bool


class MeasureMapOut(CamelModel):
    regions: list[MeasureRegion]
    measure_number_offset: int


class AnnotationPutIn(CamelModel):
    scope: Literal["private", "project"] = "private"
    data: dict[str, Any]


class AnnotationOut(CamelModel):
    scope: str
    data: dict[str, Any]


# ---------- 연습일지 · 할일 ----------


class LogAnchor(CamelModel):
    measure_number: int | None = None
    note: str | None = None


class PracticeLogCreateIn(CamelModel):
    content: str = Field(min_length=1)
    anchors: list[LogAnchor] = []


class PracticeLogOut(CamelModel):
    id: str
    repertoire_id: str
    author_name: str
    content: str
    anchors: list[LogAnchor]
    created_at: str


class TodoCreateIn(CamelModel):
    content: str = Field(min_length=1)
    assignee: str = ""


class TodoOut(CamelModel):
    id: str
    repertoire_id: str
    content: str
    assignee: str
    done: bool


# ---------- 실시간 세션 (WS, 설계문서 §6.3) ----------


class RoomCreateIn(CamelModel):
    repertoire_id: str


class RoomCreated(CamelModel):
    room_id: str


class TransportState(CamelModel):
    room_id: str
    repertoire_id: str
    tempo_map_revision: int
    status: Literal["idle", "playing"]
    anchor: dict[str, int] | None = None
    server_start_time: int | None = None
    count_in: bool = True


class RosterMember(CamelModel):
    user_id: str
    display_name: str
    is_leader: bool
    rtt_ms: float | None = None
