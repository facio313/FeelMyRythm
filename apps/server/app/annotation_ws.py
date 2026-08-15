from __future__ import annotations

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError

from .access import require_repertoire
from .annotation_sync import AnnotationAccessError, AnnotationSubscriber
from .schemas import (
    AnnotationPingMessage,
    AnnotationWsClientMessage,
    JoinAnnotationsMessage,
)
from .security import authenticate_access_token

router = APIRouter(tags=["annotations"])
client_message_adapter: TypeAdapter[AnnotationWsClientMessage] = TypeAdapter(AnnotationWsClientMessage)


async def _error(
    websocket: WebSocket,
    message: str,
    code: str = "INVALID_MESSAGE",
    request_id: str | None = None,
) -> None:
    await websocket.app.state.annotation_sync.send(
        websocket,
        "ERROR",
        {"code": code, "message": message},
        request_id,
    )


@router.websocket("/ws/repertoires/{repertoire_id}/annotations")
async def annotation_socket(websocket: WebSocket, repertoire_id: str) -> None:
    await websocket.accept()
    subscriber: AnnotationSubscriber | None = None
    try:
        try:
            raw = await websocket.receive_json()
            first = client_message_adapter.validate_python(raw)
        except (ValidationError, ValueError):
            await _error(websocket, "first frame must be a valid JOIN_ANNOTATIONS envelope")
            await websocket.close(code=4400)
            return
        if not isinstance(first, JoinAnnotationsMessage) or first.payload.repertoire_id != repertoire_id:
            await _error(websocket, "first frame must JOIN annotations for the URL repertoire")
            await websocket.close(code=4400)
            return

        try:
            with websocket.app.state.database.session_factory() as db:
                user = authenticate_access_token(
                    db,
                    websocket.app.state.settings,
                    first.payload.access_token,
                )
                require_repertoire(db, user, repertoire_id)
                user_id = user.id
            subscriber = await websocket.app.state.annotation_sync.join(
                repertoire_id,
                user_id,
                websocket,
                first.request_id,
            )
        except (HTTPException, AnnotationAccessError):
            await _error(
                websocket,
                "authentication or repertoire membership failed",
                "UNAUTHORIZED",
                first.request_id,
            )
            await websocket.close(code=4401)
            return

        while True:
            raw = await websocket.receive_json()
            try:
                message = client_message_adapter.validate_python(raw)
            except ValidationError as exc:
                await _error(websocket, f"invalid envelope: {exc.errors()[0]['msg']}")
                continue
            if isinstance(message, JoinAnnotationsMessage):
                await _error(
                    websocket,
                    "JOIN_ANNOTATIONS is only valid as the first frame",
                    request_id=message.request_id,
                )
                continue
            if isinstance(message, AnnotationPingMessage):
                if not await websocket.app.state.annotation_sync.ensure_access(subscriber):
                    break
                await websocket.app.state.annotation_sync.send(
                    websocket,
                    "ANNOTATION_PONG",
                    {"nonce": message.payload.nonce},
                    message.request_id,
                )
    except WebSocketDisconnect:
        pass
    finally:
        if subscriber is not None:
            await websocket.app.state.annotation_sync.leave(subscriber)
