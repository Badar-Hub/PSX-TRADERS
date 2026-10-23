# syntax=docker/dockerfile:1

# Same base as the API, for one image layer cache and one set of surprises.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

WORKDIR /repo

# See the note in apps/api/Dockerfile: every manifest is required for
# --frozen-lockfile even though only one project is being built.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
COPY packages/engine/package.json packages/engine/
COPY packages/ledger/package.json packages/ledger/
COPY packages/psx/package.json packages/psx/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile --filter @psx/web...

COPY . .

# A value is needed for the build even though nothing in this app fetches at
# build time — every page reads cookies and is therefore dynamic. Supplying an
# obviously-unusable one means that if a page ever does start prerendering
# against the API, the build fails loudly here instead of baking a wrong
# address into the output. The real address arrives from the environment at run
# time.
ENV API_BASE_URL=http://api-not-available-at-build-time:4000
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @psx/web... build

ENV NODE_ENV=production
EXPOSE 3000

# `next start`, matching the app's own start script, rather than the standalone
# server. Standalone output would make this image far smaller, but it changes
# how the app is launched and is a separate change to make deliberately.
CMD ["pnpm", "--filter", "@psx/web", "start"]
