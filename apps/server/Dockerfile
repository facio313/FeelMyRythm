FROM python:3.13-slim AS dependencies

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv && \
    uv export --frozen --no-dev --no-hashes -o requirements.txt && \
    pip install --no-cache-dir -r requirements.txt && \
    rm requirements.txt

FROM dependencies AS test

RUN pip install --no-cache-dir "pytest>=8.0" "httpx>=0.27"
COPY app ./app
COPY tests ./tests
RUN pytest

FROM dependencies AS runtime

COPY app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
