FROM oven/bun:1-alpine AS builder

WORKDIR /build

COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile

COPY *.ts ./
RUN bun build --compile --minify server.ts --outfile sidecar

FROM alpine:3.21

RUN apk add --no-cache libstdc++ libgcc

COPY --from=builder /build/sidecar /usr/local/bin/sidecar

USER nobody

EXPOSE 8080 8081

ENTRYPOINT ["/usr/local/bin/sidecar"]
