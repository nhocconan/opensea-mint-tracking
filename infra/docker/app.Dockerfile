# syntax=docker/dockerfile:1
# HoodMint Radar app image: one image serves web / worker / migrate
# (PRD §8.3: multi-stage, non-root, standalone Next output, bundled worker).

FROM node:24-alpine AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc* ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/secrets/package.json packages/secrets/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/execution/package.json packages/execution/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/queues/package.json packages/queues/package.json
COPY packages/signals/package.json packages/signals/package.json
COPY packages/signing/package.json packages/signing/package.json
COPY packages/notifications/package.json packages/notifications/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN corepack enable && pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY . .
# Next build (standalone) + esbuild bundles for worker and migrate.
RUN corepack enable \
  && pnpm --filter @hoodmint/web build \
  && pnpm exec esbuild apps/worker/src/index.ts --bundle --platform=node --format=esm \
       --outfile=dist/worker.mjs --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
  && pnpm exec esbuild packages/db/src/migrate.ts --bundle --platform=node --format=esm \
       --outfile=dist/migrate.mjs --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"

# Standalone file-tracing often drops @swc/helpers/esm (package.json type=module).
RUN mkdir -p /repo/docker-extras \
  && src="$(find /repo/node_modules/.pnpm -maxdepth 1 -type d -name '@swc+helpers@*' | head -1)" \
  && cp -a "$src/node_modules/@swc/helpers" /repo/docker-extras/swc-helpers

FROM node:24-alpine AS runner
RUN addgroup -S -g 10001 hood && adduser -S -u 10001 -G hood hood
WORKDIR /app
COPY --from=build --chown=hood:hood /repo/dist/worker.mjs worker.mjs
COPY --from=build --chown=hood:hood /repo/dist/migrate.mjs migrate.mjs
COPY --from=build --chown=hood:hood /repo/packages/db/migrations drizzle
COPY --from=build --chown=hood:hood /repo/apps/web/.next/standalone web
# Monorepo standalone emits server.js at apps/web/server.js.
COPY --from=build --chown=hood:hood /repo/apps/web/.next/static web/apps/web/.next/static
# Next standalone output deliberately EXCLUDES public/ — copy it explicitly
# or /sw.js (the Web Push service worker) 404s in Docker while working in
# `next dev` (finding #4, code review 2026-08-23). Served relative to the
# standalone server dir, i.e. web/apps/web/public.
COPY --from=build --chown=hood:hood /repo/apps/web/public web/apps/web/public
COPY --from=build --chown=hood:hood /repo/docker-extras/swc-helpers /tmp/swc-helpers
USER root
RUN find /app/web -type d -path '*/node_modules/@swc/helpers' | while read -r dest; do \
      rm -rf "$dest" && cp -a /tmp/swc-helpers "$dest" && chown -R hood:hood "$dest"; \
    done
USER hood
ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/drizzle \
    HOSTNAME=0.0.0.0
EXPOSE 3960
