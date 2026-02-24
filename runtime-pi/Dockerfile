FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates unzip python3 python3-pip && rm -rf /var/lib/apt/lists/*

WORKDIR /runtime

COPY package.json ./
RUN npm install --production

COPY extensions/ /runtime/extensions/
COPY extension-wrapper.ts /runtime/extension-wrapper.ts
COPY entrypoint.ts /runtime/entrypoint.ts

RUN useradd -m -s /bin/bash pi

WORKDIR /workspace
RUN chown pi:pi /workspace

ENV NODE_PATH=/runtime/node_modules

USER pi

ENTRYPOINT ["node", "--import", "/runtime/node_modules/tsx/dist/esm/index.mjs", "/runtime/entrypoint.ts"]
