FROM --platform=${TARGETPLATFORM:-linux/amd64} oven/bun:1.3.9-alpine AS builder

LABEL org.opencontainers.image.source="https://github.com/appstrate/appstrate"
LABEL org.opencontainers.image.description="Appstrate Sidecar — Credential-isolating HTTP proxy for agent containers"
LABEL org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /build

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY server.ts app.ts helpers.ts forward-proxy.ts ssrf.ts ./
RUN bun build --compile --minify server.ts --outfile sidecar

FROM --platform=${TARGETPLATFORM:-linux/amd64} alpine:3.21.3

RUN apk add --no-cache libstdc++ libgcc

COPY --from=builder /build/sidecar /usr/local/bin/sidecar

USER nobody

EXPOSE 8080 8081

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1

ENTRYPOINT ["/usr/local/bin/sidecar"]
