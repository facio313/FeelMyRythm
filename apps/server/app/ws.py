from __future__ import annotations

import time
from typing import cast

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError

from .access import require_repertoire
from .models import DeviceCalibration
from .rooms import Participant, RoomMembershipError, RoomMissingError, TransportPermissionError
from .schemas import (
    JoinRoomMessage,
    PingMessage,
    ReadyMessage,
    ReportRttMessage,
    Role,
    SeekMessage,
    StartMessage,
    StopMessage,
    WsClientMessage,
)
from .security import authenticate_access_token

router = APIRouter(tags=["synchronization"])
client_message_adapter: TypeAdapter[WsClientMessage] = TypeAdapter(WsClientMessage)


async def _error(
    websocket: WebSocket,
    message: str,
    code: str = "INVALID_MESSAGE",
    request_id: str | None = None,
) -> None:
    await websocket.app.state.rooms.send(
        websocket,
        "ERROR",
        {"code": code, "message": message},
        request_id,
    )


@router.websocket("/ws/rooms/{room_id}")
async def room_socket(websocket: WebSocket, room_id: str) -> None:
    await websocket.accept()
    participant: Participant | None = None
    room = None
    try:
        try:
            raw = await websocket.receive_json()
            first = client_message_adapter.validate_python(raw)
        except (ValidationError, ValueError):
            await _error(websocket, "first frame must be a valid JOIN_ROOM envelope")
            await websocket.close(code=4400)
            return
        if not isinstance(first, JoinRoomMessage) or first.payload.room_id != room_id:
            await _error(websocket, "first frame must JOIN the room in the URL")
            await websocket.close(code=4400)
            return

        try:
            room = websocket.app.state.rooms.get(room_id)
        except RoomMissingError:
            await _error(websocket, "room not found or expired", "ROOM_NOT_FOUND", first.request_id)
            await websocket.close(code=4404)
            return

        with websocket.app.state.database.session_factory() as db:
            try:
                user = authenticate_access_token(
                    db,
                    websocket.app.state.settings,
                    first.payload.access_token,
                )
                _, membership = require_repertoire(db, user, room.repertoire_id)
            except HTTPException:
                await _error(websocket, "authentication or room membership failed", "UNAUTHORIZED")
                await websocket.close(code=4401)
                return
            calibrated = False
            if first.payload.calibration_id:
                calibration = db.get(DeviceCalibration, first.payload.calibration_id)
                calibrated = calibration is not None and calibration.user_id == user.id
            participant = Participant(
                websocket=websocket,
                user_id=user.id,
                display_name=user.display_name,
                role=cast(Role, membership.role),
                calibrated=calibrated,
                bluetooth=first.payload.bluetooth,
            )
        await websocket.app.state.rooms.join(room, participant, first.request_id)

        while True:
            raw = await websocket.receive_json()
            server_receive_time_ns = time.time_ns()
            try:
                message = client_message_adapter.validate_python(raw)
            except ValidationError as exc:
                await _error(websocket, f"invalid envelope: {exc.errors()[0]['msg']}")
                continue
            if isinstance(message, JoinRoomMessage):
                await _error(
                    websocket, "JOIN_ROOM is only valid as the first frame", request_id=message.request_id
                )
            elif isinstance(message, PingMessage):
                await websocket.app.state.rooms.send(
                    websocket,
                    "PONG",
                    {
                        "t0": message.payload.t0,
                        "serverReceiveTimeNs": server_receive_time_ns,
                    },
                    message.request_id,
                )
            elif isinstance(message, ReportRttMessage):
                try:
                    websocket.app.state.rooms.refresh_participant_role(room, participant)
                except RoomMembershipError as exc:
                    await _error(websocket, str(exc), "UNAUTHORIZED", message.request_id)
                    await websocket.close(code=4401)
                    break
                participant.rtt_ms = message.payload.rtt_ms
                await websocket.app.state.rooms.broadcast_roster(room)
            elif isinstance(message, ReadyMessage):
                try:
                    websocket.app.state.rooms.refresh_participant_role(room, participant)
                except RoomMembershipError as exc:
                    await _error(websocket, str(exc), "UNAUTHORIZED", message.request_id)
                    await websocket.close(code=4401)
                    break
                participant.ready = message.payload.ready
                await websocket.app.state.rooms.broadcast_roster(room)
            else:
                try:
                    if isinstance(message, StartMessage):
                        await websocket.app.state.rooms.start_transport(
                            room,
                            participant,
                            message.payload.measure,
                            message.payload.pass_number,
                            message.payload.count_in,
                            message.request_id,
                        )
                    elif isinstance(message, StopMessage):
                        await websocket.app.state.rooms.stop_transport(room, participant, message.request_id)
                    elif isinstance(message, SeekMessage):
                        await websocket.app.state.rooms.seek_transport(
                            room,
                            participant,
                            message.payload.measure,
                            message.payload.pass_number,
                            message.request_id,
                        )
                except RoomMembershipError as exc:
                    await _error(websocket, str(exc), "UNAUTHORIZED", message.request_id)
                    await websocket.close(code=4401)
                    break
                except TransportPermissionError as exc:
                    await websocket.app.state.rooms.broadcast_roster(room)
                    await _error(websocket, str(exc), "FORBIDDEN", message.request_id)
                except ValueError as exc:
                    await _error(websocket, str(exc), "INVALID_ANCHOR", message.request_id)
    except WebSocketDisconnect:
        pass
    finally:
        if room is not None and participant is not None:
            await websocket.app.state.rooms.leave(room, participant.user_id, websocket)
