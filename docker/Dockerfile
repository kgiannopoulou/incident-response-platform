# One image definition for the whole monorepo; each app is a build target:
#   docker build -f docker/Dockerfile --target api .
#   docker build -f docker/Dockerfile --target worker .
#   docker build -f docker/Dockerfile --target web .
# The API and worker run their TypeScript directly with tsx (no separate
# compile step), so the source in the image is exactly what the tests ran.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/database/package.json packages/database/
COPY packages/shared/package.json packages/shared/
COPY packages/alert-sdk/package.json packages/alert-sdk/
RUN npm ci --no-audit --no-fund

FROM deps AS source
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps

FROM source AS api
EXPOSE 4000
CMD ["npm", "run", "start", "-w", "@irp/api"]

FROM source AS worker
CMD ["npm", "run", "start", "-w", "@irp/worker"]

FROM source AS web
# Baked into the client bundle at build time: the URL the *browser* uses.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build -w @irp/web
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@irp/web"]
