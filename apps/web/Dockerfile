# 빌드 컨텍스트는 레포 루트 (npm workspaces 모노레포이므로).
# docker-compose.prod.yml 에서 context: . / dockerfile: apps/web/Dockerfile 로 지정한다.
FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/audio/package.json packages/audio/
COPY packages/protocol/package.json packages/protocol/
COPY packages/ui/package.json packages/ui/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY packages ./packages
COPY apps/web ./apps/web
RUN npm test && npm run build -w @feelmyrythm/web

FROM nginx:stable-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html/feelmyrythm
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
