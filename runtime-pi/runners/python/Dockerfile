# syntax=docker/dockerfile:1.7
#
# Appstrate MCP Runner — Python
#
# Spawned per-integration by the sidecar when an AFPS integration
# manifest declares `server.type: "python"`. Symmetric to the node
# runner — see that Dockerfile for the rationale and contract.
#
# Bundles bring their own dependencies in `/bundle/vendor/` (installed
# via `pip install --target vendor`); `PYTHONPATH` is set so imports
# resolve transparently. For pure-Python integrations with no C
# extensions this works regardless of build host OS/arch — pure-wheel
# packages are platform-independent.

ARG RUNTIME_IMAGE=alpine:3.21.3
FROM ${RUNTIME_IMAGE} AS runtime

ARG BUILD_VERSION=unknown
ARG BUILD_REVISION=unknown
ARG BUILD_CREATED

LABEL org.opencontainers.image.title="Appstrate MCP Runner (Python)" \
      org.opencontainers.image.description="Per-integration Python runner for AFPS server.type=\"python\"" \
      org.opencontainers.image.source="https://github.com/appstrate/appstrate" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="Appstrate" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.created="${BUILD_CREATED}"

# Runner user pinned at UID 1001 (see bun runner Dockerfile for the
# rationale) so the per-run shared workspace volume stays writable
# across the agent + every runner sharing it.
RUN apk add --no-cache python3 ca-certificates && \
    addgroup -g 1001 runner && \
    adduser -D -u 1001 -G runner -s /bin/sh runner && \
    mkdir -p /bundle && \
    chown runner:runner /bundle

# Bundles add their deps under /bundle/vendor (e.g. `pip install
# --target vendor mcp`). PYTHONPATH lets `import mcp` resolve without
# the bundle author needing to touch sys.path.
ENV PYTHONPATH=/bundle/vendor:/bundle \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

USER runner:runner
WORKDIR /bundle

# `-u` forces unbuffered stdio so JSON-RPC lines reach the parent
# promptly (Python defaults to line-buffered for ttys, block-buffered
# for pipes — the latter would stall MCP handshakes).
ENTRYPOINT ["python3", "-u"]
