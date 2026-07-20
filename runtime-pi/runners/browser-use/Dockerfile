# syntax=docker/dockerfile:1.7
#
# Appstrate MCP Runner — Browser Use
#
# This is a language/runtime image, not a browser image. Browser Use must
# attach to the separately provisioned Appstrate browser worker over its
# authenticated CDP endpoint; no Chromium binary is installed here.

ARG RUNTIME_IMAGE=ghcr.io/astral-sh/uv:python3.12-bookworm-slim
FROM ${RUNTIME_IMAGE} AS runtime

ARG BUILD_VERSION=unknown
ARG BUILD_REVISION=unknown
ARG BUILD_CREATED

LABEL org.opencontainers.image.title="Appstrate MCP Runner (Browser Use)" \
      org.opencontainers.image.description="Pinned Python runtime for first-party Browser Use MCP drivers" \
      org.opencontainers.image.source="https://github.com/appstrate/appstrate" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="Appstrate" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.created="${BUILD_CREATED}"

ENV DEBIAN_FRONTEND=noninteractive \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --gid 1001 runner && \
    useradd --uid 1001 --gid 1001 --create-home --shell /usr/sbin/nologin runner && \
    mkdir -p /bundle /opt/appstrate-browser-use /tmp/appstrate-browser-use && \
    chown -R runner:runner /bundle /opt/appstrate-browser-use /tmp/appstrate-browser-use

COPY --chown=runner:runner pyproject.toml uv.lock /opt/appstrate-browser-use/
WORKDIR /opt/appstrate-browser-use
RUN uv sync --frozen --no-dev --no-install-project

COPY --chown=runner:runner appstrate_browser_use /opt/appstrate-browser-use-bridge/appstrate_browser_use
COPY --chown=runner:runner tests /opt/appstrate-browser-use-bridge/tests
RUN PYTHONPATH=/opt/appstrate-browser-use-bridge \
    .venv/bin/python -m unittest discover -s /opt/appstrate-browser-use-bridge/tests -v

ENV PATH="/opt/appstrate-browser-use/.venv/bin:${PATH}" \
    PYTHONPATH="/opt/appstrate-browser-use-bridge" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    ANONYMIZED_TELEMETRY=false \
    BROWSER_USE_DISABLE_EXTENSIONS=1 \
    BROWSER_USE_HEADLESS=true \
    BROWSER_USE_CONFIG_DIR=/tmp/appstrate-browser-use

USER runner:runner
WORKDIR /bundle

ENTRYPOINT ["python", "-u"]
