# syntax=docker/dockerfile:1
# Multi-target image for the monorepo:
#   docker build -f infra/docker/Dockerfile --target api    .
#   docker build -f infra/docker/Dockerfile --target worker .   (includes FFmpeg)
#   docker build -f infra/docker/Dockerfile --target web    .   (nginx + static dashboard)

ARG NODE_IMAGE=node:20-bookworm-slim

# ---- workspace manifests (cache-friendly dependency layer) -------------------
FROM ${NODE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/config/package.json packages/config/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/observability/package.json packages/observability/
COPY packages/database/package.json packages/database/
COPY packages/queue/package.json packages/queue/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY workers/engine/package.json workers/engine/

# ---- build -------------------------------------------------------------------
FROM manifests AS build
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w @shorts/api -w @shorts/worker -w @shorts/web

# ---- production node_modules ---------------------------------------------------
FROM manifests AS prod-deps
RUN npm ci --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app /app

# ---- api ---------------------------------------------------------------------
FROM runtime AS api
COPY --from=build /app/apps/api/dist apps/api/dist
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "apps/api/dist/index.js"]

# ---- worker (FFmpeg/FFprobe for media processing) ----------------------------
FROM runtime AS worker
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-montserrat fonts-noto-core \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data/storage && chown node:node /data/storage
COPY --from=build /app/workers/engine/dist workers/engine/dist
USER node
CMD ["node", "--enable-source-maps", "workers/engine/dist/index.js"]

# ---- web -----------------------------------------------------------------------
FROM nginx:1.27-alpine AS web
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
