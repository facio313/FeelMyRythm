from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse
from sqlalchemy import Select, or_, select
from sqlalchemy.exc import IntegrityError

from ..access import can_edit_annotation, require_repertoire, require_score
from ..config import Settings
from ..dependencies import CurrentUser, DbSession
from ..models import Annotation, MeasureMap, Score, new_id, utcnow
from ..schemas import (
    AnnotationCreate,
    AnnotationOut,
    AnnotationUpdate,
    DownloadUrlOut,
    MeasureMapOut,
    MeasureMapWrite,
    ScoreCompleteIn,
    ScoreOut,
    ScorePresignIn,
    ScoreSettingsOut,
    ScoreSettingsWrite,
    ScoreUpdate,
    UploadTargetOut,
)
from ..security import verify_upload_token
from ..serializers import annotation_out, measure_map_out, score_out
from ..storage import (
    LocalObjectStorage,
    ObjectStoragePromotionError,
    content_type_for,
    safe_filename,
)
from ..storage_lifecycle import enqueue_promoted_staging_deletion
from .storage_cleanup import enqueue_score_cleanup

router = APIRouter(prefix="/api", tags=["scores"])


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _upload_deadline(score: Score, settings: Settings) -> datetime:
    if score.upload_expires_at is not None:
        return _as_utc(score.upload_expires_at)
    return _as_utc(score.created_at) + timedelta(seconds=settings.legacy_pending_upload_ttl_seconds)


def _pending_upload_query(storage_key: str) -> Select[tuple[Score]]:
    return select(Score).where(
        Score.upload_status == "pending",
        or_(
            Score.staging_key == storage_key,
            (Score.staging_key.is_(None) & (Score.storage_key == storage_key)),
        ),
    )


def _lock_score_for_measure_map(db: DbSession, user: CurrentUser, score_id: str) -> Score:
    require_score(db, user, score_id, "leader")
    score = db.scalar(select(Score).where(Score.id == score_id).with_for_update())
    if score is None:
        raise HTTPException(status_code=404, detail="score not found")
    return score


def _commit_measure_map_write(
    db: DbSession,
    score_id: str,
    expected_revision: int,
    *,
    created: bool,
) -> None:
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if not created:
            raise
        actual = db.scalar(select(MeasureMap.revision).where(MeasureMap.score_id == score_id)) or 0
        raise HTTPException(
            status_code=409,
            detail={
                "message": "measure map was concurrently updated",
                "expectedRevision": expected_revision,
                "actualRevision": actual,
            },
        ) from exc


def _allowed_score_content_type(content_type: str, filename: str) -> bool:
    extension = Path(filename).suffix.casefold()
    return (
        content_type == "application/pdf"
        or content_type.startswith("image/")
        or content_type
        in {
            "application/xml",
            "text/xml",
            "application/zip",
            "application/vnd.recordare.musicxml+xml",
            "application/vnd.recordare.musicxml",
        }
        or extension in {".musicxml", ".xml", ".mxl"}
    )


@router.post(
    "/repertoire/{repertoire_id}/scores/presign",
    response_model=UploadTargetOut,
    status_code=status.HTTP_201_CREATED,
)
def presign_score(
    repertoire_id: str,
    body: ScorePresignIn,
    request: Request,
    db: DbSession,
    user: CurrentUser,
) -> UploadTargetOut:
    require_repertoire(db, user, repertoire_id, "leader")
    if body.size_bytes > request.app.state.settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="score exceeds configured upload limit")
    filename = safe_filename(body.filename)
    content_type = content_type_for(filename, body.content_type)
    if not _allowed_score_content_type(content_type, filename):
        raise HTTPException(status_code=415, detail="unsupported score content type")
    score_id = new_id()
    storage_key = f"scores/{repertoire_id}/{score_id}/{filename}"
    staging_key = f"staging/scores/{score_id}/{uuid.uuid4()}/{filename}"
    target = request.app.state.storage.create_upload_target(staging_key, content_type, body.size_bytes)
    score = Score(
        id=score_id,
        repertoire_id=repertoire_id,
        kind=body.kind,
        instrument=body.instrument,
        filename=filename,
        content_type=content_type,
        storage_key=storage_key,
        staging_key=staging_key,
        upload_expires_at=target.expires_at,
        size_bytes=body.size_bytes,
        created_by_id=user.id,
    )
    db.add(score)
    db.commit()
    db.refresh(score)
    return UploadTargetOut(
        score_id=score.id,
        storage_key=staging_key,
        upload_url=target.url,
        method=target.method,
        headers=target.headers,
        fields=target.fields,
        expires_at=target.expires_at,
    )


@router.put("/uploads/local/{storage_key:path}", status_code=status.HTTP_204_NO_CONTENT)
async def local_upload(
    storage_key: str,
    request: Request,
    db: DbSession,
    token: str = Query(...),
) -> Response:
    settings = request.app.state.settings
    verify_upload_token(settings, token, storage_key)
    storage = request.app.state.storage
    if not isinstance(storage, LocalObjectStorage):
        raise HTTPException(status_code=404, detail="local storage is disabled")
    score = db.scalar(_pending_upload_query(storage_key))
    if score is None or score.size_bytes is None or _as_utc(utcnow()) > _upload_deadline(score, settings):
        db.rollback()
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="upload target is no longer active")
    expected_size = score.size_bytes
    db.rollback()
    temporary = storage.create_temporary_upload_path()
    size = 0
    try:
        with temporary.open("wb") as output:
            async for chunk in request.stream():
                size += len(chunk)
                if size > expected_size:
                    raise HTTPException(status_code=409, detail="upload size differs from presigned size")
                output.write(chunk)
        if size != expected_size:
            raise HTTPException(status_code=409, detail="upload size differs from presigned size")
        score = db.scalar(
            _pending_upload_query(storage_key).with_for_update().execution_options(populate_existing=True)
        )
        if (
            score is None
            or score.size_bytes != expected_size
            or _as_utc(utcnow()) > _upload_deadline(score, settings)
        ):
            db.rollback()
            raise HTTPException(
                status_code=status.HTTP_410_GONE,
                detail="upload target is no longer active",
            )
        storage.publish_temporary_upload(temporary, storage_key)
        db.commit()
    finally:
        temporary.unlink(missing_ok=True)
    return Response(status_code=204)


@router.get("/uploads/local/{storage_key:path}")
def local_download(storage_key: str, request: Request, token: str = Query(...)) -> FileResponse:
    settings = request.app.state.settings
    verify_upload_token(settings, token, storage_key)
    storage = request.app.state.storage
    if not isinstance(storage, LocalObjectStorage):
        raise HTTPException(status_code=404, detail="local storage is disabled")
    path = storage.resolve_key(storage_key)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="object not found")
    return FileResponse(path)


@router.post("/scores/{score_id}/complete", response_model=ScoreOut)
def complete_score(
    score_id: str,
    body: ScoreCompleteIn,
    request: Request,
    db: DbSession,
    user: CurrentUser,
) -> ScoreOut:
    require_score(db, user, score_id, "leader")
    score = db.scalar(select(Score).where(Score.id == score_id).with_for_update())
    if score is None:
        raise HTTPException(status_code=404, detail="score not found")
    if score.size_bytes != body.size_bytes:
        raise HTTPException(status_code=409, detail="uploaded size differs from presigned size")
    if score.upload_status == "ready":
        return score_out(score)
    settings = request.app.state.settings
    if _as_utc(utcnow()) > _upload_deadline(score, settings) + timedelta(
        seconds=settings.pending_upload_grace_seconds
    ):
        raise HTTPException(status_code=409, detail="score upload target has expired")
    staging_key = score.staging_key or score.storage_key
    try:
        request.app.state.storage.promote(staging_key, score.storage_key, body.size_bytes)
    except ObjectStoragePromotionError as exc:
        raise HTTPException(
            status_code=409,
            detail="uploaded object is missing or has the wrong size",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="object storage is temporarily unavailable",
        ) from exc
    score.upload_status = "ready"
    enqueue_promoted_staging_deletion(db, score, settings)
    db.commit()
    db.refresh(score)
    return score_out(score)


@router.get("/repertoire/{repertoire_id}/scores", response_model=list[ScoreOut])
def list_scores(repertoire_id: str, db: DbSession, user: CurrentUser) -> list[ScoreOut]:
    require_repertoire(db, user, repertoire_id)
    rows = db.scalars(
        select(Score)
        .where(Score.repertoire_id == repertoire_id, Score.upload_status == "ready")
        .order_by(Score.filename)
    ).all()
    return [score_out(row) for row in rows]


@router.get("/scores/{score_id}", response_model=ScoreOut)
def get_score(score_id: str, db: DbSession, user: CurrentUser) -> ScoreOut:
    score, _ = require_score(db, user, score_id)
    if score.upload_status != "ready":
        raise HTTPException(status_code=404, detail="score not found")
    return score_out(score)


@router.patch("/scores/{score_id}", response_model=ScoreOut)
def update_score(score_id: str, body: ScoreUpdate, db: DbSession, user: CurrentUser) -> ScoreOut:
    score, _ = require_score(db, user, score_id, "leader")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(score, field, value)
    db.commit()
    db.refresh(score)
    return score_out(score)


@router.put("/scores/{score_id}/settings", response_model=ScoreSettingsOut)
def update_score_settings(
    score_id: str, body: ScoreSettingsWrite, db: DbSession, user: CurrentUser
) -> ScoreSettingsOut:
    score = _lock_score_for_measure_map(db, user, score_id)
    row = db.scalar(select(MeasureMap).where(MeasureMap.score_id == score_id).with_for_update())
    actual = row.revision if row else 0
    if body.expected_measure_map_revision != actual:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "measure map revision conflict",
                "expectedRevision": body.expected_measure_map_revision,
                "actualRevision": actual,
            },
        )

    score.kind = body.kind
    score.instrument = body.instrument
    regions = [region.model_dump(by_alias=True) for region in body.regions]
    if row is None:
        created = True
        row = MeasureMap(
            score_id=score_id,
            revision=1,
            regions=regions,
            measure_number_offset=body.measure_number_offset,
            updated_by_id=user.id,
        )
        db.add(row)
    else:
        created = False
        row.revision += 1
        row.regions = regions
        row.measure_number_offset = body.measure_number_offset
        row.updated_by_id = user.id

    _commit_measure_map_write(
        db,
        score_id,
        body.expected_measure_map_revision,
        created=created,
    )
    db.refresh(score)
    db.refresh(row)
    return ScoreSettingsOut(score=score_out(score), measure_map=measure_map_out(row))


@router.get("/scores/{score_id}/download", response_model=DownloadUrlOut)
def score_download(score_id: str, request: Request, db: DbSession, user: CurrentUser) -> DownloadUrlOut:
    score, _ = require_score(db, user, score_id)
    if score.upload_status != "ready":
        raise HTTPException(status_code=409, detail="score upload is not complete")
    url, expires_at = request.app.state.storage.create_download_url(score.storage_key)
    return DownloadUrlOut(url=url, expires_at=expires_at)


@router.delete("/scores/{score_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_score(score_id: str, request: Request, db: DbSession, user: CurrentUser) -> Response:
    require_score(db, user, score_id, "leader")
    score = db.scalar(select(Score).where(Score.id == score_id).with_for_update())
    assert score is not None
    enqueue_score_cleanup(
        db,
        [score],
        request.app.state.settings,
        reason="score",
    )
    db.delete(score)
    db.commit()
    return Response(status_code=204)


@router.get("/scores/{score_id}/measure-map", response_model=MeasureMapOut)
def get_measure_map(score_id: str, db: DbSession, user: CurrentUser) -> MeasureMapOut:
    require_score(db, user, score_id)
    row = db.scalar(select(MeasureMap).where(MeasureMap.score_id == score_id))
    if row is None:
        raise HTTPException(status_code=404, detail="measure map not found")
    return measure_map_out(row)


@router.put("/scores/{score_id}/measure-map", response_model=MeasureMapOut)
def put_measure_map(score_id: str, body: MeasureMapWrite, db: DbSession, user: CurrentUser) -> MeasureMapOut:
    _lock_score_for_measure_map(db, user, score_id)
    row = db.scalar(select(MeasureMap).where(MeasureMap.score_id == score_id).with_for_update())
    actual = row.revision if row else 0
    if body.expected_revision != actual:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "measure map revision conflict",
                "expectedRevision": body.expected_revision,
                "actualRevision": actual,
            },
        )
    regions = [region.model_dump(by_alias=True) for region in body.regions]
    if row is None:
        created = True
        row = MeasureMap(
            score_id=score_id,
            revision=1,
            regions=regions,
            measure_number_offset=body.measure_number_offset,
            updated_by_id=user.id,
        )
        db.add(row)
    else:
        created = False
        row.revision += 1
        row.regions = regions
        row.measure_number_offset = body.measure_number_offset
        row.updated_by_id = user.id
    _commit_measure_map_write(db, score_id, body.expected_revision, created=created)
    db.refresh(row)
    return measure_map_out(row)


@router.delete("/scores/{score_id}/measure-map", status_code=status.HTTP_204_NO_CONTENT)
def delete_measure_map(score_id: str, db: DbSession, user: CurrentUser) -> Response:
    require_score(db, user, score_id, "leader")
    row = db.scalar(select(MeasureMap).where(MeasureMap.score_id == score_id))
    if row is None:
        raise HTTPException(status_code=404, detail="measure map not found")
    db.delete(row)
    db.commit()
    return Response(status_code=204)


@router.post(
    "/scores/{score_id}/annotations",
    response_model=AnnotationOut,
    status_code=status.HTTP_201_CREATED,
)
def create_annotation(
    score_id: str, body: AnnotationCreate, db: DbSession, user: CurrentUser
) -> AnnotationOut:
    require_score(db, user, score_id)
    row = Annotation(
        score_id=score_id,
        author_id=user.id,
        scope=body.scope,
        data=body.data.model_dump(by_alias=True, exclude_none=True),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return annotation_out(row)


@router.get("/scores/{score_id}/annotations", response_model=list[AnnotationOut])
def list_annotations(score_id: str, db: DbSession, user: CurrentUser) -> list[AnnotationOut]:
    require_score(db, user, score_id)
    rows = db.scalars(
        select(Annotation)
        .where(
            Annotation.score_id == score_id,
            or_(Annotation.scope == "project", Annotation.author_id == user.id),
        )
        .order_by(Annotation.created_at)
    ).all()
    return [annotation_out(row) for row in rows]


@router.get("/repertoire/{repertoire_id}/annotations", response_model=list[AnnotationOut])
def list_repertoire_annotations(repertoire_id: str, db: DbSession, user: CurrentUser) -> list[AnnotationOut]:
    require_repertoire(db, user, repertoire_id)
    rows = db.scalars(
        select(Annotation)
        .join(Score, Score.id == Annotation.score_id)
        .where(
            Score.repertoire_id == repertoire_id,
            or_(Annotation.scope == "project", Annotation.author_id == user.id),
        )
        .order_by(Annotation.created_at, Annotation.id)
    ).all()
    return [annotation_out(row) for row in rows]


@router.get("/annotations/{annotation_id}", response_model=AnnotationOut)
def get_annotation(annotation_id: str, db: DbSession, user: CurrentUser) -> AnnotationOut:
    row = db.get(Annotation, annotation_id)
    if row is None:
        raise HTTPException(status_code=404, detail="annotation not found")
    require_score(db, user, row.score_id)
    if row.scope == "private" and row.author_id != user.id:
        raise HTTPException(status_code=404, detail="annotation not found")
    return annotation_out(row)


@router.put("/annotations/{annotation_id}", response_model=AnnotationOut)
def update_annotation(
    annotation_id: str, body: AnnotationUpdate, db: DbSession, user: CurrentUser
) -> AnnotationOut:
    row = db.get(Annotation, annotation_id)
    if row is None:
        raise HTTPException(status_code=404, detail="annotation not found")
    _, membership = require_score(db, user, row.score_id)
    if not can_edit_annotation(row, user, membership):
        raise HTTPException(status_code=403, detail="annotation author or leader role required")
    if body.expected_revision != row.revision:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "annotation revision conflict",
                "expectedRevision": body.expected_revision,
                "actualRevision": row.revision,
            },
        )
    row.revision += 1
    row.data = body.data.model_dump(by_alias=True, exclude_none=True)
    db.commit()
    db.refresh(row)
    return annotation_out(row)


@router.delete("/annotations/{annotation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_annotation(annotation_id: str, db: DbSession, user: CurrentUser) -> Response:
    row = db.get(Annotation, annotation_id)
    if row is None:
        raise HTTPException(status_code=404, detail="annotation not found")
    _, membership = require_score(db, user, row.score_id)
    if not can_edit_annotation(row, user, membership):
        raise HTTPException(status_code=403, detail="annotation author or leader role required")
    db.delete(row)
    db.commit()
    return Response(status_code=204)
