FROM node:22.23.2-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /workspace

ARG VITE_GOOGLE_CLIENT_ID
ARG VITE_FMR_TEMPORARY_SINGLE_USER=false
ENV VITE_GOOGLE_CLIENT_ID=${VITE_GOOGLE_CLIENT_ID}
ENV VITE_FMR_TEMPORARY_SINGLE_USER=${VITE_FMR_TEMPORARY_SINGLE_USER}

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/audio/package.json packages/audio/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/protocol/package.json packages/protocol/package.json

RUN npm install --global pnpm@10.15.0 \
    && pnpm install --frozen-lockfile

COPY apps/web apps/web
COPY apps/mobile/src apps/mobile/src
COPY packages packages

RUN pnpm --filter @feelmyrythm/core build \
    && pnpm --filter @feelmyrythm/audio build \
    && pnpm --filter @feelmyrythm/web build

FROM nginx:1.29.4-alpine@sha256:4870c12cd2ca986de501a804b4f506ad3875a0b1874940ba0a2c7f763f1855b2 AS runtime
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html/feelmyrythm
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=4 CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1/healthz"]
