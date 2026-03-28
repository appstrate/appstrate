FROM oven/bun:1-alpine

RUN apk add --no-cache git curl ca-certificates unzip python3 py3-pip bash

WORKDIR /runtime

COPY package.json bun.lock* ./
RUN bun install --production && \
    find node_modules -name "*.d.ts" -delete && \
    find node_modules -name "*.d.mts" -delete && \
    find node_modules -name "*.map" -delete && \
    find node_modules \( -name "README*" -o -name "CHANGELOG*" -o -name "LICENSE*" \) -delete && \
    rm -rf node_modules/@types

COPY lib/ /runtime/lib/
COPY extensions/ /runtime/extensions/
COPY extension-wrapper.ts /runtime/extension-wrapper.ts
COPY entrypoint.ts /runtime/entrypoint.ts

RUN adduser -D -s /bin/bash pi && \
    mkdir -p /workspace && chown pi:pi /workspace && \
    ln -sf /runtime/node_modules /workspace/node_modules

USER pi

ENTRYPOINT ["bun", "run", "/runtime/entrypoint.ts"]
