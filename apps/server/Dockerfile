FROM ghcr.io/astral-sh/uv:0.12.5@sha256:e85be844203885286c60ffad8a858d48afb6c5a5c237ca0e67f12e74b8f174b1 AS uv

FROM python:3.14.7-slim@sha256:ce40764625a4ff50df3548277632e7f96c4e77fe75fa848aae9885476e7df5a4 AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH"
WORKDIR /app

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"]

COPY apps/server/pyproject.toml apps/server/uv.lock ./
COPY --from=uv /uv /uvx /bin/
RUN uv sync --frozen --no-dev

FROM base AS portfolio-contract
ARG PORTFOLIO_BRANCH
ARG PORTFOLIO_AUTH_MODE
ENV PORTFOLIO_BRANCH=${PORTFOLIO_BRANCH} \
    PORTFOLIO_AUTH_MODE=${PORTFOLIO_AUTH_MODE}
LABEL work.bonifacio.portfolio.branch=${PORTFOLIO_BRANCH} \
    work.bonifacio.portfolio.auth-mode=${PORTFOLIO_AUTH_MODE}
COPY scripts/portfolio-auth-mode.sh /usr/local/bin/portfolio-auth-mode
RUN portfolio-auth-mode check \
    && build_branch="${PORTFOLIO_BRANCH#refs/heads/}" \
    && printf '%s\n%s\n' "$build_branch" "$PORTFOLIO_AUTH_MODE" > /etc/portfolio-auth-build \
    && chmod 0444 /etc/portfolio-auth-build

FROM portfolio-contract AS test
# The test target is not runnable application output. Unit fixtures exercise local and SSO paths
# independently of the source branch after the build contract itself has been validated above.
RUN rm /etc/portfolio-auth-build
RUN uv sync --frozen --group dev
COPY apps/server/alembic.ini ./
COPY apps/server/alembic ./alembic
COPY apps/server/app ./app
COPY apps/server/scripts ./scripts
COPY apps/server/tests ./tests
RUN uv run ruff check app tests scripts alembic \
    && uv run mypy app scripts/production_preflight.py \
    && uv run pytest -m "not repository_contract"

FROM portfolio-contract AS development
RUN uv sync --frozen --group dev
COPY apps/server/alembic.ini ./
COPY apps/server/alembic ./alembic
COPY apps/server/app ./app
COPY apps/server/scripts ./scripts
COPY apps/server/tests ./tests
CMD ["portfolio-auth-mode", "exec", "--", "uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

FROM portfolio-contract AS runtime
COPY apps/server/alembic.ini ./
COPY apps/server/alembic ./alembic
COPY apps/server/app ./app
COPY apps/server/scripts ./scripts
RUN groupadd --system --gid 10001 feelmyrythm \
    && useradd --system --uid 10001 --gid feelmyrythm --home-dir /nonexistent --shell /usr/sbin/nologin feelmyrythm \
    && install -d -o 10001 -g 10001 -m 0750 /data/uploads
USER 10001:10001
EXPOSE 8000
CMD ["portfolio-auth-mode", "exec", "--", "sh", "-c", "python -c 'from app.config import load_settings; load_settings()' && alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000"]
