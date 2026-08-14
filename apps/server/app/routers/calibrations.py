from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import select

from ..dependencies import CurrentUser, DbSession
from ..models import DeviceCalibration
from ..schemas import DeviceCalibrationOut, DeviceCalibrationWrite
from ..serializers import calibration_out

router = APIRouter(prefix="/api/calibrations", tags=["device calibrations"])


@router.get("", response_model=list[DeviceCalibrationOut])
def list_calibrations(db: DbSession, user: CurrentUser) -> list[DeviceCalibrationOut]:
    rows = db.scalars(
        select(DeviceCalibration)
        .where(DeviceCalibration.user_id == user.id)
        .order_by(DeviceCalibration.output_label)
    ).all()
    return [calibration_out(row) for row in rows]


@router.put("", response_model=DeviceCalibrationOut)
def upsert_calibration(
    body: DeviceCalibrationWrite, db: DbSession, user: CurrentUser
) -> DeviceCalibrationOut:
    row = db.scalar(
        select(DeviceCalibration).where(
            DeviceCalibration.user_id == user.id,
            DeviceCalibration.device_fingerprint == body.device_fingerprint,
            DeviceCalibration.output_label == body.output_label,
        )
    )
    if row is None:
        row = DeviceCalibration(user_id=user.id, **body.model_dump())
        db.add(row)
    else:
        row.offset_ms = body.offset_ms
    db.commit()
    db.refresh(row)
    return calibration_out(row)


@router.get("/{calibration_id}", response_model=DeviceCalibrationOut)
def get_calibration(calibration_id: str, db: DbSession, user: CurrentUser) -> DeviceCalibrationOut:
    row = db.get(DeviceCalibration, calibration_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="calibration not found")
    return calibration_out(row)


@router.delete("/{calibration_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_calibration(calibration_id: str, db: DbSession, user: CurrentUser) -> Response:
    row = db.get(DeviceCalibration, calibration_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="calibration not found")
    db.delete(row)
    db.commit()
    return Response(status_code=204)
