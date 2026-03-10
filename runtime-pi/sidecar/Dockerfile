FROM oven/bun:1-slim

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile

COPY *.ts ./

USER bun

EXPOSE 8080 8081

CMD ["bun", "run", "/app/server.ts"]
