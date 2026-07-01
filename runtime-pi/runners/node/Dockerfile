# syntax=docker/dockerfile:1.7
#
# Appstrate MCP Runner — Node.js
#
# Spawned per-integration by the sidecar (`runtime-pi/sidecar/integrations-boot.ts`)
# when an AFPS integration manifest declares `server.type: "node"`. The
# sidecar `docker create`s this image, `docker cp`s the integration bundle
# into `/bundle`, and `docker start -ai`s the container — stdio is piped
# verbatim to the spawning MCP client.
#
# Why a dedicated image (vs. baking node into the sidecar): a `python`
# integration would otherwise demand `apk add python3` in the sidecar
# (then ruby, deno, …). Per-runtime images keep the sidecar minimal and
# let operators pull only the runtimes they actually use.
#
# Build for the HOST architecture (the sidecar's `docker run` pins no
# platform; an emulated runner pays a ~4x cold-start penalty on the
# per-integration 30s connect deadline). CI builds multi-arch via buildx.
#
#   docker build \
#     -t appstrate-mcp-runner-node:latest \
#     -f runtime-pi/runners/node/Dockerfile \
#     runtime-pi/runners/node

ARG RUNTIME_IMAGE=alpine:3.21.3

# Build the universal egress proxy shim's deps (appstrate/appstrate#779).
# Pure-JS packages, portable across node minor versions to the runtime stage.
FROM node:20-alpine AS proxydeps
WORKDIR /opt/appstrate/proxy
RUN npm init -y >/dev/null 2>&1 && \
    npm install --omit=dev --no-audit --no-fund \
      undici@6 https-proxy-agent@7 http-proxy-agent@7

FROM ${RUNTIME_IMAGE} AS runtime

ARG BUILD_VERSION=unknown
ARG BUILD_REVISION=unknown
ARG BUILD_CREATED

LABEL org.opencontainers.image.title="Appstrate MCP Runner (Node)" \
      org.opencontainers.image.description="Per-integration Node.js runner for AFPS server.type=\"node\"" \
      org.opencontainers.image.source="https://github.com/appstrate/appstrate" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="Appstrate" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.created="${BUILD_CREATED}"

# nodejs       — runtime for the integration server
# ca-certificates — TLS trust store for outbound API calls (Gmail, etc.)
# /bundle is the conventional mount point — sidecar `docker cp`s the
# extracted bundle here before `docker start`.
#
# Runner user pinned at UID 1001 (see bun runner Dockerfile for the
# rationale) so the per-run shared workspace volume stays writable
# across the agent + every runner sharing it.
RUN apk add --no-cache nodejs ca-certificates && \
    addgroup -g 1001 runner && \
    adduser -D -u 1001 -G runner -s /bin/sh runner && \
    mkdir -p /bundle && \
    chown runner:runner /bundle

# Universal egress proxy shim (appstrate/appstrate#779): preloaded into EVERY
# node integration via NODE_OPTIONS so any HTTP client (fetch/undici, axios,
# request, native http) traverses the sandbox CONNECT egress. NODE_PATH lets the
# shim resolve its deps; harmless to the (self-contained) integration bundle.
COPY --from=proxydeps /opt/appstrate/proxy/node_modules /opt/appstrate/proxy/node_modules
COPY proxy-preload.cjs /opt/appstrate/proxy/proxy-preload.cjs
ENV NODE_OPTIONS=--require=/opt/appstrate/proxy/proxy-preload.cjs \
    NODE_PATH=/opt/appstrate/proxy/node_modules

USER runner:runner
WORKDIR /bundle

# `node` is the entrypoint; the CMD (passed by the sidecar as the
# absolute path inside the container, e.g. `/bundle/server/index.js`)
# provides the script to execute.
ENTRYPOINT ["node"]
