# syntax=docker/dockerfile:1.20
# Requires BuildKit (Docker 23+, or DOCKER_BUILDKIT=1) — the `COPY --parents` directives below are BuildKit-only.
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
# subgraph (Pi + Claude + Codex SDKs, @appstrate/afps-runtime, the three
# @appstrate/runner-* packages + their transitive deps), excluding apps/api,
# apps/web, and the workspace dev toolchain — the runtime image ships only the
# runtime subgraph, not the full workspace tree. runtime-pi has no devDeps of
# its own and `--filter` does not pull transitive workspace pkgs' devDeps, so
# `--production` would be a no-op for what's installed here — we omit it.
#
# NOT `--frozen-lockfile`: bun's frozen comparator has a bug with @openai/codex's
# same-name aliased platform binaries (@openai/codex@0.141.0-<platform>) and
# false-reports "lockfile had changes" on a byte-stable lockfile — confirmed on
# bun 1.3.11 and 1.3.14, and on both the full graph and a `--filter` subset.
# `--production` makes it unfixable here: it implicitly freezes with no override
# flag in bun 1.3.x. Versions stay pinned because resolution still reads the
# COPY'd bun.lock; lockfile drift is caught by the `git diff --exit-code bun.lock`
# guard in CI (.github/workflows/check.yml) on every commit.
# Kill-switch build arg (ToS): the subscription engines' vendor SDKs + CLIs
# (@anthropic-ai/claude-agent-sdk, @openai/codex) and the runner-claude/
# runner-codex packages are `optionalDependencies`. `--build-arg
# INCLUDE_SUBSCRIPTION_ENGINES=false` omits them, producing a pi-only image with
# zero vendor executable surface (the runtime already gates the runners by
# RUN_ENGINE, so a pi run never loads them). Default `true` keeps the full image
# byte-identical. NOTE: the slim (`false`) path is UNVERIFIED here — must be
# docker-built + booted in CI before relying on it.
ARG INCLUDE_SUBSCRIPTION_ENGINES=true
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    bun install \
        --filter=appstrate-pi-runtime \
        --no-progress \
        $([ "$INCLUDE_SUBSCRIPTION_ENGINES" = "false" ] && echo "--omit=optional")

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
COPY packages/runner-claude/src   packages/runner-claude/src
COPY packages/runner-codex/src    packages/runner-codex/src
COPY runtime-pi/extensions/       runtime-pi/extensions/
COPY runtime-pi/mcp/              runtime-pi/mcp/
COPY runtime-pi/*.ts              runtime-pi/

# `@anthropic-ai/claude-agent-sdk` is kept `--external` (like the Pi SDK pair):
# the ClaudeAgentRunner `await import`s it lazily (only for `claude-code` runs),
# it ships its own prebuilt per-arch binary resolved at runtime from node_modules
# via `pathToClaudeCodeExecutable`, and bundling its dynamic provider dispatch
# inlines transient modules that hurt cold-start. The symlinked package + its
# musl binary sibling remain on disk in the runtime stage so the lazy import +
# `resolveClaudeCodeBinary` resolve at runtime.
RUN bun build runtime-pi/entrypoint.ts \
        --target=bun \
        --external='@mariozechner/pi-ai' \
        --external='@mariozechner/pi-coding-agent' \
        --external='@anthropic-ai/claude-agent-sdk' \
        --outfile=runtime-pi/dist/entrypoint.js

# ── Stage 2 — runtime ─────────────────────────────────────────────
FROM ${BUN_IMAGE} AS runtime

# Standard OCI image metadata. CI passes real values via --build-arg.
ARG BUILD_VERSION=unknown
ARG BUILD_REVISION=unknown
ARG BUILD_CREATED

# Re-declared in this stage (ARGs are stage-scoped) so the vendor-SDK symlink
# steps below can be skipped for a pi-only slim image. Default `true` → full
# image, every step below runs exactly as before.
ARG INCLUDE_SUBSCRIPTION_ENGINES=true

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
# runner-claude is source-only with no extra runtime deps of its own (its
# imports are workspace packages already present + the external Agent SDK), so
# only its src + manifest + workspace symlink are needed.
COPY --chown=pi:pi packages/runner-claude/src           ./packages/runner-claude/src
COPY --chown=pi:pi packages/runner-claude/package.json  ./packages/runner-claude/
# runner-codex is source-only with no extra runtime deps of its own (workspace
# packages already present + the external Codex CLI binary), so only its src +
# manifest + workspace symlink are needed.
COPY --chown=pi:pi packages/runner-codex/src            ./packages/runner-codex/src
COPY --chown=pi:pi packages/runner-codex/package.json   ./packages/runner-codex/
COPY --chown=pi:pi packages/core/src                    ./packages/core/src
COPY --chown=pi:pi packages/core/package.json           ./packages/core/
COPY --chown=pi:pi packages/afps-shared/src             ./packages/afps-shared/src
COPY --chown=pi:pi packages/afps-shared/package.json    ./packages/afps-shared/

# Restore the `@appstrate/*` workspace symlinks materialised by
# `bun install` (docker COPY dereferences them into real directories).
RUN mkdir -p node_modules/@appstrate \
 && rm -rf  node_modules/@appstrate/afps-runtime node_modules/@appstrate/afps-shared node_modules/@appstrate/mcp-transport node_modules/@appstrate/runner-pi node_modules/@appstrate/runner-claude node_modules/@appstrate/runner-codex node_modules/@appstrate/core \
 && ln -s   /runtime/packages/afps-runtime  node_modules/@appstrate/afps-runtime \
 && ln -s   /runtime/packages/afps-shared   node_modules/@appstrate/afps-shared \
 && ln -s   /runtime/packages/mcp-transport node_modules/@appstrate/mcp-transport \
 && ln -s   /runtime/packages/runner-pi     node_modules/@appstrate/runner-pi \
 && ln -s   /runtime/packages/runner-claude node_modules/@appstrate/runner-claude \
 && ln -s   /runtime/packages/runner-codex  node_modules/@appstrate/runner-codex \
 && ln -s   /runtime/packages/core          node_modules/@appstrate/core \
 && chown -h pi:pi \
        node_modules/@appstrate \
        node_modules/@appstrate/afps-runtime \
        node_modules/@appstrate/afps-shared \
        node_modules/@appstrate/mcp-transport \
        node_modules/@appstrate/runner-pi \
        node_modules/@appstrate/runner-claude \
        node_modules/@appstrate/runner-codex \
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

# The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) is a direct dep of
# `appstrate-pi-runtime`, so bun symlinks it into runtime-pi/node_modules. The
# bundled entrypoint resolves from /runtime/node_modules, so surface it there
# (same fix as the Pi pair above). The SDK's per-arch `claude` binary lives
# beside it in the shared .bun store and `resolveClaudeCodeBinary` hops to it
# through the SDK's own scope — no separate symlink needed for the binary.
# Skipped on a slim (`INCLUDE_SUBSCRIPTION_ENGINES=false`) build — the SDK is not
# installed then, so there is nothing to surface.
RUN if [ "$INCLUDE_SUBSCRIPTION_ENGINES" = "true" ]; then \
      mkdir -p node_modules/@anthropic-ai \
   && ln -s /runtime/runtime-pi/node_modules/@anthropic-ai/claude-agent-sdk node_modules/@anthropic-ai/claude-agent-sdk \
   && chown -h pi:pi \
          node_modules/@anthropic-ai \
          node_modules/@anthropic-ai/claude-agent-sdk; \
    fi

# The Codex CLI (`@openai/codex`) is a direct dep of `appstrate-pi-runtime`, so
# bun symlinks it into runtime-pi/node_modules. The bundled entrypoint resolves
# from /runtime/node_modules, so surface it there (same pattern as the Claude
# SDK above). `resolveCodexBinary` hops through the main package's scope to its
# per-arch `@openai/codex-<plat>-<arch>` optional-dep sibling (a musl-static
# binary that runs on Alpine), so no separate symlink is needed for that sibling.
# Skipped on a slim (`INCLUDE_SUBSCRIPTION_ENGINES=false`) build — the CLI is not
# installed then, so there is nothing to surface.
RUN if [ "$INCLUDE_SUBSCRIPTION_ENGINES" = "true" ]; then \
      mkdir -p node_modules/@openai \
   && ln -s /runtime/runtime-pi/node_modules/@openai/codex node_modules/@openai/codex \
   && chown -h pi:pi \
          node_modules/@openai \
          node_modules/@openai/codex; \
    fi

# Belt-and-suspenders: also expose the resolved musl `codex` binary on PATH at
# /usr/local/bin/codex, so the runner's final fallback (bare `codex`) works even
# if the per-arch scope resolution ever fails. Primary path stays
# `resolveCodexBinary`; this is a safety net only. Done as root before USER pi.
RUN if [ "$INCLUDE_SUBSCRIPTION_ENGINES" = "true" ]; then set -e; \
      CODEX_BIN="$(find /runtime/node_modules /runtime/runtime-pi/node_modules -path '*vendor/*-linux-musl/bin/codex' -type f 2>/dev/null | head -1)"; \
      if [ -n "$CODEX_BIN" ]; then chmod +x "$CODEX_BIN"; ln -sf "$CODEX_BIN" /usr/local/bin/codex; echo "codex binary on PATH -> $CODEX_BIN"; else echo "WARN: codex musl binary not found at build time"; fi; \
    fi

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
