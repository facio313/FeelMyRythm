from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from dataclasses import dataclass
from typing import Literal

from fastapi import WebSocket
from sqlalchemy import or_, select

from .db import Database
from .models import Annotation, GroupMember, Project, RepertoireItem, Score, User
from .schemas import AnnotationEventPayload, AnnotationOut, ServerEnvelope
from .serializers import annotation_out

logger = logging.getLogger(__name__)

AnnotationOperation = Literal["upsert", "delete"]
SEND_TIMEOUT_SECONDS = 5.0


class AnnotationAccessError(PermissionError):
    pass


@dataclass(frozen=True)
class AnnotationSubscriber:
    connection_id: str
    repertoire_id: str
    user_id: str
    websocket: WebSocket


class AnnotationSyncHub:
    """Fans committed annotation changes out and restores full state on every join.

    REST remains the only mutation authority. The socket is a notification channel, so a
    reconnect can always recover from a dropped or duplicated event with a fresh DB snapshot.
    """

    def __init__(self, database: Database) -> None:
        self.database = database
        self._loop: asyncio.AbstractEventLoop | None = None
        self._subscribers: dict[str, dict[str, AnnotationSubscriber]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._tasks: set[asyncio.Task[None]] = set()
        self._stopping = False

    def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._stopping = False

    async def stop(self) -> None:
        self._stopping = True
        subscribers = [
            subscriber
            for repertoire_subscribers in self._subscribers.values()
            for subscriber in repertoire_subscribers.values()
        ]
        self._subscribers.clear()
        for subscriber in subscribers:
            with contextlib.suppress(Exception):
                await subscriber.websocket.close(code=1001, reason="server shutdown")
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()
        self._loop = None

    async def join(
        self,
        repertoire_id: str,
        user_id: str,
        websocket: WebSocket,
        request_id: str | None,
    ) -> AnnotationSubscriber:
        subscriber = AnnotationSubscriber(
            connection_id=str(uuid.uuid4()),
            repertoire_id=repertoire_id,
            user_id=user_id,
            websocket=websocket,
        )
        lock = self._lock_for(repertoire_id)
        async with lock:
            if not self._has_access(repertoire_id, user_id):
                raise AnnotationAccessError("repertoire membership required")
            annotations = self._visible_annotations(repertoire_id, user_id)
            repertoire_subscribers = self._subscribers.setdefault(repertoire_id, {})
            repertoire_subscribers[subscriber.connection_id] = subscriber
            try:
                await self.send(
                    websocket,
                    "ANNOTATION_JOINED",
                    {"repertoireId": repertoire_id, "userId": user_id},
                    request_id,
                )
                await self.send(
                    websocket,
                    "ANNOTATION_SNAPSHOT",
                    {
                        "repertoireId": repertoire_id,
                        "annotations": [item.model_dump(by_alias=True, mode="json") for item in annotations],
                    },
                )
            except Exception:
                repertoire_subscribers.pop(subscriber.connection_id, None)
                if not repertoire_subscribers:
                    self._subscribers.pop(repertoire_id, None)
                raise
        return subscriber

    async def leave(self, subscriber: AnnotationSubscriber) -> None:
        lock = self._lock_for(subscriber.repertoire_id)
        async with lock:
            repertoire_subscribers = self._subscribers.get(subscriber.repertoire_id)
            if repertoire_subscribers is None:
                return
            repertoire_subscribers.pop(subscriber.connection_id, None)
            if not repertoire_subscribers:
                self._subscribers.pop(subscriber.repertoire_id, None)

    def publish(
        self,
        repertoire_id: str,
        operation: AnnotationOperation,
        annotation: AnnotationOut,
    ) -> None:
        """Schedule a post-commit event from either a sync FastAPI worker or the event loop."""

        loop = self._loop
        if loop is None or self._stopping:
            return

        def spawn() -> None:
            if self._stopping:
                return
            task = asyncio.create_task(self._broadcast(repertoire_id, operation, annotation))
            self._tasks.add(task)
            task.add_done_callback(self._task_done)

        loop.call_soon_threadsafe(spawn)

    async def ensure_access(self, subscriber: AnnotationSubscriber) -> bool:
        if self._has_access(subscriber.repertoire_id, subscriber.user_id):
            return True
        with contextlib.suppress(Exception):
            await subscriber.websocket.close(code=4401, reason="repertoire membership required")
        await self.leave(subscriber)
        return False

    @staticmethod
    async def send(
        websocket: WebSocket,
        message_type: str,
        payload: dict[str, object],
        request_id: str | None = None,
    ) -> None:
        envelope = ServerEnvelope(type=message_type, request_id=request_id, payload=payload)
        await asyncio.wait_for(
            websocket.send_json(envelope.model_dump(by_alias=True, mode="json")),
            timeout=SEND_TIMEOUT_SECONDS,
        )

    async def _broadcast(
        self,
        repertoire_id: str,
        operation: AnnotationOperation,
        annotation: AnnotationOut,
    ) -> None:
        lock = self._lock_for(repertoire_id)
        async with lock:
            subscribers = self._subscribers.get(repertoire_id)
            if not subscribers:
                return
            active_user_ids = self._active_user_ids(repertoire_id)
            event = AnnotationEventPayload(
                event_id=str(uuid.uuid4()),
                repertoire_id=repertoire_id,
                operation=operation,
                annotation_id=annotation.id,
                revision=annotation.revision,
                scope=annotation.scope,
                author_id=annotation.author_id,
                annotation=annotation if operation == "upsert" else None,
            ).model_dump(by_alias=True, mode="json")
            stale: list[str] = []
            for connection_id, subscriber in list(subscribers.items()):
                if subscriber.user_id not in active_user_ids:
                    stale.append(connection_id)
                    with contextlib.suppress(Exception):
                        await subscriber.websocket.close(
                            code=4401,
                            reason="repertoire membership required",
                        )
                    continue
                if annotation.scope == "private" and subscriber.user_id != annotation.author_id:
                    continue
                try:
                    await self.send(subscriber.websocket, "ANNOTATION_EVENT", event)
                except Exception:
                    stale.append(connection_id)
            for connection_id in stale:
                subscribers.pop(connection_id, None)
            if not subscribers:
                self._subscribers.pop(repertoire_id, None)

    def _visible_annotations(self, repertoire_id: str, user_id: str) -> list[AnnotationOut]:
        with self.database.session_factory() as db:
            rows = db.scalars(
                select(Annotation)
                .join(Score, Score.id == Annotation.score_id)
                .where(
                    Score.repertoire_id == repertoire_id,
                    or_(Annotation.scope == "project", Annotation.author_id == user_id),
                )
                .order_by(Annotation.created_at, Annotation.id)
            ).all()
            return [annotation_out(row) for row in rows]

    def _has_access(self, repertoire_id: str, user_id: str) -> bool:
        return user_id in self._active_user_ids(repertoire_id)

    def _active_user_ids(self, repertoire_id: str) -> set[str]:
        with self.database.session_factory() as db:
            return set(
                db.scalars(
                    select(GroupMember.user_id)
                    .select_from(GroupMember)
                    .join(Project, Project.group_id == GroupMember.group_id)
                    .join(RepertoireItem, RepertoireItem.project_id == Project.id)
                    .join(User, User.id == GroupMember.user_id)
                    .where(
                        RepertoireItem.id == repertoire_id,
                        User.is_active.is_(True),
                    )
                ).all()
            )

    def _lock_for(self, repertoire_id: str) -> asyncio.Lock:
        lock = self._locks.get(repertoire_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[repertoire_id] = lock
        return lock

    def _task_done(self, task: asyncio.Task[None]) -> None:
        self._tasks.discard(task)
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            logger.error(
                "annotation broadcast failed",
                exc_info=(type(error), error, error.__traceback__),
            )
