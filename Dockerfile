# Single image for both the gateway and the worker fleet — which process
# runs is decided by the start command, not the image, so Railway/Render/Fly
# can scale gateway replicas and worker replicas independently from the same
# build.
#
# Gateway:  CMD ["node", "dist/server.js"]        (this file's default CMD)
# Worker:   CMD ["node", "dist/workers/index.js"]  (override — see below)
#
# On Railway this means TWO services in the same project, both built from
# this Dockerfile, from the same repo:
#   - "gateway" service: no override needed, uses this file's default CMD.
#     Config-as-code: railway.json (repo root).
#   - "worker" service: must override the start command, because without a
#     running `dist/workers/index.js` process nothing ever calls
#     pg-boss's `boss.work()` — queued discover.live/pool.expand/pool.verify
#     jobs sit in pgboss.job with state='created' forever and NO leads are
#     ever produced, regardless of how correct the gateway/queue/DB code is.
#     Config-as-code: railway.worker.json — set this service's
#     Settings -> Deploy -> "Config File Path" to railway.worker.json so
#     Railway applies its startCommand instead of this file's CMD.
# See RAILWAY_DEPLOYMENT.md for the full setup checklist.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build:server

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# Must match the COPY destination below (a sibling of WORKDIR, i.e. one level
# up from /app). Pinned explicitly so this never again silently drifts out of
# sync with src/config/env.ts's default (see env.ts comment history).
ENV SCRAPER_ENGINE_PATH=/mast-lead-engine

# Phase 2: the worker image needs Python + the Part 1 engine to actually
# spawn `python3 service.py` (see src/scraperBridge/pythonBridge.ts). The
# gateway image doesn't need any of this — it never touches Python — but
# ships from the same Dockerfile for simplicity; consider splitting into
# gateway/worker Dockerfiles later if image size becomes a concern.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Expects the mast-lead-engine directory to be present as a sibling at
# build time — e.g. via a monorepo layout or a build-context copy step in
# CI, not committed into this repo (the engine has its own repo/history).
#
# Placed at /mast-lead-engine (sibling of /app, not inside it) because
# SCRAPER_ENGINE_PATH defaults to "../mast-lead-engine" (src/config/env.ts),
# resolved relative to the gateway/worker process's cwd (/app, from
# WORKDIR above) — i.e. it must land one level up from /app, exactly
# mirroring the sibling-repo layout pythonBridge.ts expects in local dev.
COPY mast-lead-engine /mast-lead-engine
RUN pip3 install --break-system-packages --no-cache-dir -r /mast-lead-engine/requirements.txt

# requirements.txt pins the playwright PYTHON PACKAGE, but that package is
# just bindings — it does not ship the actual Chromium binary the engine
# launches at runtime. Without this step, every scrape_jobs run reaches the
# worker, spawns `python3 service.py`, and immediately crashes the first
# time the engine tries to open a browser (Playwright's
# "Executable doesn't exist" error). `--with-deps` also apt-installs the
# OS-level shared libraries Chromium needs (libnss3, libatk, etc.) so this
# doesn't need to be kept in sync by hand.
RUN python3 -m playwright install --with-deps chromium

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

EXPOSE 8080
CMD ["node", "dist/server.js"]
