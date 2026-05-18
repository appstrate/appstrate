# syntax=docker/dockerfile:1.7
#
# Appstrate MCP Runner — Binary
#
# Spawned per-integration by the sidecar when an AFPS integration
# manifest declares `server.type: "binary"`. The bundle ships a
# self-contained executable; the runner just provides libc + TLS
# trust and runs it.

ARG RUNTIME_IMAGE=alpine:3.21.3
FROM ${RUNTIME_IMAGE} AS runtime

ARG BUILD_VERSION=unknown
ARG BUILD_REVISION=unknown
ARG BUILD_CREATED

LABEL org.opencontainers.image.title="Appstrate MCP Runner (Binary)" \
      org.opencontainers.image.description="Per-integration native-binary runner for AFPS server.type=\"binary\"" \
      org.opencontainers.image.source="https://github.com/appstrate/appstrate" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="Appstrate" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.created="${BUILD_CREATED}"

# libstdc++ / libgcc cover the C++/glibc-shim symbols statically-linked
# Go/Rust binaries usually skip but cgo-linked or Bun-compiled ones need.
RUN apk add --no-cache ca-certificates libstdc++ libgcc && \
    mkdir -p /bundle && \
    chown nobody:nobody /bundle

USER nobody:nobody
WORKDIR /bundle

# The sidecar passes the absolute container path of the binary as the
# CMD; `sh -c 'exec "$@"' --` re-execs it as PID 1 so signals delivered
# by `docker stop` reach the integration directly.
ENTRYPOINT ["/bin/sh", "-c", "exec \"$@\"", "--"]
