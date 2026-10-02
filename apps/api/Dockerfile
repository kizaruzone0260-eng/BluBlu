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

# re-install runtime deps only (api + shared)
RUN pnpm install --prod --no-frozen-lockfile --filter @klass/api --filter @klass/shared

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/api/package.json apps/api/package.json
COPY --from=build /repo/apps/api/node_modules apps/api/node_modules
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/web/dist apps/web/dist
ENV WEB_DIST=/repo/apps/web/dist
EXPOSE 3000
USER node
WORKDIR /repo/apps/api
CMD ["node", "dist/server.js"]
