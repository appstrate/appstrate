# syntax=docker/dockerfile:1.7
#
# Appstrate Pi — AI agent runtime for ephemeral agent runs.
#
# Build from the repo root so the workspace graph (`@appstrate/*`
# workspace:* specs) resolves identically to local installs:
#
#   docker build --platform linux/amd64 \
#     -t appstrate-pi \
#     -f runtime-pi/Dockerfile \
#     .
#
# All paths below are relative to the repo root.

ARG BUN_IMAGE=oven/bun:1.3.11-alpine

# ── Stage 1 — dependency install ──────────────────────────────────
# Produces a runtime-pi-scoped `node_modules` tree (filter-installed
# from the root lockfile). Kept separate so the install layer caches
# independently of source changes.
FROM ${BUN_IMAGE} AS deps

WORKDIR /build

# Root manifest + lockfile. Every workspace member referenced by the
# lockfile must have its manifest on disk — `bun install --frozen-lockfile`
# walks the full graph even when only a subset is needed at runtime.
COPY package.json bun.lock ./
COPY patches/ patches/
COPY packages/afps-runtime/package.json  packages/afps-runtime/
COPY packages/connect/package.json       packages/connect/
COPY packages/core/package.json          packages/core/
COPY packages/db/package.json            packages/db/
COPY packages/emails/package.json        packages/emails/
COPY packages/env/package.json           packages/env/
COPY packages/mcp-transport/package.json packages/mcp-transport/
COPY packages/runner-pi/package.json     packages/runner-pi/
COPY packages/shared-types/package.json  packages/shared-types/
COPY packages/ui/package.json            packages/ui/
COPY apps/api/package.json               apps/api/
COPY apps/cli/package.json               apps/cli/
COPY apps/web/package.json               apps/web/
COPY runtime-pi/package.json             runtime-pi/
COPY runtime-pi/sidecar/package.json     runtime-pi/sidecar/
COPY e2e/package.json                    e2e/

# `--filter=appstrate-pi-runtime` restricts the install to runtime-pi's
# subgraph (Pi SDK pair + @appstrate/afps-runtime + @appstrate/runner-pi
# + their transitive deps). Pulls the same versions as the root lock
# (`--frozen-lockfile`) without installing apps/api / apps/web / dev
# toolchain — the runtime image ships ~190 MB of node_modules instead
# of the full ~860 MB workspace tree.
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    bun install \
        --frozen-lockfile \
        --production \
        --filter=appstrate-pi-runtime \
        --no-progress

# ── Stage 2 — runtime ─────────────────────────────────────────────
FROM ${BUN_IMAGE} AS runtime

# Standard OCI image metadata. CI passes real values via --build-arg.
ARG BUILD_VERSION=unknown
ARG BUILD_REVISION=unknown
ARG BUILD_CREATED

LABEL org.opencontainers.image.title="Appstrate Pi" \
      org.opencontainers.image.description="AI agent runtime for ephemeral agent runs" \
      org.opencontainers.image.source="https://github.com/appstrate/appstrate" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="Appstrate" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.created="${BUILD_CREATED}"

# Runtime-only packages:
#   - bash             Pi coding-agent's bash tool
#   - git              `git init` on workspace cold start
#   - curl             agent-side HTTP helper (referenced in platform prompt)
#   - ca-certificates  TLS trust store for outbound LLM / provider calls
#   - python3, py3-pip tool compatibility for Python-based agent tools
#
# Create the unprivileged `pi` user in the same layer so subsequent
# `COPY --chown=pi:pi` resolves without a separate chown pass.
RUN apk add --no-cache \
        bash \
        ca-certificates \
        curl \
        git \
        python3 \
        py3-pip \
 && addgroup -g 1001 pi \
 && adduser  -D -u 1001 -G pi -s /bin/bash pi

WORKDIR /runtime

# Workspace node_modules. Bun stores shared deps at the root and links
# per-package trees into it — both levels are required at import time.
COPY --from=deps --chown=pi:pi /build/node_modules                       ./node_modules
COPY --from=deps --chown=pi:pi /build/packages/afps-runtime/node_modules  ./packages/afps-runtime/node_modules
COPY --from=deps --chown=pi:pi /build/packages/mcp-transport/node_modules ./packages/mcp-transport/node_modules
COPY --from=deps --chown=pi:pi /build/packages/runner-pi/node_modules     ./packages/runner-pi/node_modules
COPY --from=deps --chown=pi:pi /build/runtime-pi/node_modules             ./runtime-pi/node_modules

# Workspace sources — `@appstrate/afps-runtime`, `@appstrate/mcp-transport`,
# and `@appstrate/runner-pi` are source-only (Bun loads .ts directly, no
# build step).
COPY --chown=pi:pi packages/afps-runtime/src            ./packages/afps-runtime/src
COPY --chown=pi:pi packages/afps-runtime/package.json   ./packages/afps-runtime/
COPY --chown=pi:pi packages/mcp-transport/src           ./packages/mcp-transport/src
COPY --chown=pi:pi packages/mcp-transport/package.json  ./packages/mcp-transport/
COPY --chown=pi:pi packages/runner-pi/src               ./packages/runner-pi/src
COPY --chown=pi:pi packages/runner-pi/package.json      ./packages/runner-pi/

# Restore the `@appstrate/*` workspace symlinks materialised by
# `bun install` (docker COPY dereferences them into real directories).
RUN mkdir -p node_modules/@appstrate \
 && rm -rf  node_modules/@appstrate/afps-runtime node_modules/@appstrate/mcp-transport node_modules/@appstrate/runner-pi \
 && ln -s   /runtime/packages/afps-runtime  node_modules/@appstrate/afps-runtime \
 && ln -s   /runtime/packages/mcp-transport node_modules/@appstrate/mcp-transport \
 && ln -s   /runtime/packages/runner-pi     node_modules/@appstrate/runner-pi \
 && chown -h pi:pi \
        node_modules/@appstrate \
        node_modules/@appstrate/afps-runtime \
        node_modules/@appstrate/mcp-transport \
        node_modules/@appstrate/runner-pi

# Pi SDK pair (@mariozechner/pi-ai, @mariozechner/pi-coding-agent) lands
# in runtime-pi/node_modules per bun's hoisting decisions. Extension
# and MCP utility scripts under /runtime/{extensions,mcp}/ resolve from
# /runtime/node_modules, so symlink the SDK pair to make import
# resolution work.
RUN mkdir -p node_modules/@mariozechner \
 && ln -s /runtime/runtime-pi/node_modules/@mariozechner/pi-ai           node_modules/@mariozechner/pi-ai \
 && ln -s /runtime/runtime-pi/node_modules/@mariozechner/pi-coding-agent node_modules/@mariozechner/pi-coding-agent \
 && chown -h pi:pi \
        node_modules/@mariozechner \
        node_modules/@mariozechner/pi-ai \
        node_modules/@mariozechner/pi-coding-agent

# Bootstrap sources.
COPY --chown=pi:pi runtime-pi/extensions/          ./extensions/
COPY --chown=pi:pi runtime-pi/mcp/                 ./mcp/
COPY --chown=pi:pi runtime-pi/extension-wrapper.ts ./extension-wrapper.ts
COPY --chown=pi:pi runtime-pi/tee-sink.ts          ./tee-sink.ts
COPY --chown=pi:pi runtime-pi/env.ts               ./env.ts
COPY --chown=pi:pi runtime-pi/entrypoint.ts        ./entrypoint.ts

# Agent workspace. AFPS tools ship pre-bundled with their deps inlined
# (AFPS §3.4, via `@appstrate/core/tool-bundler`), so nothing under
# `/workspace` needs to resolve against npm packages. The only
# externals the bundled entrypoints keep are the Pi SDK pair, resolved
# from `/runtime/packages/runner-pi/node_modules` by `prepareBundleForPi`.
RUN mkdir -p /workspace && chown pi:pi /workspace

USER pi:pi

# Entrypoint failures (missing bundle, malformed env) produce an
# immediate non-zero exit after posting an `appstrate.error` event to
# the platform's HTTP sink — the container lifecycle reports health,
# no separate probe endpoint is needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD test -f /runtime/entrypoint.ts || exit 1

ENTRYPOINT ["bun", "run", "/runtime/entrypoint.ts"]
