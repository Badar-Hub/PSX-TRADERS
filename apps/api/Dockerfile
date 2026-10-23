# syntax=docker/dockerfile:1

# Debian rather than Alpine. Prisma's query engine links against glibc and
# OpenSSL, and its musl build is a recurring source of "Unable to require
# libquery_engine" at runtime — a failure that only shows up once the first
# query runs. The extra image size is not worth that class of surprise.
FROM node:22-bookworm-slim

# Prisma needs the openssl libraries at run time, not just to generate. The CA
# bundle is for the two things this service talks to: the PSX data portal and
# the Anthropic API.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Pinned to the version in the root package.json's packageManager field, so the
# image resolves the lockfile exactly as a developer's machine does.
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

WORKDIR /repo

# Manifests before sources, so editing a .ts file does not reinstall
# everything. The whole workspace's manifests are needed even though only the
# API is being built: pnpm validates the lockfile against every project in
# pnpm-workspace.yaml and refuses --frozen-lockfile if any are missing.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
COPY packages/engine/package.json packages/engine/
COPY packages/ledger/package.json packages/ledger/
COPY packages/psx/package.json packages/psx/
COPY packages/shared/package.json packages/shared/

# `@psx/api...` is pnpm's "this project and its dependencies" selector. It
# keeps the Expo toolchain — several hundred megabytes that this service has no
# use for — out of the image.
RUN pnpm install --frozen-lockfile --filter @psx/api...

COPY . .

# The client is generated for the platform it will run on, which is why this
# happens in the image rather than being copied from the host.
RUN pnpm --filter @psx/api exec prisma generate

# Builds @psx/shared, @psx/engine, @psx/ledger and @psx/data first; turbo.json
# declares build dependsOn ^build, and the API imports their dist output.
RUN pnpm --filter @psx/api... build

# Dev dependencies are deliberately left in place. Pruning them in a pnpm
# workspace means a second install, which relinks node_modules and discards the
# generated Prisma client above — and regenerating it needs the Prisma CLI,
# itself a dev dependency. Correctness over a few hundred megabytes on a
# staging box; revisit with `pnpm deploy` if image size starts to matter.
ENV NODE_ENV=production
EXPOSE 4000

# Compiled JavaScript, not tsx: a production process should not be transpiling
# on the fly, and a type error should have failed the build above.
CMD ["node", "apps/api/dist/server.js"]
