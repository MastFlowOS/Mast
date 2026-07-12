# Single image for both the gateway and the worker fleet — which process
# runs is decided by the start command, not the image, so Railway/Render/Fly
# can scale gateway replicas and worker replicas independently from the same
# build.
#
# Gateway:  CMD ["node", "dist/server.js"]
# Worker:   CMD ["node", "dist/workers/index.js"]

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build:server

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

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

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

EXPOSE 8080
CMD ["node", "dist/server.js"]
