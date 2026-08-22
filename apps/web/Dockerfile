FROM node:22.23.2-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /workspace

ARG VITE_GOOGLE_CLIENT_ID
ARG PORTFOLIO_BRANCH
ARG PORTFOLIO_AUTH_MODE
ARG VITE_FMR_MANAGED_LOCAL_SSO
ARG VITE_FMR_SSO_ENABLED
ENV VITE_GOOGLE_CLIENT_ID=${VITE_GOOGLE_CLIENT_ID}
ENV PORTFOLIO_BRANCH=${PORTFOLIO_BRANCH}
ENV PORTFOLIO_AUTH_MODE=${PORTFOLIO_AUTH_MODE}
ENV VITE_FMR_MANAGED_LOCAL_SSO=${VITE_FMR_MANAGED_LOCAL_SSO}
ENV VITE_FMR_SSO_ENABLED=${VITE_FMR_SSO_ENABLED}

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

FROM nginx:1.31.0-alpine@sha256:2f07d83bf561b506400dc183b1b2003803e39efbd22451f848adaba14d28c7c7 AS runtime
ARG PORTFOLIO_BRANCH
ARG PORTFOLIO_AUTH_MODE
ENV PORTFOLIO_BRANCH=${PORTFOLIO_BRANCH}
ENV PORTFOLIO_AUTH_MODE=${PORTFOLIO_AUTH_MODE}
LABEL work.bonifacio.portfolio.branch=${PORTFOLIO_BRANCH} \
    work.bonifacio.portfolio.auth-mode=${PORTFOLIO_AUTH_MODE}
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY scripts/portfolio-auth-mode.sh /usr/local/bin/portfolio-auth-mode
COPY apps/web/docker/40-validate-portfolio-auth.sh /docker-entrypoint.d/40-validate-portfolio-auth.sh
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html/feelmyrythm
RUN portfolio-auth-mode check \
    && build_branch="${PORTFOLIO_BRANCH#refs/heads/}" \
    && printf '%s\n%s\n' "$build_branch" "$PORTFOLIO_AUTH_MODE" > /etc/portfolio-auth-build \
    && chmod 0555 /docker-entrypoint.d/40-validate-portfolio-auth.sh \
    && chmod 0444 /etc/portfolio-auth-build
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=4 CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1/healthz"]
