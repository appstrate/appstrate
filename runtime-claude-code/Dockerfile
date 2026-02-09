FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@latest

RUN useradd -m -s /bin/bash claude

WORKDIR /workspace
RUN chown claude:claude /workspace

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER claude

ENTRYPOINT ["/entrypoint.sh"]
