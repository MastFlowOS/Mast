# Single image for both the gateway and the worker fleet — which process
# runs is decided by the start command, not the image, so Railway/Render/Fly
# can scale gateway replicas and worker replicas independently from the same
# build.
#
# Gateway:  CMD ["node", "dist/server.js"]
# Worker:   CMD ["node", "dist/workers/index.js"]

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-slim
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
COPY mast-lead-engine ./mast-lead-engine
RUN pip3 install --break-system-packages --no-cache-dir -r mast-lead-engine/requirements.txt

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

EXPOSE 8080
CMD ["node", "dist/server.js"]
