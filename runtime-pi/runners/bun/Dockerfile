# syntax=docker/dockerfile:1.7
#
# Appstrate MCP Runner — Bun
#
# The docker-mode runner for `server.type: "bun"` integrations (tier 3). The
# integration runtime matches the run runtime: in process mode (tier 0-2) a
# bun integration runs as a host `bun` subprocess via the process adapter; in
# docker mode the docker adapter spawns one of these containers per bun
# integration, exactly like the node/python/binary runners — keeping the
# tier-3 isolation boundary (cap-drop, no socket, dedicated network).
#
# Spawned by the sidecar (`runtime-pi/sidecar/integrations-boot.ts` →
# `integration-runtime-adapter-docker.ts`): the sidecar `docker create`s
# this image, `docker cp`s the integration bundle into `/bundle`, and
# `docker start -ai`s the container — stdio is piped verbatim to the
# spawning MCP client.
#
# Build (linux/amd64 required to match the sidecar's `docker run` target):
#
#   docker build --platform linux/amd64 \
#     -t appstrate-mcp-runner-bun:latest \
#     -f runtime-pi/runners/bun/Dockerfile \
#     runtime-pi/runners/bun

ARG RUNTIME_IMAGE=oven/bun:1-alpine
FROM ${RUNTIME_IMAGE} AS runtime

ARG BUILD_VERSION=unknown
ARG BUILD_REVISION=unknown
ARG BUILD_CREATED

LABEL org.opencontainers.image.title="Appstrate MCP Runner (Bun)" \
      org.opencontainers.image.description="Per-integration Bun runner for AFPS server.type=\"bun\" (docker mode)" \
      org.opencontainers.image.source="https://github.com/appstrate/appstrate" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="Appstrate" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.created="${BUILD_CREATED}"

# ca-certificates — TLS trust store for outbound API calls. Bun ships in
# the base image. /bundle is the conventional mount point — the sidecar
# `docker cp`s the extracted bundle here before `docker start`.
RUN apk add --no-cache ca-certificates && \
    mkdir -p /bundle && \
    chown nobody:nobody /bundle

USER nobody:nobody
WORKDIR /bundle

# `bun` is the entrypoint; the CMD (passed by the sidecar as the absolute
# path inside the container, e.g. `/bundle/server/index.ts`) provides the
# script to execute. Bun runs `.ts` and `.js` directly — no build step.
ENTRYPOINT ["bun"]
