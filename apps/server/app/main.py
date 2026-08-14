from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from pydantic import TypeAdapter
from sqlalchemy import text

from . import ws
from .config import Settings, load_settings
from .db import Database
from .mailer import MailDeliveryManager, MailSender, make_mail_sender
from .rooms import RoomManager
from .routers import auth, calibrations, groups, repertoire, rooms, scores
from .schemas import ServerEnvelope, WsClientMessage, WsServerMessage
from .security import GoogleAuthVerifier, GoogleTokenVerifier, PasswordVerifier
from .storage import make_storage
from .storage_lifecycle import StorageLifecycleWorker


def _install_protocol_schemas(app: FastAPI) -> None:
    def custom_openapi() -> dict[str, Any]:
        if app.openapi_schema is not None:
            return app.openapi_schema
        schema = get_openapi(
            title=app.title,
            version=app.version,
            description=app.description,
            routes=app.routes,
        )
        components = schema.setdefault("components", {}).setdefault("schemas", {})
        for name, adapter in {
            "WsClientMessage": TypeAdapter(WsClientMessage),
            "WsServerMessage": TypeAdapter(WsServerMessage),
            "ServerEnvelope": TypeAdapter(ServerEnvelope),
        }.items():
            generated = adapter.json_schema(ref_template="#/components/schemas/{model}")
            definitions = generated.pop("$defs", {})
            components.update(definitions)
            components[name] = generated
        app.openapi_schema = schema
        return schema

    app.openapi = custom_openapi  # type: ignore[method-assign]


def create_app(
    settings: Settings | None = None,
    *,
    google_verifier: GoogleTokenVerifier | None = None,
    mail_sender: MailSender | None = None,
) -> FastAPI:
    resolved = settings or load_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        database = Database(resolved.database_url)
        if resolved.auto_create_schema:
            database.create_schema()
        sender = mail_sender or make_mail_sender(resolved)
        mail_delivery_manager = MailDeliveryManager(
            sender,
            worker_count=resolved.mail_worker_count,
            queue_capacity=resolved.mail_queue_capacity,
        )
        storage = make_storage(resolved)
        storage_lifecycle = StorageLifecycleWorker(database, storage, resolved)
        app.state.settings = resolved
        app.state.database = database
        app.state.storage = storage
        app.state.storage_lifecycle = storage_lifecycle
        app.state.google_verifier = google_verifier or GoogleAuthVerifier()
        app.state.password_verifier = PasswordVerifier(resolved.password_verify_concurrency)
        app.state.mail_sender = sender
        app.state.mail_delivery_manager = mail_delivery_manager
        app.state.rooms = RoomManager(database, resolved)
        rooms_started = False
        mail_delivery_manager.start()
        try:
            storage_lifecycle.start()
            app.state.rooms.start()
            rooms_started = True
            yield
        finally:
            if rooms_started:
                await app.state.rooms.stop()
            await storage_lifecycle.stop()
            await asyncio.to_thread(
                mail_delivery_manager.close,
                resolved.mail_shutdown_timeout_seconds,
            )
            database.dispose()

    application = FastAPI(
        title="FeelMyRythm API",
        version="0.1.0",
        description=(
            "REST API and WebSocket clock/transport gateway. Clients expand tempo-map beats locally; "
            "the server only agrees on revision, anchor, and absolute server time."
        ),
        lifespan=lifespan,
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=resolved.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )
    for router in (
        auth.router,
        auth.users_router,
        groups.router,
        repertoire.router,
        scores.router,
        calibrations.router,
        rooms.router,
        ws.router,
    ):
        application.include_router(router)

    @application.get("/api/health", tags=["system"])
    def health() -> dict[str, bool]:
        with application.state.database.session_factory() as db:
            db.execute(text("SELECT 1"))
        return {"ok": True}

    _install_protocol_schemas(application)
    return application


app = create_app()
