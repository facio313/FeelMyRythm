#!/usr/bin/env bash

set -Eeuo pipefail

: "${SERVER_RUNTIME_IMAGE:?SERVER_RUNTIME_IMAGE is required}"
: "${WEB_RUNTIME_IMAGE:?WEB_RUNTIME_IMAGE is required}"
: "${POSTGRES_RUNTIME_IMAGE:?POSTGRES_RUNTIME_IMAGE is required}"
: "${REDIS_RUNTIME_IMAGE:?REDIS_RUNTIME_IMAGE is required}"
: "${PORTFOLIO_BRANCH:?PORTFOLIO_BRANCH is required}"
: "${PORTFOLIO_AUTH_MODE:?PORTFOLIO_AUTH_MODE is required}"

sh scripts/portfolio-auth-mode.sh check
[[ "$PORTFOLIO_AUTH_MODE" == "sso" ]] || {
  echo "The deploy runtime smoke expects a protected main/dev SSO build." >&2
  exit 1
}

for executable in curl docker openssl python3; do
  command -v "$executable" >/dev/null
done

run_suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-${RANDOM}"
network_name="fmr-runtime-smoke-${run_suffix}"
database_container="fmr-runtime-db-${run_suffix}"
redis_container="fmr-runtime-redis-${run_suffix}"
server_container="fmr-runtime-server-${run_suffix}"
web_container="fmr-runtime-web-${run_suffix}"
local_upload_volume="fmr-runtime-uploads-${run_suffix}"
edge_secret_volume="fmr-runtime-edge-secret-${run_suffix}"
temporary_directory="$(mktemp -d)"

cleanup() {
  docker rm --force "$web_container" "$server_container" "$redis_container" "$database_container" \
    >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
  docker volume rm "$local_upload_volume" >/dev/null 2>&1 || true
  docker volume rm "$edge_secret_volume" >/dev/null 2>&1 || true
  rm -rf "$temporary_directory"
}
trap cleanup EXIT

database_password="$(openssl rand -hex 24)"
jwt_secret="$(openssl rand -hex 48)"
edge_secret="$(openssl rand -hex 48)"

docker network create "$network_name" >/dev/null
docker run --detach \
  --name "$database_container" \
  --network "$network_name" \
  --network-alias postgres \
  --env POSTGRES_DB=feelmyrythm \
  --env POSTGRES_USER=feelmyrythm \
  --env "POSTGRES_PASSWORD=${database_password}" \
  "$POSTGRES_RUNTIME_IMAGE" >/dev/null

docker run --detach \
  --name "$redis_container" \
  --network "$network_name" \
  --network-alias redis \
  "$REDIS_RUNTIME_IMAGE" >/dev/null

database_ready=false
for _ in $(seq 1 60); do
  if docker exec "$database_container" pg_isready \
    --dbname feelmyrythm --username feelmyrythm >/dev/null 2>&1; then
    database_ready=true
    break
  fi
  if ! docker inspect --format '{{.State.Running}}' "$database_container" 2>/dev/null | grep -qx true; then
    break
  fi
  sleep 1
done
if [[ "$database_ready" != true ]]; then
  docker logs "$database_container"
  echo "PostgreSQL runtime smoke dependency did not become ready." >&2
  exit 1
fi

redis_ready=false
for _ in $(seq 1 60); do
  if docker exec "$redis_container" redis-cli ping 2>/dev/null | grep -qx PONG; then
    redis_ready=true
    break
  fi
  if ! docker inspect --format '{{.State.Running}}' "$redis_container" 2>/dev/null | grep -qx true; then
    break
  fi
  sleep 1
done
if [[ "$redis_ready" != true ]]; then
  docker logs "$redis_container"
  echo "Redis runtime smoke dependency did not become ready." >&2
  exit 1
fi

docker run --detach \
  --name "$server_container" \
  --network "$network_name" \
  --network-alias fmrServer \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m,mode=1777 \
  --env "PORTFOLIO_BRANCH=${PORTFOLIO_BRANCH}" \
  --env "PORTFOLIO_AUTH_MODE=${PORTFOLIO_AUTH_MODE}" \
  --env FMR_ENVIRONMENT=production \
  --env FMR_DEPLOYMENT_PROFILE=standard \
  --env FMR_SSO_ENABLED=true \
  --env "FMR_SSO_EDGE_SECRET=${edge_secret}" \
  --env "FMR_DATABASE_URL=postgresql+psycopg://feelmyrythm:${database_password}@postgres:5432/feelmyrythm" \
  --env FMR_AUTO_CREATE_SCHEMA=false \
  --env "FMR_JWT_SECRET=${jwt_secret}" \
  --env FMR_REDIS_URL=redis://redis:6379/0 \
  --env FMR_STORAGE_BACKEND=s3 \
  --env FMR_S3_BUCKET=fmr-runtime-smoke \
  --env FMR_S3_REGION=us-east-1 \
  --env FMR_SMTP_HOST=smtp.example.com \
  --env FMR_SMTP_FROM_EMAIL=smoke@example.com \
  --env FMR_WEB_APP_BASE_URL=https://example.com/feelmyrythm \
  --env FMR_PUBLIC_API_BASE_URL=https://example.com/feelmyrythm \
  --env AWS_ACCESS_KEY_ID=runtime-smoke \
  --env AWS_SECRET_ACCESS_KEY=runtime-smoke \
  "$SERVER_RUNTIME_IMAGE" >/dev/null

server_ready=false
for _ in $(seq 1 90); do
  if docker exec "$server_container" python -c \
    "import json, urllib.request; assert json.load(urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2)) == {'ok': True}" \
    >/dev/null 2>&1; then
    server_ready=true
    break
  fi
  if ! docker inspect --format '{{.State.Running}}' "$server_container" 2>/dev/null | grep -qx true; then
    break
  fi
  sleep 1
done
if [[ "$server_ready" != true ]]; then
  docker logs "$server_container"
  echo "Server runtime image did not migrate and become healthy." >&2
  exit 1
fi

[[ "$(docker exec "$server_container" id -u)" == "10001" ]]
[[ "$(docker exec "$server_container" id -g)" == "10001" ]]
docker exec "$server_container" sh -c \
  'command -v alembic >/dev/null && command -v uvicorn >/dev/null && test ! -w / && test ! -w /app && test -w /tmp' \
  >/dev/null

[[ "$(docker image inspect --format '{{ index .Config.Labels "work.bonifacio.portfolio.branch" }}' "$SERVER_RUNTIME_IMAGE")" == "$PORTFOLIO_BRANCH" ]]
[[ "$(docker image inspect --format '{{ index .Config.Labels "work.bonifacio.portfolio.auth-mode" }}' "$SERVER_RUNTIME_IMAGE")" == "$PORTFOLIO_AUTH_MODE" ]]
if server_resolver_failure="$(docker run --rm \
  --env PORTFOLIO_BRANCH=runtime-smoke \
  --env PORTFOLIO_AUTH_MODE=local \
  "$SERVER_RUNTIME_IMAGE" 2>&1)"; then
  echo "Server runtime resolver accepted an auth contract different from its build." >&2
  exit 1
fi
grep -Fq 'does not match image' <<<"$server_resolver_failure"
if server_contract_failure="$(docker run --rm \
  --env PORTFOLIO_BRANCH=runtime-smoke \
  --env PORTFOLIO_AUTH_MODE=local \
  --entrypoint python \
  "$SERVER_RUNTIME_IMAGE" \
  -c 'from app.config import Settings; Settings()' 2>&1)"; then
  echo "Server runtime image accepted an auth contract different from its build." >&2
  exit 1
fi
grep -Fq 'differs from the immutable server image contract' <<<"$server_contract_failure"

docker volume create "$local_upload_volume" >/dev/null
docker volume create "$edge_secret_volume" >/dev/null
printf '%s' "$edge_secret" | docker run --rm --interactive \
  --user 0:0 \
  --volume "${edge_secret_volume}:/run/secrets" \
  --entrypoint sh \
  "$SERVER_RUNTIME_IMAGE" \
  -c 'umask 027; head -c 4096 > /run/secrets/fmr_sso_edge_secret; chown 0:0 /run/secrets/fmr_sso_edge_secret; chmod 0640 /run/secrets/fmr_sso_edge_secret'
docker run --rm \
  --user 10001:0 \
  --network "$network_name" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m,mode=1777 \
  --volume "${local_upload_volume}:/data/uploads" \
  --volume "${edge_secret_volume}:/run/secrets:ro" \
  --env "PORTFOLIO_BRANCH=${PORTFOLIO_BRANCH}" \
  --env "PORTFOLIO_AUTH_MODE=${PORTFOLIO_AUTH_MODE}" \
  --env FMR_ENVIRONMENT=production \
  --env FMR_DEPLOYMENT_PROFILE=managed_local_sso \
  --env FMR_SSO_ENABLED=true \
  --env FMR_SSO_EDGE_SECRET_FILE=/run/secrets/fmr_sso_edge_secret \
  --env "FMR_DATABASE_URL=postgresql+psycopg://feelmyrythm:${database_password}@postgres:5432/feelmyrythm" \
  --env FMR_AUTO_CREATE_SCHEMA=false \
  --env "FMR_JWT_SECRET=${jwt_secret}" \
  --env FMR_REDIS_URL=redis://redis:6379/0 \
  --env FMR_STORAGE_BACKEND=local \
  --env FMR_LOCAL_UPLOADS_DIR=/data/uploads \
  --env FMR_WEB_APP_BASE_URL=https://example.com/feelmyrythm \
  --env FMR_PUBLIC_API_BASE_URL=https://example.com/feelmyrythm \
  --entrypoint python \
  "$SERVER_RUNTIME_IMAGE" \
  -c 'import os, stat; from app.config import Settings; from app.storage import LocalObjectStorage; settings = Settings(); metadata = os.stat(settings.sso_edge_secret_file); assert os.geteuid() == 10001 and os.getegid() == 0; assert metadata.st_uid == 0 and metadata.st_gid == 0 and stat.S_IMODE(metadata.st_mode) == 0o640; storage = LocalObjectStorage(settings); candidate = storage.create_temporary_upload_path(); candidate.write_bytes(b"runtime-smoke"); candidate.unlink()'

docker run --detach \
  --name "$web_container" \
  --network "$network_name" \
  --publish 127.0.0.1::80 \
  --env "PORTFOLIO_BRANCH=${PORTFOLIO_BRANCH}" \
  --env "PORTFOLIO_AUTH_MODE=${PORTFOLIO_AUTH_MODE}" \
  "$WEB_RUNTIME_IMAGE" >/dev/null
docker exec "$web_container" nginx -t >/dev/null
[[ "$(docker exec "$web_container" printenv PORTFOLIO_BRANCH)" == "$PORTFOLIO_BRANCH" ]]
[[ "$(docker exec "$web_container" printenv PORTFOLIO_AUTH_MODE)" == "$PORTFOLIO_AUTH_MODE" ]]
[[ "$(docker exec "$web_container" sed -n '1p' /etc/portfolio-auth-build)" == "$PORTFOLIO_BRANCH" ]]
[[ "$(docker exec "$web_container" sed -n '2p' /etc/portfolio-auth-build)" == "$PORTFOLIO_AUTH_MODE" ]]
[[ "$(docker image inspect --format '{{ index .Config.Labels "work.bonifacio.portfolio.branch" }}' "$WEB_RUNTIME_IMAGE")" == "$PORTFOLIO_BRANCH" ]]
[[ "$(docker image inspect --format '{{ index .Config.Labels "work.bonifacio.portfolio.auth-mode" }}' "$WEB_RUNTIME_IMAGE")" == "$PORTFOLIO_AUTH_MODE" ]]
if web_contract_failure="$(docker run --rm \
  --env PORTFOLIO_BRANCH=runtime-smoke \
  --env PORTFOLIO_AUTH_MODE=local \
  "$WEB_RUNTIME_IMAGE" 2>&1)"; then
  echo "Web runtime image accepted an auth contract different from its bundle." >&2
  exit 1
fi
grep -Fq 'does not match image' <<<"$web_contract_failure"

web_port="$(docker port "$web_container" 80/tcp | sed -n '1s/.*://p')"
[[ "$web_port" =~ ^[0-9]+$ ]]
origin="http://127.0.0.1:${web_port}"

web_ready=false
for _ in $(seq 1 60); do
  if curl --fail --silent --show-error "${origin}/healthz" --output /dev/null; then
    web_ready=true
    break
  fi
  if ! docker inspect --format '{{.State.Running}}' "$web_container" 2>/dev/null | grep -qx true; then
    break
  fi
  sleep 1
done
if [[ "$web_ready" != true ]]; then
  docker logs "$web_container"
  echo "Web runtime image did not become healthy." >&2
  exit 1
fi

index_headers="${temporary_directory}/index.headers"
index_body="${temporary_directory}/index.html"
curl --fail --silent --show-error --dump-header "$index_headers" \
  "${origin}/feelmyrythm/" --output "$index_body"
grep -Eiq '^cache-control:.*no-cache' "$index_headers"
grep -Eiq '^content-security-policy:' "$index_headers"
grep -Eiq '^strict-transport-security:' "$index_headers"
grep -Fq '<div id="root"></div>' "$index_body"
docker exec "$web_container" grep -R -Fq '임시 운영 할 일' \
  /usr/share/nginx/html/feelmyrythm/assets
docker exec "$web_container" grep -R -Fq 'AWS S3를 준비하고 로컬 악보 파일 이관' \
  /usr/share/nginx/html/feelmyrythm/assets

spa_body="${temporary_directory}/spa.html"
curl --fail --silent --show-error \
  "${origin}/feelmyrythm/metronome" --output "$spa_body"
cmp --silent "$index_body" "$spa_body"

api_headers="${temporary_directory}/api.headers"
api_body="${temporary_directory}/api.json"
curl --fail --silent --show-error --dump-header "$api_headers" \
  "${origin}/feelmyrythm/api/health" --output "$api_body"
grep -Eiq '^cache-control:.*no-store' "$api_headers"
grep -Eiq '^x-content-type-options:.*nosniff' "$api_headers"
grep -Eiq '^x-frame-options:.*deny' "$api_headers"
python3 -c \
  'import json, pathlib, sys; assert json.loads(pathlib.Path(sys.argv[1]).read_text()) == {"ok": True}' \
  "$api_body"

asset_path="$(python3 -c \
  'import pathlib, re, sys; match = re.search(r"(?:src|href)=\"(/feelmyrythm/assets/[^\"]+)\"", pathlib.Path(sys.argv[1]).read_text()); assert match; print(match.group(1))' \
  "$index_body")"
asset_headers="${temporary_directory}/asset.headers"
curl --fail --silent --show-error --dump-header "$asset_headers" \
  "${origin}${asset_path}" --output /dev/null
grep -Eiq '^cache-control:.*public.*immutable' "$asset_headers"

[[ "$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "${origin}/")" == "404" ]]

echo "Runtime server migration, non-root execution, nginx, SPA, asset, and API proxy smoke passed."
