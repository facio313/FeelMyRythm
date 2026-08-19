FROM ghcr.io/astral-sh/uv:0.12.5@sha256:e85be844203885286c60ffad8a858d48afb6c5a5c237ca0e67f12e74b8f174b1 AS uv

FROM python:3.13.15-slim@sha256:ffb752e139c0a19692a43af8d8523b274222dd68eebad5d583b45c2201c6e30a AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH"
WORKDIR /app

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"]

COPY pyproject.toml uv.lock ./
COPY --from=uv /uv /uvx /bin/
RUN uv sync --frozen --no-dev

FROM base AS test
RUN uv sync --frozen --group dev
COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app
COPY scripts ./scripts
COPY tests ./tests
RUN uv run ruff check app tests scripts alembic \
    && uv run mypy app \
    && uv run pytest -m "not repository_contract"

FROM base AS development
RUN uv sync --frozen --group dev
COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app
COPY scripts ./scripts
COPY tests ./tests
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

FROM base AS runtime
COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app
COPY scripts ./scripts
RUN groupadd --system --gid 10001 feelmyrythm \
    && useradd --system --uid 10001 --gid feelmyrythm --home-dir /nonexistent --shell /usr/sbin/nologin feelmyrythm
USER 10001:10001
EXPOSE 8000
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000"]
