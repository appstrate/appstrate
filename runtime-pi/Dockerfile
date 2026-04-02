# ── Stage 1: Install dependencies ─────────────────────────────────
FROM --platform=${TARGETPLATFORM:-linux/amd64} oven/bun:1.3.9-alpine AS deps

LABEL org.opencontainers.image.source="https://github.com/appstrate/appstrate"
LABEL org.opencontainers.image.description="Appstrate Pi — AI agent runtime for ephemeral agent runs"
LABEL org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /build

COPY package.json bun.lock ./
RUN bun install --production && \
    find node_modules -name "*.d.ts" -delete && \
    find node_modules -name "*.d.mts" -delete && \
    find node_modules -name "*.map" -delete && \
    find node_modules \( -name "README*" -o -name "CHANGELOG*" -o -name "LICENSE*" \) -delete && \
    rm -rf node_modules/@types

# ── Stage 2: Runtime ─────────────────────────────────────────────
FROM --platform=${TARGETPLATFORM:-linux/amd64} oven/bun:1.3.9-alpine

RUN apk add --no-cache git curl ca-certificates unzip python3 py3-pip bash

WORKDIR /runtime

COPY --from=deps /build/node_modules ./node_modules

COPY lib/ /runtime/lib/
COPY extensions/ /runtime/extensions/
COPY extension-wrapper.ts /runtime/extension-wrapper.ts
COPY entrypoint.ts /runtime/entrypoint.ts

RUN adduser -D -s /bin/bash pi && \
    mkdir -p /workspace && chown pi:pi /workspace && \
    ln -sf /runtime/node_modules /workspace/node_modules

USER pi

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD test -f /runtime/entrypoint.ts || exit 1

ENTRYPOINT ["bun", "run", "/runtime/entrypoint.ts"]
