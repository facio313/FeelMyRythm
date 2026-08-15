from __future__ import annotations

import math
from datetime import date, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, StringConstraints, model_validator
from pydantic.alias_generators import to_camel

NonEmpty = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
Password = Annotated[str, StringConstraints(min_length=8, max_length=128)]


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        from_attributes=True,
        extra="forbid",
    )


class UserOut(ApiModel):
    id: str
    email: EmailStr
    display_name: str
    email_verified_at: datetime | None = None
    has_password: bool


class UserUpdate(ApiModel):
    display_name: NonEmpty


class UserDeleteIn(ApiModel):
    email: EmailStr
    current_password: Annotated[str, StringConstraints(max_length=128)] | None = None
    google_id_token: NonEmpty | None = None
    account_delete_token: NonEmpty | None = None

    @model_validator(mode="after")
    def one_reauthentication_proof(self) -> UserDeleteIn:
        proofs = (self.current_password, self.google_id_token, self.account_delete_token)
        if sum(proof is not None for proof in proofs) > 1:
            raise ValueError("provide only one account deletion proof")
        return self


class RegisterIn(ApiModel):
    email: EmailStr
    display_name: NonEmpty


class LoginIn(ApiModel):
    email: EmailStr
    password: str


class GoogleLoginIn(ApiModel):
    id_token: NonEmpty


class RefreshIn(ApiModel):
    refresh_token: NonEmpty


class EmailVerificationCompleteIn(ApiModel):
    token: NonEmpty
    password: Password
    password_confirmation: Password

    @model_validator(mode="after")
    def passwords_match(self) -> EmailVerificationCompleteIn:
        if self.password != self.password_confirmation:
            raise ValueError("password confirmation does not match")
        return self


class EmailVerificationResendIn(ApiModel):
    email: EmailStr


class PasswordResetRequestIn(ApiModel):
    email: EmailStr


class PasswordResetCompleteIn(ApiModel):
    token: NonEmpty
    password: Password
    password_confirmation: Password

    @model_validator(mode="after")
    def passwords_match(self) -> PasswordResetCompleteIn:
        if self.password != self.password_confirmation:
            raise ValueError("password confirmation does not match")
        return self


class EmailVerificationPendingOut(ApiModel):
    email: EmailStr
    expires_in: int
    message: str


class TokenPairOut(ApiModel):
    access_token: str
    refresh_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int
    user: UserOut


class MessageOut(ApiModel):
    message: str


Role = Literal["owner", "leader", "member"]
TransportStatus = Literal["idle", "armed", "playing", "stopped"]
ServerMessageType = Literal[
    "JOINED",
    "PONG",
    "TRANSPORT",
    "ROOM_ROSTER",
    "TEMPOMAP_UPDATED",
    "ANNOTATION_JOINED",
    "ANNOTATION_SNAPSHOT",
    "ANNOTATION_EVENT",
    "ANNOTATION_PONG",
    "ERROR",
]


class GroupCreate(ApiModel):
    name: NonEmpty
    description: str = ""


class GroupUpdate(ApiModel):
    name: NonEmpty | None = None
    description: str | None = None


class GroupOut(ApiModel):
    id: str
    name: str
    description: str
    my_role: Role
    created_at: datetime
    updated_at: datetime


class GroupMemberCreate(ApiModel):
    email: EmailStr
    role: Literal["leader", "member"] = "member"


class GroupMemberUpdate(ApiModel):
    role: Literal["leader", "member"]


class GroupMemberOut(ApiModel):
    user_id: str
    email: EmailStr
    display_name: str
    role: Role
    joined_at: datetime


class ProjectCreate(ApiModel):
    name: NonEmpty
    description: str = ""


class ProjectUpdate(ApiModel):
    name: NonEmpty | None = None
    description: str | None = None


class ProjectOut(ApiModel):
    id: str
    group_id: str
    name: str
    description: str
    created_at: datetime
    updated_at: datetime


class RepertoireCreate(ApiModel):
    title: NonEmpty
    composer: str = ""
    notes: str = ""


class RepertoireUpdate(ApiModel):
    title: NonEmpty | None = None
    composer: str | None = None
    notes: str | None = None


class RepertoireOut(ApiModel):
    id: str
    project_id: str
    title: str
    composer: str
    notes: str
    current_tempo_map_revision: int
    score_count: int
    open_todo_count: int
    created_at: datetime
    updated_at: datetime


class RepertoireAccessOut(ApiModel):
    role: Role


NoteValue = Literal[
    "whole",
    "dottedWhole",
    "half",
    "dottedHalf",
    "quarter",
    "dottedQuarter",
    "eighth",
    "dottedEighth",
    "sixteenth",
    "dottedSixteenth",
    "thirtySecond",
]
NOTE_VALUE_QUARTER_LENGTHS: dict[NoteValue, float] = {
    "whole": 4,
    "dottedWhole": 6,
    "half": 2,
    "dottedHalf": 3,
    "quarter": 1,
    "dottedQuarter": 1.5,
    "eighth": 0.5,
    "dottedEighth": 0.75,
    "sixteenth": 0.25,
    "dottedSixteenth": 0.375,
    "thirtySecond": 0.125,
}


class TempoMapContractModel(ApiModel):
    model_config = ConfigDict(strict=True)


class TempoMapTimeSignature(TempoMapContractModel):
    num: int = Field(ge=1)
    denom: int = Field(ge=1)


class TempoMapTempoChange(TempoMapContractModel):
    type: Literal["rit", "accel"]
    target_bpm: float = Field(gt=0)


class TempoMapSection(TempoMapContractModel):
    id: NonEmpty
    label: str | None = None
    start_measure: int = Field(ge=1)
    end_measure: int = Field(ge=1)
    time_signature: TempoMapTimeSignature
    bpm: float = Field(gt=0)
    beat_unit: NoteValue
    tempo_change: TempoMapTempoChange | None = None
    accent_pattern: list[Literal[0, 1, 2]] | None = None
    subdivision: Literal[1, 2, 3, 4] | None = None


class TempoMapVoltaEnding(TempoMapContractModel):
    measures: list[int] = Field(min_length=2, max_length=2)
    for_pass: list[int] = Field(min_length=1)


class TempoMapRepeat(TempoMapContractModel):
    type: Literal["repeat"]
    start_measure: int = Field(ge=1)
    end_measure: int = Field(ge=1)
    times: int = Field(ge=1)
    endings: list[TempoMapVoltaEnding] | None = None


class TempoMapDaCapo(TempoMapContractModel):
    type: Literal["dc"]
    at_measure: int = Field(ge=1)
    al_fine: int | None = Field(default=None, ge=1)
    al_coda: bool | None = None


class TempoMapDalSegno(TempoMapContractModel):
    type: Literal["ds"]
    at_measure: int = Field(ge=1)
    segno_measure: int = Field(ge=1)
    al_fine: int | None = Field(default=None, ge=1)
    al_coda: bool | None = None


class TempoMapCoda(TempoMapContractModel):
    type: Literal["coda"]
    to_coda_measure: int = Field(ge=1)
    coda_measure: int = Field(ge=1)


TempoMapJump = Annotated[
    TempoMapRepeat | TempoMapDaCapo | TempoMapDalSegno | TempoMapCoda,
    Field(discriminator="type"),
]


class TempoMapCountIn(TempoMapContractModel):
    measures: Literal[1, 2]
    use_section_meter: Literal[True]


class TempoMapAnacrusis(TempoMapContractModel):
    beats: int = Field(ge=1)


class TempoMapData(TempoMapContractModel):
    id: NonEmpty
    repertoire_item_id: NonEmpty
    revision: int = Field(ge=0)
    total_measures: int = Field(ge=1)
    anacrusis: TempoMapAnacrusis | None = None
    sections: list[TempoMapSection] = Field(min_length=1)
    jumps: list[TempoMapJump]
    count_in: TempoMapCountIn

    @model_validator(mode="after")
    def validate_semantics(self) -> TempoMapData:
        expected_start = 1
        section_ids: set[str] = set()
        first_measure_beats: int | None = None
        for section in self.sections:
            if section.id in section_ids:
                raise ValueError("tempo map section ids must be unique")
            section_ids.add(section.id)
            if section.start_measure != expected_start:
                raise ValueError("tempo map sections must be ordered and cover contiguous measures")
            if section.end_measure < section.start_measure or section.end_measure > self.total_measures:
                raise ValueError("tempo map section ranges must stay within totalMeasures")
            if section.time_signature.denom & (section.time_signature.denom - 1):
                raise ValueError("tempo map time-signature denominator must be a power of two")
            if not math.isfinite(section.bpm):
                raise ValueError("tempo map BPM must be finite")
            measure_beats = (
                section.time_signature.num
                * (4 / section.time_signature.denom)
                / NOTE_VALUE_QUARTER_LENGTHS[section.beat_unit]
            )
            if not math.isfinite(measure_beats) or not measure_beats.is_integer():
                raise ValueError("tempo map beatUnit must divide a measure into whole beats")
            beat_count = int(measure_beats)
            if first_measure_beats is None:
                first_measure_beats = beat_count
            if section.accent_pattern is not None and len(section.accent_pattern) != beat_count:
                raise ValueError("tempo map accentPattern must match the section beat count")
            if section.tempo_change is not None:
                change = section.tempo_change
                if not math.isfinite(change.target_bpm):
                    raise ValueError("tempo map targetBpm must be finite")
                if change.type == "rit" and change.target_bpm >= section.bpm:
                    raise ValueError("rit targetBpm must be lower than bpm")
                if change.type == "accel" and change.target_bpm <= section.bpm:
                    raise ValueError("accel targetBpm must be higher than bpm")
            expected_start = section.end_measure + 1
        if expected_start != self.total_measures + 1:
            raise ValueError("tempo map sections must cover totalMeasures exactly once")
        if (
            self.anacrusis is not None
            and first_measure_beats is not None
            and self.anacrusis.beats >= first_measure_beats
        ):
            raise ValueError("tempo map anacrusis must be shorter than the first measure")

        repeats: list[TempoMapRepeat] = []
        coda_count = 0
        requires_coda = False
        for jump in self.jumps:
            if isinstance(jump, TempoMapRepeat):
                if jump.end_measure < jump.start_measure or jump.end_measure > self.total_measures:
                    raise ValueError("tempo map repeat range must stay within totalMeasures")
                repeats.append(jump)
                ending_ranges: list[tuple[int, int]] = []
                for ending in jump.endings or []:
                    start, end = ending.measures
                    if start < jump.start_measure or end > jump.end_measure or end < start:
                        raise ValueError("tempo map volta ending must be inside its repeat")
                    if len(set(ending.for_pass)) != len(ending.for_pass) or any(
                        pass_number < 1 or pass_number > jump.times for pass_number in ending.for_pass
                    ):
                        raise ValueError("tempo map volta ending must reference unique repeat passes")
                    if any(
                        start <= other_end and other_start <= end for other_start, other_end in ending_ranges
                    ):
                        raise ValueError("tempo map volta ending ranges must not overlap")
                    ending_ranges.append((start, end))
                continue
            if isinstance(jump, TempoMapCoda):
                coda_count += 1
                if (
                    jump.to_coda_measure > self.total_measures
                    or jump.coda_measure > self.total_measures
                    or jump.to_coda_measure == jump.coda_measure
                ):
                    raise ValueError("tempo map coda measures must be distinct and in range")
                continue
            if jump.at_measure > self.total_measures:
                raise ValueError("tempo map navigation measure must be in range")
            if jump.al_fine is not None and jump.al_fine > self.total_measures:
                raise ValueError("tempo map Fine measure must be in range")
            if isinstance(jump, TempoMapDalSegno) and jump.segno_measure > self.total_measures:
                raise ValueError("tempo map Segno measure must be in range")
            requires_coda = requires_coda or jump.al_coda is True

        if coda_count > 1:
            raise ValueError("tempo map supports at most one coda directive")
        if requires_coda and coda_count != 1:
            raise ValueError("an alCoda directive requires exactly one coda directive")
        for index, left in enumerate(repeats):
            for right in repeats[index + 1 :]:
                identical = (
                    left.start_measure == right.start_measure and left.end_measure == right.end_measure
                )
                crosses = (
                    left.start_measure < right.start_measure <= left.end_measure < right.end_measure
                    or right.start_measure < left.start_measure <= right.end_measure < left.end_measure
                )
                if identical or crosses:
                    raise ValueError("tempo map repeat ranges must be distinct, disjoint, or nested")
        return self


class TempoMapWrite(ApiModel):
    expected_revision: int = Field(ge=0)
    data: TempoMapData


class TempoMapOut(ApiModel):
    id: str
    repertoire_id: str
    revision: int
    data: TempoMapData
    created_by_id: str
    created_at: datetime


class RevisionConflictOut(ApiModel):
    detail: str
    expected_revision: int
    actual_revision: int


ScoreKind = Literal["full", "part"]


class ScorePresignIn(ApiModel):
    filename: NonEmpty
    content_type: NonEmpty
    size_bytes: int = Field(gt=0)
    kind: ScoreKind
    instrument: str = ""


class UploadTargetOut(ApiModel):
    score_id: str
    storage_key: str
    upload_url: str
    method: Literal["PUT", "POST"]
    headers: dict[str, str] = Field(default_factory=dict)
    fields: dict[str, str] = Field(default_factory=dict)
    expires_at: datetime


class ScoreCompleteIn(ApiModel):
    size_bytes: int = Field(gt=0)


class ScoreUpdate(ApiModel):
    kind: ScoreKind | None = None
    instrument: str | None = None


class ScoreOut(ApiModel):
    id: str
    repertoire_id: str
    kind: ScoreKind
    instrument: str
    filename: str
    content_type: str
    size_bytes: int | None
    upload_status: Literal["pending", "ready"]
    created_at: datetime
    updated_at: datetime


class DownloadUrlOut(ApiModel):
    url: str
    expires_at: datetime


class MeasureRect(ApiModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(gt=0, le=1)
    h: float = Field(gt=0, le=1)

    @model_validator(mode="after")
    def within_page(self) -> MeasureRect:
        if self.x + self.w > 1 or self.y + self.h > 1:
            raise ValueError("measure rectangle must remain within normalized page bounds")
        return self


class MeasureRegion(ApiModel):
    page: int = Field(ge=1)
    measure_number: int = Field(ge=1)
    rect: MeasureRect


class MeasureMapWrite(ApiModel):
    expected_revision: int = Field(ge=0)
    regions: list[MeasureRegion]
    measure_number_offset: int = 0


class MeasureMapOut(ApiModel):
    id: str
    score_id: str
    revision: int
    regions: list[MeasureRegion]
    measure_number_offset: int
    updated_at: datetime


class ScoreSettingsWrite(ApiModel):
    kind: ScoreKind
    instrument: str = ""
    expected_measure_map_revision: int = Field(ge=0)
    regions: list[MeasureRegion]
    measure_number_offset: int = 0


class ScoreSettingsOut(ApiModel):
    score: ScoreOut
    measure_map: MeasureMapOut


OmrDraftStatus = Literal["pending", "running", "succeeded", "failed"]


class OmrDraftCreate(ApiModel):
    expected_measure_map_revision: int = Field(ge=0)


class OmrDraftOut(ApiModel):
    id: str
    score_id: str
    requested_by_id: str
    expected_measure_map_revision: int
    status: OmrDraftStatus
    regions: list[MeasureRegion]
    warnings: list[str]
    error: str | None
    created_at: datetime
    updated_at: datetime


AnnotationScope = Literal["private", "project"]


class AnnotationPoint(ApiModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)


class PenAnnotationPayload(ApiModel):
    points: list[AnnotationPoint] = Field(min_length=2)


class PositionedAnnotationPayload(ApiModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    text: NonEmpty
    anchor_type: Literal["page", "measure"] = "page"


class PenAnnotationData(ApiModel):
    kind: Literal["pen"]
    page: int = Field(ge=1)
    measure_number: int | None = Field(default=None, ge=1)
    payload: PenAnnotationPayload


class TextAnnotationData(ApiModel):
    kind: Literal["text"]
    page: int = Field(ge=1)
    measure_number: int | None = Field(default=None, ge=1)
    payload: PositionedAnnotationPayload

    @model_validator(mode="after")
    def validate_measure_anchor(self) -> TextAnnotationData:
        if self.payload.anchor_type == "measure" and self.measure_number is None:
            raise ValueError("measureNumber is required for a measure anchor")
        return self


class StampAnnotationData(ApiModel):
    kind: Literal["stamp"]
    page: int = Field(ge=1)
    measure_number: int | None = Field(default=None, ge=1)
    payload: PositionedAnnotationPayload

    @model_validator(mode="after")
    def validate_measure_anchor(self) -> StampAnnotationData:
        if self.payload.anchor_type == "measure" and self.measure_number is None:
            raise ValueError("measureNumber is required for a measure anchor")
        return self


AnnotationData = Annotated[
    PenAnnotationData | TextAnnotationData | StampAnnotationData,
    Field(discriminator="kind"),
]


class AnnotationCreate(ApiModel):
    scope: AnnotationScope
    data: AnnotationData


class AnnotationUpdate(ApiModel):
    expected_revision: int = Field(ge=0)
    data: AnnotationData


class AnnotationOut(ApiModel):
    id: str
    score_id: str
    author_id: str
    scope: AnnotationScope
    revision: int
    data: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class JoinAnnotationsPayload(ApiModel):
    repertoire_id: str
    access_token: str


class AnnotationPingPayload(ApiModel):
    nonce: str


class JoinAnnotationsMessage(ApiModel):
    type: Literal["JOIN_ANNOTATIONS"]
    request_id: str | None = None
    payload: JoinAnnotationsPayload


class AnnotationPingMessage(ApiModel):
    type: Literal["ANNOTATION_PING"]
    request_id: str | None = None
    payload: AnnotationPingPayload


AnnotationWsClientMessage = Annotated[
    JoinAnnotationsMessage | AnnotationPingMessage,
    Field(discriminator="type"),
]


class AnnotationJoinedPayload(ApiModel):
    repertoire_id: str
    user_id: str


class AnnotationSnapshotPayload(ApiModel):
    repertoire_id: str
    annotations: list[AnnotationOut]


class AnnotationEventPayload(ApiModel):
    event_id: str
    repertoire_id: str
    operation: Literal["upsert", "delete"]
    annotation_id: str
    revision: int
    scope: AnnotationScope
    author_id: str
    annotation: AnnotationOut | None = None

    @model_validator(mode="after")
    def validate_annotation_shape(self) -> AnnotationEventPayload:
        if self.operation == "upsert" and self.annotation is None:
            raise ValueError("upsert annotation events require annotation")
        if self.operation == "delete" and self.annotation is not None:
            raise ValueError("delete annotation events cannot include annotation")
        return self


class AnnotationPongPayload(ApiModel):
    nonce: str


class AnnotationJoinedServerMessage(ApiModel):
    type: Literal["ANNOTATION_JOINED"]
    request_id: str | None = None
    payload: AnnotationJoinedPayload


class AnnotationSnapshotServerMessage(ApiModel):
    type: Literal["ANNOTATION_SNAPSHOT"]
    request_id: str | None = None
    payload: AnnotationSnapshotPayload


class AnnotationEventServerMessage(ApiModel):
    type: Literal["ANNOTATION_EVENT"]
    request_id: str | None = None
    payload: AnnotationEventPayload


class AnnotationPongServerMessage(ApiModel):
    type: Literal["ANNOTATION_PONG"]
    request_id: str | None = None
    payload: AnnotationPongPayload


class LogAnchor(ApiModel):
    measure_number: int | None = Field(default=None, ge=1)
    score_id: str | None = None
    page: int | None = Field(default=None, ge=1)
    x: float | None = Field(default=None, ge=0, le=1)
    y: float | None = Field(default=None, ge=0, le=1)
    note: str | None = None

    @model_validator(mode="after")
    def validate_anchor_shape(self) -> LogAnchor:
        coordinates = (self.page, self.x, self.y)
        has_any_coordinates = any(value is not None for value in coordinates)
        has_full_position = self.score_id is not None and all(value is not None for value in coordinates)
        if has_any_coordinates and not has_full_position:
            raise ValueError("scoreId, page, x, and y must be provided together")
        if self.measure_number is None and not has_full_position:
            raise ValueError("anchor requires a measureNumber or complete score position")
        return self


class PracticeLogCreate(ApiModel):
    content: NonEmpty
    anchors: list[LogAnchor] = Field(default_factory=list)


class PracticeLogUpdate(ApiModel):
    content: NonEmpty | None = None
    anchors: list[LogAnchor] | None = None


class PracticeLogOut(ApiModel):
    id: str
    repertoire_id: str
    author_id: str
    author_name: str
    content: str
    anchors: list[LogAnchor]
    created_at: datetime
    updated_at: datetime


class TodoCreate(ApiModel):
    content: NonEmpty
    practice_log_id: str | None = None
    assignee_id: str | None = None
    due_date: date | None = None


class TodoUpdate(ApiModel):
    content: NonEmpty | None = None
    assignee_id: str | None = None
    due_date: date | None = None
    done: bool | None = None


class TodoOut(ApiModel):
    id: str
    repertoire_id: str
    practice_log_id: str | None
    content: str
    assignee_id: str | None
    due_date: date | None
    done: bool
    created_by_id: str
    created_at: datetime
    updated_at: datetime


class DeviceCalibrationWrite(ApiModel):
    device_fingerprint: NonEmpty
    output_label: NonEmpty
    offset_ms: float = Field(ge=-1000, le=1000)


class DeviceCalibrationOut(ApiModel):
    id: str
    user_id: str
    device_fingerprint: str
    output_label: str
    offset_ms: float
    created_at: datetime
    updated_at: datetime


class RoomCreate(ApiModel):
    repertoire_id: str


class RoomOut(ApiModel):
    room_id: str
    join_code: str
    repertoire_id: str
    leader_id: str
    tempo_map_revision: int
    expires_at: datetime


class PracticeSessionOut(ApiModel):
    id: str
    room_id: str
    repertoire_id: str
    leader_id: str
    tempo_map_revision: int
    status: TransportStatus
    anchor_measure: int | None
    anchor_pass: int | None
    server_start_time_ns: int | None
    created_at: datetime
    updated_at: datetime
    ended_at: datetime | None


class MusicXmlDraftOut(ApiModel):
    title: str | None
    total_measures: int
    anacrusis: TempoMapAnacrusis | None = None
    sections: list[dict[str, Any]]
    jumps: list[dict[str, Any]]
    count_in: dict[str, Any]
    warnings: list[str]


# WebSocket protocol. Every frame is an envelope with a stable type and payload.
class JoinRoomPayload(ApiModel):
    room_id: str
    access_token: str
    calibration_id: str | None = None
    bluetooth: bool = False


class PingPayload(ApiModel):
    t0: int


class StartPayload(ApiModel):
    measure: int = Field(ge=1)
    pass_number: int = Field(default=1, alias="pass", ge=1)
    count_in: bool = True


class SeekPayload(ApiModel):
    measure: int = Field(ge=1)
    pass_number: int = Field(default=1, alias="pass", ge=1)


class ReportRttPayload(ApiModel):
    rtt_ms: float = Field(ge=0, le=120_000)


class ReadyPayload(ApiModel):
    ready: bool


class JoinRoomMessage(ApiModel):
    type: Literal["JOIN_ROOM"]
    request_id: str | None = None
    payload: JoinRoomPayload


class PingMessage(ApiModel):
    type: Literal["PING"]
    request_id: str | None = None
    payload: PingPayload


class StartMessage(ApiModel):
    type: Literal["CMD_START"]
    request_id: str | None = None
    payload: StartPayload


class EmptyPayload(ApiModel):
    pass


class StopMessage(ApiModel):
    type: Literal["CMD_STOP"]
    request_id: str | None = None
    payload: EmptyPayload = Field(default_factory=EmptyPayload)


class SeekMessage(ApiModel):
    type: Literal["CMD_SEEK"]
    request_id: str | None = None
    payload: SeekPayload


class ReportRttMessage(ApiModel):
    type: Literal["REPORT_RTT"]
    request_id: str | None = None
    payload: ReportRttPayload


class ReadyMessage(ApiModel):
    type: Literal["READY"]
    request_id: str | None = None
    payload: ReadyPayload


WsClientMessage = Annotated[
    JoinRoomMessage
    | PingMessage
    | StartMessage
    | StopMessage
    | SeekMessage
    | ReportRttMessage
    | ReadyMessage,
    Field(discriminator="type"),
]


class Anchor(ApiModel):
    measure: int
    pass_number: int = Field(alias="pass")


class LateJoinMetadata(ApiModel):
    server_now_ns: int
    elapsed_ns: int
    strategy: Literal["next-measure-boundary"]


class TransportPayload(ApiModel):
    room_id: str
    repertoire_id: str
    tempo_map_revision: int
    status: TransportStatus
    anchor: Anchor | None = None
    server_start_time_ns: int | None = None
    count_in: bool = True
    late_join: LateJoinMetadata | None = None


class RosterMember(ApiModel):
    user_id: str
    display_name: str
    role: Role
    ready: bool
    rtt_ms: float | None = None
    calibrated: bool
    bluetooth: bool


class PongPayload(ApiModel):
    t0: int
    server_receive_time_ns: int


class JoinedPayload(ApiModel):
    user_id: str
    role: Role


class RevisionPayload(ApiModel):
    repertoire_id: str
    revision: int


class ErrorPayload(ApiModel):
    code: str
    message: str


class RosterPayload(ApiModel):
    members: list[RosterMember]


class JoinedServerMessage(ApiModel):
    type: Literal["JOINED"]
    request_id: str | None = None
    payload: JoinedPayload


class PongServerMessage(ApiModel):
    type: Literal["PONG"]
    request_id: str | None = None
    payload: PongPayload


class TransportServerMessage(ApiModel):
    type: Literal["TRANSPORT"]
    request_id: str | None = None
    payload: TransportPayload


class RosterServerMessage(ApiModel):
    type: Literal["ROOM_ROSTER"]
    request_id: str | None = None
    payload: RosterPayload


class RevisionServerMessage(ApiModel):
    type: Literal["TEMPOMAP_UPDATED"]
    request_id: str | None = None
    payload: RevisionPayload


class ErrorServerMessage(ApiModel):
    type: Literal["ERROR"]
    request_id: str | None = None
    payload: ErrorPayload


WsServerMessage = Annotated[
    JoinedServerMessage
    | PongServerMessage
    | TransportServerMessage
    | RosterServerMessage
    | RevisionServerMessage
    | ErrorServerMessage,
    Field(discriminator="type"),
]


AnnotationWsServerMessage = Annotated[
    AnnotationJoinedServerMessage
    | AnnotationSnapshotServerMessage
    | AnnotationEventServerMessage
    | AnnotationPongServerMessage
    | ErrorServerMessage,
    Field(discriminator="type"),
]


class ServerEnvelope(ApiModel):
    type: ServerMessageType
    request_id: str | None = None
    payload: dict[str, Any]
