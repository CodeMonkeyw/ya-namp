# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# ya-namp — multistage image (works with `docker build` and `podman build`).
#
#   build   : install deps + produce client/dist and the lean server bundle
#   runtime : node:22-alpine + ONLY the two build outputs (no node_modules) —
#             the server bundle already has express etc. baked in.
#
# The runtime replicates the repo-root layout the server resolves against:
#   /app/server/dist/index.mjs  → __dirname
#   /app/client/dist            → ../../client/dist   (static SPA)
#   /app/.env                   → ../../.env          (optional, mountable)
# ---------------------------------------------------------------------------

# ---- build stage ----------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /src

# Copy manifests first so `npm ci` layer caches until deps change.
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm ci

# Copy the rest of the sources and build client/dist + server/dist/index.mjs.
COPY . .
RUN npm run build:all

# ---- runtime stage --------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8058
# YANDEX_TOKEN is optional — pass with `-e YANDEX_TOKEN=...` or mount /app/.env.
# (leaving it unset boots the fully-offline demo mode.)

# Only the two self-contained build outputs — no node_modules, no sources.
COPY --from=build /src/server/dist/index.mjs ./server/dist/index.mjs
COPY --from=build /src/client/dist ./client/dist

EXPOSE 8058

# Synology DSM Container Manager runs containers as root — be explicit.
USER 0:0

CMD ["node", "server/dist/index.mjs"]
