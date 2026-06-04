# syntax=docker/dockerfile:1.7
#
# Appstrate MCP Runner — uv (Python via Astral's uv)
#
# Spawned per-integration by the sidecar when an AFPS integration
# manifest declares `server.type: "uv"` (MCPB 0.4 / AFPS §3.4,
# `manifest_version: "0.4"`). The runner uses Astral's `uv` to resolve
# and execute the bundle — `uv run` reads `pyproject.toml` /
# `requirements.txt` / inline PEP-723 script metadata, materialises a
# virtual environment on the fly, then runs the entry point. The
# bundle's `entry_point` is passed verbatim as CMD (e.g.
# `/bundle/server.py`).
#
# Why a dedicated image (vs. piggy-backing on the python runner): the
# python runner image (`appstrate-mcp-runner-python`) ships `python3`
# alone — no `uv` binary. Routing `server.type: "uv"` through it would
# fail at `exec` time with `uv: not found`. Astral publishes an official
# combined `uv + python` image that's both small (alpine-based) and
# guaranteed to track `uv` releases, so we use it directly.
#
# Build (linux/amd64 required to match the sidecar's `docker run`
# target):
#
#   docker build --platform linux/amd64 \
#     -t appstrate-mcp-runner-uv:latest \
#     -f runtime-pi/runners/uv/Dockerfile \
#     runtime-pi/runners/uv

ARG RUNTIME_IMAGE=ghcr.io/astral-sh/uv:python3.12-alpine
FROM ${RUNTIME_IMAGE} AS runtime

ARG BUILD_VERSION=unknown
ARG BUILD_REVISION=unknown
ARG BUILD_CREATED

LABEL org.opencontainers.image.title="Appstrate MCP Runner (uv)" \
      org.opencontainers.image.description="Per-integration uv runner for AFPS server.type=\"uv\" (MCPB 0.4 / manifest_version: \"0.4\")" \
      org.opencontainers.image.source="https://github.com/appstrate/appstrate" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="Appstrate" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.created="${BUILD_CREATED}"

# ca-certificates — TLS trust store for outbound API calls. `uv` +
# `python3` ship in the base image. /bundle is the conventional mount
# point — the sidecar `docker cp`s the extracted bundle here before
# `docker start`.
#
# Runner user pinned at UID 1001 (see bun runner Dockerfile for the
# rationale) so the per-run shared workspace volume stays writable
# across the agent + every runner sharing it.
RUN apk add --no-cache ca-certificates && \
    addgroup -g 1001 runner && \
    adduser -D -u 1001 -G runner -s /bin/sh runner && \
    mkdir -p /bundle && \
    chown runner:runner /bundle

# `uv run` honours per-bundle dependency declarations (pyproject.toml,
# requirements.txt, PEP-723 inline metadata) and writes its cache under
# the user's home. Pointing `UV_CACHE_DIR` at `/bundle/.uv-cache` keeps
# the cache inside the bundle's writable mount and avoids permission
# errors from the runner's default home.
ENV UV_CACHE_DIR=/bundle/.uv-cache \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

USER runner:runner
WORKDIR /bundle

# `uv run` is the entrypoint; the CMD (passed by the sidecar as the
# absolute path inside the container, e.g. `/bundle/server.py`)
# provides the script to execute. `uv run <script>` auto-detects the
# script's runtime + deps and exec's the interpreter.
ENTRYPOINT ["uv", "run"]
