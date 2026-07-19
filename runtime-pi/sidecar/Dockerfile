# syntax=docker/dockerfile:1.20
#
# Appstrate Sidecar — credential-isolating HTTP proxy for agent containers.
#
# Build from the repo root so the sidecar's `@appstrate/connect` +
# `@appstrate/afps-runtime` workspace deps resolve via the root bun.lock:
#
#   docker build \
#     -t appstrate-sidecar \
#     -f runtime-pi/sidecar/Dockerfile \
#     .
#
# No `--platform` flag: build the HOST architecture — an emulated amd64
# sidecar on an arm64 dev host takes ~1.6s to bind its forward proxy vs
# ~0.1s native, and that bind sits on the agent's boot critical path.
# CI's release pipeline builds its own multi-arch images via buildx.
#
# Paths below are relative to the repo root.

ARG BUN_IMAGE=oven/bun:1.3.14-alpine
ARG RUNTIME_IMAGE=alpine:3.21.3

# ── Stage 1 — compile to a single-file binary ─────────────────────
FROM ${BUN_IMAGE} AS builder

WORKDIR /build

# Root manifest + lockfile + EVERY workspace manifest referenced by the
# lockfile. `bun install --frozen-lockfile` walks the full graph, so any
# workspace package depended on transitively (e.g. apps/api → @appstrate/
# module-chat) must have its manifest on disk even when its sources aren't
# pulled. The `--parents` glob copies all of them at their real paths — same
# pattern as runtime-pi/Dockerfile — so a newly added workspace package never
# breaks this build (no hand-maintained list to forget to update).
COPY package.json bun.lock ./
COPY patches/ patches/
COPY --parents */package.json */*/package.json ./

# `--filter=appstrate-sidecar` restricts the install to the sidecar's
# subgraph. Same root lockfile, subset of the workspace.
#
# NOT `--frozen-lockfile` / `--production`: bun's frozen comparator has a known
# bug with same-name aliased platform binaries in the workspace graph — it
# false-reports "lockfile had changes" on a byte-stable lockfile (confirmed on
# bun 1.3.11 + 1.3.14, full graph + subset); `--production` implicitly freezes
# with no override flag in bun 1.3.x. Versions stay pinned by the COPY'd bun.lock
# (resolution reads it); lockfile drift is caught by the
# `git diff --exit-code bun.lock` guard in CI (.github/workflows/check.yml) on
# every commit.
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    bun install \
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
#   - @appstrate/runner-pi/runtime-tools      canonical run_history / recall_memory
#                                             descriptors (name + description +
#                                             parameter JSON Schema), imported by
#                                             mcp.ts to build the firstParty tool
#                                             advertisements. The `./runtime-tools`
#                                             subpath is pi-free (no pi-ai /
#                                             pi-coding-agent imports) so the
#                                             compiled binary stays minimal.
COPY packages/connect/src        packages/connect/src
COPY packages/afps-runtime/src   packages/afps-runtime/src
COPY packages/afps-shared/src    packages/afps-shared/src
COPY packages/mcp-transport/src  packages/mcp-transport/src
COPY packages/core/src           packages/core/src
COPY packages/runner-pi/src      packages/runner-pi/src

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
#   - docker-cli         used to spawn per-integration runner containers
#                        (`appstrate-mcp-runner-{node,python,binary,bun,uv}`) when
#                        a manifest declares `server.type: <runtime>`. The
#                        sidecar shells out to `docker run -i ...` and pipes
#                        stdio through to the runner; the runner image carries
#                        the language interpreter, never the sidecar itself.
#   - openssl            Phase 1.5 — mint the per-run CA + leaf certs for the
#                        MITM HTTPS proxy that injects integration credentials
#                        transparently on `delivery.http` auths. Without
#                        openssl, sidecar falls back to env-delivery only and
#                        in-run OAuth refresh is unavailable for those auths.
# `wget` ships with busybox in Alpine → HEALTHCHECK adds no install cost.
RUN apk add --no-cache libstdc++ libgcc ca-certificates docker-cli openssl

COPY --from=builder --chmod=0555 /build/runtime-pi/sidecar/sidecar /usr/local/bin/sidecar
COPY --chmod=0444 runtime-pi/sidecar/browser-seccomp.json /usr/local/share/appstrate/browser-seccomp.json
COPY --chmod=0444 runtime-pi/sidecar/browser-seccomp.NOTICE.md /usr/local/share/appstrate/browser-seccomp.NOTICE.md

USER nobody:nobody

EXPOSE 8080 8081

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/usr/local/bin/sidecar"]
