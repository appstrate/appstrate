# syntax=docker/dockerfile:1.20

ARG BUN_IMAGE=oven/bun:1.3.14-alpine
ARG ALPINE_IMAGE=alpine:3.23.2

FROM ${BUN_IMAGE} AS builder
WORKDIR /build
COPY runtime-pi/browser-worker/server.ts ./server.ts
COPY runtime-pi/browser-worker/policy.ts ./policy.ts
RUN bun build --compile --minify server.ts --outfile appstrate-browser-worker

FROM ${ALPINE_IMAGE} AS runtime

# The release builder must pass the exact repository version. This deliberately
# fails instead of installing a floating Chromium revision.
ARG CHROMIUM_VERSION
ARG APPSTRATE_BROWSER_WORKER_BUILD_ID=development
RUN test -n "${CHROMIUM_VERSION}" && \
    apk add --no-cache \
      "chromium=${CHROMIUM_VERSION}" \
      ca-certificates \
      font-noto \
      nss \
      freetype \
      harfbuzz

COPY --from=builder --chmod=0555 /build/appstrate-browser-worker /usr/local/bin/appstrate-browser-worker

RUN addgroup -S browser && adduser -S -G browser -h /tmp/browser browser
USER browser:browser

ENV APPSTRATE_BROWSER_EXECUTABLE=/usr/bin/chromium-browser
ENV APPSTRATE_BROWSER_WORKER_BUILD_ID=${APPSTRATE_BROWSER_WORKER_BUILD_ID}
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/appstrate-browser-worker"]
