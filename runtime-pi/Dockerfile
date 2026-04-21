# syntax=docker/dockerfile:1.7
#
# Built from the workspace *parent* directory so both the appstrate
# monorepo and the sibling afps-spec repo (referenced via `file:`) resolve:
#   docker build --platform linux/amd64 \
#     -t appstrate-pi -f appstrate/runtime-pi/Dockerfile ..
#
# Relative paths below are resolved from the parent (e.g. `appstrate/…`).

# ── Stage 1: Install dependencies ─────────────────────────────────
FROM --platform=${TARGETPLATFORM:-linux/amd64} oven/bun:1.3.11-alpine AS deps

LABEL org.opencontainers.image.source="https://github.com/appstrate/appstrate"
LABEL org.opencontainers.image.description="Appstrate Pi — AI agent runtime for ephemeral agent runs"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# Sibling afps-spec repo — root package.json pins `@afps-spec/schema` via `file:`.
WORKDIR /afps-spec
COPY afps-spec/schema ./schema

WORKDIR /build

# Workspace manifests needed for `bun install` to resolve the graph.
COPY appstrate/package.json appstrate/bun.lock ./
COPY appstrate/patches/ patches/
COPY appstrate/packages/afps-runtime/package.json packages/afps-runtime/
COPY appstrate/packages/afps/types/package.json packages/afps/types/
COPY appstrate/packages/runner-pi/package.json packages/runner-pi/
COPY appstrate/runtime-pi/package.json runtime-pi/
COPY appstrate/runtime-pi/sidecar/package.json runtime-pi/sidecar/
# Other workspace members the root lockfile still references — empty stub
# manifests would also work, but copying the real ones keeps `bun install`
# strictly equivalent to a local install.
COPY appstrate/apps/api/package.json apps/api/
COPY appstrate/apps/cli/package.json apps/cli/
COPY appstrate/apps/web/package.json apps/web/
COPY appstrate/packages/core/package.json packages/core/
COPY appstrate/packages/connect/package.json packages/connect/
COPY appstrate/packages/db/package.json packages/db/
COPY appstrate/packages/emails/package.json packages/emails/
COPY appstrate/packages/env/package.json packages/env/
COPY appstrate/packages/shared-types/package.json packages/shared-types/
COPY appstrate/packages/ui/package.json packages/ui/
COPY appstrate/packages/afps/log/package.json packages/afps/log/
COPY appstrate/packages/afps/memory/package.json packages/afps/memory/
COPY appstrate/packages/afps/output/package.json packages/afps/output/
COPY appstrate/packages/afps/platform-compat/package.json packages/afps/platform-compat/
COPY appstrate/packages/afps/report/package.json packages/afps/report/
COPY appstrate/packages/afps/state/package.json packages/afps/state/
COPY appstrate/e2e/package.json e2e/

RUN bun install --frozen-lockfile

# ── Stage 2: Runtime ─────────────────────────────────────────────
FROM --platform=${TARGETPLATFORM:-linux/amd64} oven/bun:1.3.11-alpine

RUN apk add --no-cache git curl ca-certificates unzip python3 py3-pip bash

WORKDIR /runtime

# Root + workspace node_modules. Bun resolves per-workspace deps through
# `packages/<name>/node_modules` symlinks into the root `.bun/` store, so
# both layers are required for Bun to find packages at runtime.
COPY --from=deps /build/node_modules ./node_modules
COPY --from=deps /build/packages/afps-runtime/node_modules ./packages/afps-runtime/node_modules
COPY --from=deps /build/packages/runner-pi/node_modules ./packages/runner-pi/node_modules
COPY --from=deps /build/packages/afps/types/node_modules ./packages/afps/types/node_modules
COPY --from=deps /build/runtime-pi/node_modules ./runtime-pi/node_modules

# Workspace package sources — runner-pi, afps-runtime, and the @afps/types
# transitive dep are all source-only (no build step); Bun loads .ts directly.
COPY appstrate/packages/runner-pi/src /runtime/packages/runner-pi/src
COPY appstrate/packages/runner-pi/package.json /runtime/packages/runner-pi/
COPY appstrate/packages/afps-runtime/src /runtime/packages/afps-runtime/src
COPY appstrate/packages/afps-runtime/package.json /runtime/packages/afps-runtime/
COPY appstrate/packages/afps/types/src /runtime/packages/afps/types/src
COPY appstrate/packages/afps/types/package.json /runtime/packages/afps/types/

# Restore the workspace symlinks `bun install` materialised (docker COPY
# dereferences them). `node_modules/@appstrate/*` and `@afps/*` point at
# the workspace sources we just laid down.
RUN mkdir -p node_modules/@appstrate node_modules/@afps && \
    rm -rf node_modules/@appstrate/runner-pi node_modules/@appstrate/afps-runtime node_modules/@afps/types && \
    ln -sf /runtime/packages/runner-pi        node_modules/@appstrate/runner-pi && \
    ln -sf /runtime/packages/afps-runtime     node_modules/@appstrate/afps-runtime && \
    ln -sf /runtime/packages/afps/types       node_modules/@afps/types && \
    # runtime-pi/ package.json sits one level down on disk; link its
    # package-local node_modules tree to where the imports look for it.
    ln -sf /runtime/runtime-pi/node_modules /runtime/node_modules_runtime_pi

# Runtime-pi's own files.
COPY appstrate/runtime-pi/lib/ /runtime/lib/
COPY appstrate/runtime-pi/extensions/ /runtime/extensions/
COPY appstrate/runtime-pi/extension-wrapper.ts /runtime/extension-wrapper.ts
COPY appstrate/runtime-pi/entrypoint.ts /runtime/entrypoint.ts

RUN adduser -D -s /bin/bash pi && \
    mkdir -p /workspace && chown pi:pi /workspace && \
    ln -sf /runtime/node_modules /workspace/node_modules

USER pi

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD test -f /runtime/entrypoint.ts || exit 1

ENTRYPOINT ["bun", "run", "/runtime/entrypoint.ts"]
