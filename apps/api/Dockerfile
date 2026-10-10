# syntax=docker/dockerfile:1
# NOTE: build ON the target (docker compose up -d --build on the ARM VM) so
# native napi prebuilds (@node-rs/argon2) match linux/arm64.
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --no-frozen-lockfile
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm --filter @klass/shared build \
 && pnpm --filter @klass/web build \
 && pnpm --filter @klass/api build

# Runtime dependency set, installed from scratch.
#
# WHY THIS STAGE EXISTS. The previous version of this file ran
# `pnpm install --prod …` inside the build stage and copied that node_modules. Measured in CI
# (run 38045464863): the image still resolved `vitest`, and the pnpm store still held five
# dev-tool packages — pnpm does not prune dev dependencies out of a node_modules that was
# installed with them. The deployed container therefore shipped vitest, tsx, drizzle-kit,
# typescript and embedded-postgres (a package that can download and run a Postgres binary).
# A fresh install with --prod is the only way to get a layer that actually matches the list.
FROM node:22-bookworm-slim AS deps
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --prod --frozen-lockfile --filter @klass/api --filter @klass/shared

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
# Every node_modules comes from `deps` (prod-only). The build stage's tree is deliberately NOT
# copied — that is exactly what shipped vitest before. Only the compiled output comes from `build`.
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/packages ./packages
COPY --from=deps /repo/apps/api ./apps/api
# @klass/shared is a workspace link: its package.json comes from `deps`, its compiled output from
# `build` (the deps stage installs, it does not compile).
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/web/dist apps/web/dist
ENV WEB_DIST=/repo/apps/web/dist
EXPOSE 3000
USER node
WORKDIR /repo/apps/api
CMD ["node", "dist/server.js"]
