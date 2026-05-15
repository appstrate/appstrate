# syntax=docker/dockerfile:1.7
#
# Appstrate Sidecar — credential-isolating HTTP proxy for agent containers.
#
# Build from the repo root so the sidecar's `@appstrate/connect` +
# `@appstrate/afps-runtime` workspace deps resolve via the root bun.lock:
#
#   docker build --platform linux/amd64 \
#     -t appstrate-sidecar \
#     -f runtime-pi/sidecar/Dockerfile \
#     .
#
# Paths below are relative to the repo root.

ARG BUN_IMAGE=oven/bun:1.3.14-alpine
ARG RUNTIME_IMAGE=alpine:3.21.3

# ── Stage 1 — compile to a single-file binary ─────────────────────
FROM ${BUN_IMAGE} AS builder

WORKDIR /build

# Root manifest + lockfile + every workspace manifest referenced by the
# lockfile. `bun install --frozen-lockfile` walks the full graph; stub
# manifests satisfy the walker without pulling unused sources.
COPY package.json bun.lock ./
COPY patches/ patches/
COPY packages/afps-runtime/package.json  packages/afps-runtime/
COPY packages/connect/package.json       packages/connect/
COPY packages/core/package.json          packages/core/
COPY packages/db/package.json            packages/db/
COPY packages/emails/package.json        packages/emails/
COPY packages/env/package.json           packages/env/
COPY packages/mcp-transport/package.json     packages/mcp-transport/
COPY packages/module-claude-code/package.json packages/module-claude-code/
COPY packages/module-codex/package.json      packages/module-codex/
COPY packages/runner-pi/package.json     packages/runner-pi/
COPY packages/shared-types/package.json  packages/shared-types/
COPY packages/ui/package.json            packages/ui/
COPY apps/api/package.json               apps/api/
COPY apps/cli/package.json               apps/cli/
COPY apps/web/package.json               apps/web/
COPY runtime-pi/package.json             runtime-pi/
COPY runtime-pi/sidecar/package.json     runtime-pi/sidecar/
COPY e2e/package.json                    e2e/

# `--filter=appstrate-sidecar` restricts the install to the sidecar's
# subgraph. Same root lockfile, subset of the workspace.
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    bun install \
        --frozen-lockfile \
        --production \
        --filter=appstrate-sidecar \
        --no-progress

# Workspace sources consumed at `bun build --compile` time:
#   - @appstrate/connect/proxy-primitives     shared URL matchers + header filter
#   - @appstrate/afps-runtime/resolvers       `matchesAuthorizedUriSpec`, re-exported
#                                             by proxy-primitives
#   - @appstrate/mcp-transport                MCP adapter on the official SDK,
#                                             used by mcp.ts to expose `tools/*`
#   - @appstrate/core/{errors,ssrf}           getErrorMessage + isBlockedHost/Url,
#                                             imported by credential-proxy.ts /
#                                             mcp.ts / ssrf.ts
COPY packages/connect/src        packages/connect/src
COPY packages/afps-runtime/src   packages/afps-runtime/src
COPY packages/mcp-transport/src  packages/mcp-transport/src
COPY packages/core/src           packages/core/src

# Sidecar sources. Glob is single-level (no recursion into `test/`),
# so adding a new `.ts` file at `runtime-pi/sidecar/*.ts` is picked up
# automatically — no Dockerfile edit required.
COPY runtime-pi/sidecar/*.ts runtime-pi/sidecar/

WORKDIR /build/runtime-pi/sidecar
RUN bun build --compile --minify server.ts --outfile sidecar

# ── Stage 2 — minimal runtime ─────────────────────────────────────
FROM ${RUNTIME_IMAGE} AS runtime

ARG BUILD_VERSION=unknown
ARG BUILD_REVISION=unknown
ARG BUILD_CREATED

LABEL org.opencontainers.image.title="Appstrate Sidecar" \
      org.opencontainers.image.description="Credential-isolating HTTP proxy for agent containers" \
      org.opencontainers.image.source="https://github.com/appstrate/appstrate" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="Appstrate" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.created="${BUILD_CREATED}"

# Runtime dependencies:
#   - libstdc++, libgcc  glibc-like symbols the Bun-compiled binary links against
#   - ca-certificates    TLS trust store for outbound provider calls
# `wget` ships with busybox in Alpine → HEALTHCHECK adds no install cost.
RUN apk add --no-cache libstdc++ libgcc ca-certificates

COPY --from=builder --chmod=0555 /build/runtime-pi/sidecar/sidecar /usr/local/bin/sidecar

USER nobody:nobody

EXPOSE 8080 8081

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/usr/local/bin/sidecar"]
