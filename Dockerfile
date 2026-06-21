# syntax=docker/dockerfile:1.20
# Requires BuildKit (Docker 23+, or DOCKER_BUILDKIT=1). The `COPY --parents`
# directives below are BuildKit-only — the classic builder (DOCKER_BUILDKIT=0)
# cannot build this image.
# ── Stage 1: Install dependencies ──────────────────────────────────
FROM oven/bun:1.3.14-alpine AS deps

LABEL org.opencontainers.image.source="https://github.com/appstrate/appstrate"
LABEL org.opencontainers.image.description="Appstrate — Open-source platform for running autonomous AI agents in sandboxed Docker containers"
LABEL org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /app

# Copy workspace structure for dependency resolution.
# Every workspace member referenced by the lockfile must have its
# manifest on disk — `bun install` walks the full
# graph even when only a subset is needed at runtime.
#
# `COPY --parents` (stable since dockerfile 1.20) copies each match while
# preserving its directory structure, so the member manifests are derived
# from the monorepo graph instead of a hand-maintained list:
#   */package.json    → runtime-pi, e2e            (depth-1 members)
#   */*/package.json  → apps/*, packages/*, runtime-pi/sidecar  (depth-2)
# Adding a new workspace package requires ZERO edits here — the glob picks
# it up. The deps layer still caches on manifest/lockfile changes only.
COPY package.json bun.lock turbo.json ./
COPY --parents */package.json */*/package.json ./
COPY patches/ patches/

# NOT `--frozen-lockfile`: its comparator has a bug with @openai/codex's
# same-name aliased platform binaries (@openai/codex@0.141.0-<platform>) and
# false-reports "lockfile had changes" on a byte-stable lockfile. Versions stay
# pinned by the COPY'd bun.lock (resolution reads it); lockfile drift is caught
# by the `git diff --exit-code bun.lock` guard in CI (.github/workflows/check.yml).
RUN bun install

# ── Stage 2: Build ────────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS build

WORKDIR /app

# Copy all node_modules (root + every workspace member) from the deps stage,
# preserving structure. The build stage is ephemeral, so a broad graph-derived
# copy is fine — the subsequent `bun install` relinks workspace symlinks and
# `bun run build` only emits apps/web/dist + bundled outputs. `--parents` needs
# the `/app/./` pivot to strip the source prefix so trees land at their member
# path (apps/api/node_modules, packages/*/node_modules, …) rather than under app/.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps --parents /app/./*/node_modules /app/./*/*/node_modules ./

COPY . .

# Re-link workspace packages after COPY overwrites symlinks. Without this,
# Rolldown (Vite 8) can't resolve transitive deps like i18next via the broken
# apps/web/node_modules/i18next → /app/node_modules/.bun/i18next@X symlink.
RUN bun install

RUN bun run build

# ── Stage 3: Production image ─────────────────────────────────────
FROM oven/bun:1.3.14-alpine

WORKDIR /app

# Runtime dependencies (root hoisted + workspace-specific).
# ⚠️ MANUAL allowlist — NOT graph-derived (unlike the src/manifest COPYs below).
# Any new package the runtime imports whose deps DON'T hoist to the root
# node_modules (e.g. bun isolated installs, like afps-shared's `semver`) must be
# added here explicitly — its `src` ships automatically via the glob below, but
# its node_modules will be SILENTLY missing and crash-loop at runtime.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/afps-runtime/node_modules ./packages/afps-runtime/node_modules
COPY --from=deps /app/packages/connect/node_modules ./packages/connect/node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/env/node_modules ./packages/env/node_modules
COPY --from=deps /app/packages/mcp-transport/node_modules ./packages/mcp-transport/node_modules
COPY --from=deps /app/packages/runner-pi/node_modules ./packages/runner-pi/node_modules
COPY --from=deps /app/packages/shared-types/node_modules ./packages/shared-types/node_modules

# ── Workspace package sources (Bun runs TypeScript directly — no build step) ──
# Graph-derived via `COPY --parents`: apps/api source + every packages/*/src
# and manifest ship, so adding a workspace package needs no edit here. apps/api
# is the only app shipped as source (web ships as built dist below; cli/e2e are
# not shipped). The `/app/./` pivot strips the source prefix so each tree lands
# at its member path (e.g. /app/packages/core/src → packages/core/src).
#
# This now also includes packages/ui + packages/mcp-transport sources (~150 KB
# of TS) which the API path does not import — inert weight, not a runtime dep.
# The matching @appstrate/{core,db,…} runtime packages are exercised by the API
# (validation, schema, db client, auth, modules, env, connect, runner-pi).
COPY --from=build --parents /app/./apps/api/src /app/./apps/api/package.json ./
COPY --from=build --parents /app/./packages/*/src /app/./packages/*/package.json ./

# Non-`src` package assets that must ship alongside their package source:
#   core/schema — JSON schemas resolved at runtime
#   db/drizzle  — SQL migrations applied at boot
COPY --from=build /app/packages/core/schema ./packages/core/schema
COPY --from=build /app/packages/db/drizzle ./packages/db/drizzle

# AFPS shared declares `semver` in its OWN isolated node_modules (bun isolated
# install), so it MUST ship — otherwise the runtime crash-loops with
# `Cannot find package 'semver' from .../packages/afps-shared/src/semver-resolve.ts`.
COPY --from=deps /app/packages/afps-shared/node_modules ./packages/afps-shared/node_modules

# Built frontend
COPY --from=build /app/apps/web/dist ./apps/web/dist

# Create mount points for runtime volumes (data + storage)
RUN mkdir -p data storage && chown -R bun:bun data storage

# Ensure the unprivileged `bun` user owns the workspace package trees
# COPYed in as root (so any runtime scratch writes under node_modules
# succeed).
RUN chown -R bun:bun /app/packages /app/apps/api/node_modules

# Root package.json needed for workspace resolution
COPY --from=build /app/package.json ./
COPY --from=build /app/system-packages ./system-packages

# su-exec for lightweight privilege drop in entrypoint
RUN apk add --no-cache su-exec

# Entrypoint: detects Docker socket GID and adds bun to that group before exec
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/ || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "apps/api/src/index.ts"]
