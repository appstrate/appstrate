# syntax=docker/dockerfile:1.20
# Requires BuildKit (Docker 23+, or DOCKER_BUILDKIT=1) — the `COPY --parents` directives below are BuildKit-only.
#
# Appstrate Pi — AI agent runtime for ephemeral agent runs.
#
# Build from the repo root so the workspace graph (`@appstrate/*`
# workspace:* specs) resolves identically to local installs:
#
#   docker build \
#     -t appstrate-pi \
#     -f runtime-pi/Dockerfile \
#     .
#
# No `--platform` flag: build the HOST architecture. Running an amd64 image
# on an arm64 dev host (Apple Silicon) goes through Rosetta/QEMU emulation
# and multiplies container cold start ~4x (measured: runtime ready 3.8s
# emulated vs 1.2s native). CI's release pipeline builds its own multi-arch
# (amd64+arm64) images via buildx — it does not use this default.
#
# All paths below are relative to the repo root.

ARG BUN_IMAGE=oven/bun:1.3.14-alpine

# ── Stage 1 — dependency install ──────────────────────────────────
# Produces a runtime-pi-scoped `node_modules` tree (filter-installed
# from the root lockfile). Kept separate so the install layer caches
# independently of source changes.
FROM ${BUN_IMAGE} AS deps

WORKDIR /build

# Root manifest + lockfile. Every workspace member referenced by the
# lockfile must have its manifest on disk — `bun install --frozen-lockfile`
# walks the full graph even when only a subset is needed at runtime.
#
# `COPY --parents` (stable since dockerfile 1.20) preserves each match's
# directory structure, so the member manifests are derived from the monorepo
# graph instead of a hand-maintained list:
#   */package.json    → runtime-pi, e2e            (depth-1 members)
#   */*/package.json  → apps/*, packages/*, runtime-pi/sidecar  (depth-2)
# Adding a new workspace package requires ZERO edits here.
COPY package.json bun.lock ./
COPY --parents */package.json */*/package.json ./
COPY patches/ patches/

# `--filter=appstrate-pi-runtime` restricts the install to runtime-pi's
# subgraph (the Pi SDK pair, @appstrate/afps-runtime, @appstrate/runner-pi
# + their transitive deps), excluding apps/api, apps/web, and the
# workspace dev toolchain — the runtime image ships only the runtime subgraph,
# not the full workspace tree. runtime-pi has no devDeps of its own and
# `--filter` does not pull transitive workspace pkgs' devDeps, so `--production`
# would be a no-op for what's installed here — we omit it.
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    bun install \
        --filter=appstrate-pi-runtime \
        --no-progress

# Pre-bundle the entrypoint to a single .js file. This collapses the
# 522-module ESM resolution graph (workspace symlinks + nested
# node_modules) into a single file that Bun loads in one read — shaving
# ~100-300 ms off container cold start.
#
# The Pi SDK pair (@mariozechner/pi-ai, @mariozechner/pi-coding-agent)
# is kept `--external` deliberately. The SDK is large (~10 MB
# bundled), uses dynamic provider dispatch, and we have observed
# bundling it inlines transient modules that hurt rather than help.
# Symlinks for the SDK pair remain on disk in the runtime stage so the
# `--external` import resolves at runtime via the same path the
# unbundled entrypoint used.
#
# Workspace sources for `@appstrate/*` packages are bundled inline,
# which is why those symlinks become optional below (we keep them for
# safety since other scripts under /runtime/{extensions,mcp}/ still
# import via the symlinked paths).
COPY packages/afps-runtime/src    packages/afps-runtime/src
COPY packages/afps-shared/src     packages/afps-shared/src
COPY packages/connect/src         packages/connect/src
COPY packages/core/src            packages/core/src
COPY packages/mcp-transport/src   packages/mcp-transport/src
COPY packages/runner-pi/src       packages/runner-pi/src
COPY runtime-pi/extensions/       runtime-pi/extensions/
COPY runtime-pi/mcp/              runtime-pi/mcp/
COPY runtime-pi/*.ts              runtime-pi/

RUN bun build runtime-pi/entrypoint.ts \
        --target=bun \
        --external='@mariozechner/pi-ai' \
        --external='@mariozechner/pi-coding-agent' \
        --outfile=runtime-pi/dist/entrypoint.js

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

# Pin the production environment (standard tooling hygiene).
ENV NODE_ENV=production

# Runtime-only packages:
#   - bash             Pi coding-agent's bash tool
#   - git              `git init` on workspace cold start
#   - curl             agent-side HTTP helper (referenced in platform prompt)
#   - ca-certificates  TLS trust store for outbound LLM / provider calls
#   - python3, py3-pip tool compatibility for Python-based agent tools
#
# Python isolation via virtualenv (/opt/agent-venv on PATH). Solves three
# overlapping problems in one move:
#   1. PEP 370 — `pip install --user X; import X` in the same process used
#      to fail because Alpine doesn't pre-create ~/.local/lib/pythonX.Y/
#      site-packages, so site.py wouldn't add it to sys.path at boot.
#   2. PEP 668 — modern Alpine flags the system Python as
#      "externally-managed", so plain `pip install` against system Python
#      is rejected without --break-system-packages.
#   3. Python version drift — pre-creating .local/lib/python3.12 hardcoded
#      a version that silently breaks if Alpine bumps Python.
# A venv sidesteps all three: it's never externally-managed, sys.path is
# rooted in the venv's own site-packages (always present), and the path
# self-aligns with whatever python3 ships in the base image.
#
# Common data libraries are baked into the venv (#628, #316 items 2-3):
#   - openpyxl   Excel read/write — concrete demand from office-automation
#                skills (edi-order-parser, orgabusiness-export-compta)
#   - pandas     tabular data wrangling (CSV/Excel pipelines)
#   - requests   de-facto HTTP client that generated Python assumes exists
#   - pypdf2     PDF read/split/merge (PyPDF2 3.0.1 is the final release —
#                superseded by pypdf, but skills and LLMs still
#                `import PyPDF2` by that name, so we ship what they import)
# Pre-installing costs ~150 MB uncompressed (pandas + numpy dominate;
# the other three total <10 MB) but removes a cold `pip install`
# (5-15 s) plus a ModuleNotFoundError retry loop from every run that
# touches spreadsheets or PDFs. Versions are deliberately
# unpinned: they resolve at image build time and the image is immutable
# per release tag, so runs are reproducible without a pin list to
# maintain. All four ship pure-python or musllinux wheels — no build
# toolchain (gcc, musl-dev) is needed in the image.
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
 && adduser  -D -u 1001 -G pi -s /bin/bash pi \
 && python3 -m venv /opt/agent-venv \
 && /opt/agent-venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/agent-venv/bin/pip install --no-cache-dir openpyxl pandas requests pypdf2 \
 && chown -R pi:pi /opt/agent-venv

# Put the venv first on PATH so `python3` and `pip` resolve to the venv
# binaries from any process the agent spawns. VIRTUAL_ENV is the
# canonical signal consulted by tools (pip, poetry, uv) to confirm
# they're operating inside an active environment.
ENV VIRTUAL_ENV=/opt/agent-venv \
    PATH="/opt/agent-venv/bin:${PATH}"

WORKDIR /runtime

# Workspace node_modules. Bun stores shared deps at the root and links
# per-package trees into it — both levels are required at import time.
COPY --from=deps --chown=pi:pi /build/node_modules                       ./node_modules
COPY --from=deps --chown=pi:pi /build/packages/afps-runtime/node_modules  ./packages/afps-runtime/node_modules
COPY --from=deps --chown=pi:pi /build/packages/core/node_modules          ./packages/core/node_modules
COPY --from=deps --chown=pi:pi /build/packages/mcp-transport/node_modules ./packages/mcp-transport/node_modules
COPY --from=deps --chown=pi:pi /build/packages/runner-pi/node_modules     ./packages/runner-pi/node_modules
COPY --from=deps --chown=pi:pi /build/runtime-pi/node_modules             ./runtime-pi/node_modules

# Workspace sources — `@appstrate/afps-runtime`, `@appstrate/mcp-transport`,
# `@appstrate/runner-pi`, and `@appstrate/core` are source-only (Bun loads
# .ts directly, no build step). `core` is consumed via `@appstrate/core/errors`
# and `@appstrate/core/{form,naming,…}` by entrypoint.ts, extension-wrapper.ts,
# env.ts, and the MCP upload helpers.
COPY --chown=pi:pi packages/afps-runtime/src            ./packages/afps-runtime/src
COPY --chown=pi:pi packages/afps-runtime/package.json   ./packages/afps-runtime/
COPY --chown=pi:pi packages/mcp-transport/src           ./packages/mcp-transport/src
COPY --chown=pi:pi packages/mcp-transport/package.json  ./packages/mcp-transport/
COPY --chown=pi:pi packages/runner-pi/src               ./packages/runner-pi/src
COPY --chown=pi:pi packages/runner-pi/package.json      ./packages/runner-pi/
COPY --chown=pi:pi packages/core/src                    ./packages/core/src
COPY --chown=pi:pi packages/core/package.json           ./packages/core/
COPY --chown=pi:pi packages/afps-shared/src             ./packages/afps-shared/src
COPY --chown=pi:pi packages/afps-shared/package.json    ./packages/afps-shared/

# Restore the `@appstrate/*` workspace symlinks materialised by
# `bun install` (docker COPY dereferences them into real directories).
RUN mkdir -p node_modules/@appstrate \
 && rm -rf  node_modules/@appstrate/afps-runtime node_modules/@appstrate/afps-shared node_modules/@appstrate/mcp-transport node_modules/@appstrate/runner-pi node_modules/@appstrate/core \
 && ln -s   /runtime/packages/afps-runtime  node_modules/@appstrate/afps-runtime \
 && ln -s   /runtime/packages/afps-shared   node_modules/@appstrate/afps-shared \
 && ln -s   /runtime/packages/mcp-transport node_modules/@appstrate/mcp-transport \
 && ln -s   /runtime/packages/runner-pi     node_modules/@appstrate/runner-pi \
 && ln -s   /runtime/packages/core          node_modules/@appstrate/core \
 && chown -h pi:pi \
        node_modules/@appstrate \
        node_modules/@appstrate/afps-runtime \
        node_modules/@appstrate/afps-shared \
        node_modules/@appstrate/mcp-transport \
        node_modules/@appstrate/runner-pi \
        node_modules/@appstrate/core

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

# Bootstrap sources. Glob is single-level (no recursion into `sidecar/`
# or `test/`), so adding a new `.ts` file at `runtime-pi/*.ts` is picked
# up automatically — no Dockerfile edit required.
#
# Both the original `.ts` sources and the pre-bundled `dist/entrypoint.js`
# are copied — the bundle is the production entrypoint, while the `.ts`
# sources remain on disk so the MCP / extensions glob imports
# (`./extensions/*.ts`, `./mcp/*.ts`) still resolve when the bundle
# delegates to them at runtime.
COPY --chown=pi:pi runtime-pi/extensions/ ./extensions/
COPY --chown=pi:pi runtime-pi/mcp/        ./mcp/
COPY --chown=pi:pi runtime-pi/*.ts        ./
COPY --from=deps --chown=pi:pi /build/runtime-pi/dist/entrypoint.js ./dist/entrypoint.js

# Pre-warmed Bun transpiler cache (issue #835). Bun re-parses every JS file
# >50 KB on each process start — for the 1.6 MB bundled entrypoint plus the
# external Pi SDK dist files that is a large share of the per-run cold start,
# and on the firecracker adapter (VM-per-run, empty guest page cache) it is
# paid on EVERY run. Baking the cache into the image turns that parse into a
# single mmap-able `.pile` read. Priming = actually loading the module graph
# with the cache path set: the entrypoint run exits 1 on env validation
# (expected — AFTER the full static graph evaluated), then the lazily-imported
# SDKs are loaded explicitly. Entries are keyed by content hash + Bun version,
# so a stale cache is ignored, never wrong.
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=/runtime/.transpiler-cache
RUN mkdir -p /runtime/.transpiler-cache \
 && (bun /runtime/dist/entrypoint.js > /dev/null 2>&1 || true) \
 && bun -e 'await import("@mariozechner/pi-ai"); await import("@mariozechner/pi-coding-agent");' \
 # Fail the build if priming produced nothing — an empty cache would be a
 # silent cold-start regression (the entrypoint run above swallows its exit
 # code by design, so this is the only guard that the graph actually loaded).
 && [ -n "$(ls -A /runtime/.transpiler-cache)" ] \
 && chown -R pi:pi /runtime/.transpiler-cache

# Agent workspace. Bundled package entrypoints keep only the Pi SDK
# pair external, resolved from `/runtime/packages/runner-pi/node_modules`
# by `prepareBundleForPi`, so nothing under `/workspace` needs to
# resolve against npm packages.
RUN mkdir -p /workspace && chown pi:pi /workspace

USER pi:pi

# Entrypoint failures (missing bundle, malformed env) produce an
# immediate non-zero exit after posting an `appstrate.error` event to
# the platform's HTTP sink — the container lifecycle reports health,
# no separate probe endpoint is needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD test -f /runtime/dist/entrypoint.js || exit 1

ENTRYPOINT ["bun", "run", "/runtime/dist/entrypoint.js"]
