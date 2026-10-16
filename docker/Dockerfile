# One image definition for the whole monorepo; each app is a build target:
#   docker build -f docker/Dockerfile --target api .
#   docker build -f docker/Dockerfile --target worker .
#   docker build -f docker/Dockerfile --target web .
# `docker compose up` builds and runs all of them (see docker-compose.yml).
#
# The API and worker run their TypeScript directly with tsx (no separate
# compile step), so the source in the image is exactly what the tests ran.
# Processes run as the unprivileged `node` user and are started with `node`
# itself, not through npm, so SIGTERM reaches the app and its graceful
# shutdown runs (compose adds tini as PID 1 with `init: true`).
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY apps/simulator/package.json apps/simulator/
COPY packages/database/package.json packages/database/
COPY packages/shared/package.json packages/shared/
COPY packages/alert-sdk/package.json packages/alert-sdk/
RUN npm ci --no-audit --no-fund

FROM deps AS source
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
ENV NODE_ENV=production

# Migrations + seed (the `migrate` service), and the simulator via
# `docker compose run --rm migrate npm run demo:incident`.
FROM source AS api
USER node
EXPOSE 4000
WORKDIR /app/apps/api
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/health/live || exit 1
CMD ["node", "--import", "tsx", "src/index.ts"]

FROM source AS worker
USER node
WORKDIR /app/apps/worker
ENV WORKER_HEARTBEAT_FILE=/tmp/worker-heartbeat
# The worker touches this file on every heartbeat (every 10 s), even while
# Redis is down: a stale file means the event loop is stuck.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD test -f /tmp/worker-heartbeat && test $(( $(date +%s) - $(stat -c %Y /tmp/worker-heartbeat) )) -lt 45 || exit 1
CMD ["node", "--import", "tsx", "src/index.ts"]

FROM source AS web
# Baked into the client bundle at build time: the URL the *browser* uses.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @irp/web && chown -R node:node apps/web/.next
USER node
EXPOSE 3000
WORKDIR /app/apps/web
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:3000/login || exit 1
CMD ["node", "/app/node_modules/next/dist/bin/next", "start", "-p", "3000"]
