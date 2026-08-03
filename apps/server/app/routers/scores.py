from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..access import require_repertoire, require_score
from ..auth import get_current_user
from ..config import settings
from ..db import get_db
from ..models import Annotation, Score, User
from ..schemas import AnnotationOut, AnnotationPutIn, MeasureMapOut, MeasureMapPutIn, ScoreOut

router = APIRouter(prefix="/api", tags=["scores"])

# 로컬 디스크 저장. 운영 전환 시 이 두 함수만 S3 presigned 업로드로 교체한다 (설계문서 §2.1).


def _uploads_dir() -> Path:
    p = Path(settings.uploads_dir)
    p.mkdir(parents=True, exist_ok=True)
    return p


def _to_out(s: Score) -> ScoreOut:
    return ScoreOut(
        id=s.id,
        repertoire_id=s.repertoire_id,
        kind=s.kind,  # type: ignore[arg-type]
        instrument=s.instrument,
        filename=s.filename,
        content_type=s.content_type,
        measure_number_offset=s.measure_number_offset,
        has_measure_map=s.measure_map is not None,
    )


@router.post("/repertoire/{repertoire_id}/scores", response_model=ScoreOut)
async def upload_score(
    repertoire_id: str,
    file: UploadFile = File(...),
    kind: str = Form("full"),
    instrument: str = Form(""),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ScoreOut:
    require_repertoire(db, user, repertoire_id)
    if kind not in ("full", "part"):
        raise HTTPException(422, "kind는 full 또는 part여야 합니다")
    stored = uuid4().hex + Path(file.filename or "score").suffix
    dest = _uploads_dir() / stored
    dest.write_bytes(await file.read())
    score = Score(
        repertoire_id=repertoire_id,
        kind=kind,
        instrument=instrument,
        filename=file.filename or "score",
        stored_name=stored,
        content_type=file.content_type or "application/octet-stream",
    )
    db.add(score)
    db.commit()
    return _to_out(score)


@router.get("/repertoire/{repertoire_id}/scores", response_model=list[ScoreOut])
def list_scores(
    repertoire_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[ScoreOut]:
    require_repertoire(db, user, repertoire_id)
    rows = db.execute(select(Score).where(Score.repertoire_id == repertoire_id)).scalars().all()
    return [_to_out(s) for s in rows]


@router.get("/scores/{score_id}/file")
def score_file(
    score_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> FileResponse:
    score = require_score(db, user, score_id)
    path = _uploads_dir() / score.stored_name
    if not path.exists():
        raise HTTPException(404, "파일이 없습니다")
    return FileResponse(path, media_type=score.content_type, filename=score.filename)


@router.get("/scores/{score_id}/measure-map", response_model=MeasureMapOut)
def get_measure_map(
    score_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> MeasureMapOut:
    score = require_score(db, user, score_id)
    if score.measure_map is None:
        raise HTTPException(404, "마디 매핑이 아직 없습니다")
    return MeasureMapOut(
        regions=score.measure_map.get("regions", []),
        measure_number_offset=score.measure_number_offset,
    )


@router.put("/scores/{score_id}/measure-map", response_model=MeasureMapOut)
def put_measure_map(
    score_id: str,
    body: MeasureMapPutIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MeasureMapOut:
    score = require_score(db, user, score_id)
    score.measure_map = {"regions": [r.model_dump(by_alias=True) for r in body.regions]}
    score.measure_number_offset = body.measure_number_offset
    db.commit()
    return MeasureMapOut(regions=body.regions, measure_number_offset=body.measure_number_offset)


# ---------- 필기 (기능 4·5) ----------


@router.get("/scores/{score_id}/annotations", response_model=list[AnnotationOut])
def get_annotations(
    score_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[AnnotationOut]:
    require_score(db, user, score_id)
    rows = db.execute(select(Annotation).where(Annotation.score_id == score_id)).scalars().all()
    # 내 필기(전체) + 다른 사람의 project 공유 필기
    visible = [a for a in rows if a.user_id == user.id or a.scope == "project"]
    return [AnnotationOut(scope=a.scope, data=a.data) for a in visible]


@router.put("/scores/{score_id}/annotations", response_model=AnnotationOut)
def put_annotation(
    score_id: str,
    body: AnnotationPutIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AnnotationOut:
    require_score(db, user, score_id)
    row = db.execute(
        select(Annotation).where(
            Annotation.score_id == score_id, Annotation.user_id == user.id, Annotation.scope == body.scope
        )
    ).scalar_one_or_none()
    if row is None:
        row = Annotation(score_id=score_id, user_id=user.id, scope=body.scope, data=body.data)
        db.add(row)
    else:
        row.data = body.data
    db.commit()
    return AnnotationOut(scope=row.scope, data=row.data)
