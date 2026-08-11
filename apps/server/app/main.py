from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from . import ws
from .config import settings
from .db import Base, engine
from .routers import auth_routes, groups, repertoire, rooms_routes, scores


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 개발 편의용 스키마 생성. 운영 전환 시 Alembic 마이그레이션으로 교체 (구현 로드맵 Phase 3)
    Base.metadata.create_all(engine)
    yield


app = FastAPI(title="FeelMyRythm API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_routes.router)
app.include_router(groups.router)
app.include_router(repertoire.router)
app.include_router(scores.router)
app.include_router(rooms_routes.router)
app.include_router(ws.router)


@app.get("/api/health")
def health() -> dict:
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))
    return {"ok": True}
