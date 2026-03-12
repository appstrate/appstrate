FROM oven/bun:1-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates unzip python3 python3-pip && rm -rf /var/lib/apt/lists/*

WORKDIR /runtime

COPY package.json bun.lock* ./
RUN bun install --production

COPY lib/ /runtime/lib/
COPY extensions/ /runtime/extensions/
COPY extension-wrapper.ts /runtime/extension-wrapper.ts
COPY entrypoint.ts /runtime/entrypoint.ts

RUN useradd -m -s /bin/bash pi

WORKDIR /workspace
RUN chown pi:pi /workspace
RUN ln -sf /runtime/node_modules /workspace/node_modules

USER pi

ENTRYPOINT ["bun", "run", "/runtime/entrypoint.ts"]
