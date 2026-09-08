# @appstrate/cloud — Extends the OSS image with billing module
#
# Build:  docker build --build-arg APPSTRATE_VERSION=latest -t appstrate-cloud .
# Run:    Used by docker-compose.yml (not run directly)

ARG APPSTRATE_VERSION=latest

# ── Stage 1: Install cloud dependencies ──────────────────────────────
FROM oven/bun:1-alpine AS cloud-deps

WORKDIR /cloud

COPY package.json bun.lock* ./
# No `|| bun install` fallback: that mask turned a stale lockfile into a silent
# floating-version install. A lockfile that does not match package.json is a
# bug to fix in the repo, not at image-build time.
RUN bun install --production --frozen-lockfile

# ── Stage 2: Inject cloud module into OSS image ─────────────────────
FROM ghcr.io/appstrate/appstrate:${APPSTRATE_VERSION}

WORKDIR /app

# Copy cloud module into node_modules/@appstrate/cloud
COPY --from=cloud-deps /cloud/node_modules /app/node_modules/@appstrate/cloud/node_modules
COPY package.json /app/node_modules/@appstrate/cloud/
COPY src/ /app/node_modules/@appstrate/cloud/src/
COPY drizzle/ /app/node_modules/@appstrate/cloud/drizzle/

# Point `@appstrate/core` at the platform's own workspace copy.
#
# `@appstrate/core` is an OPTIONAL PEER of this module (see package.json), so
# the `cloud-deps` stage above installs no copy of it — the platform image
# already carries one at /app/packages/core, and that is the copy the billing
# module must compile and run against. Two copies is precisely the version skew
# MODULE_CONTRACT_ENFORCE exists to detect, and it has no business sitting
# inside the production image of the module that does billing.
#
# `test ! -e` is NOT optional. `ln -s SRC DEST` where DEST already exists as a
# directory silently creates DEST/core instead of failing: the image would build
# green, the smoke test below would pass, and cloud would still resolve the npm
# copy. Fail loudly instead.
RUN set -eux; \
    NM=/app/node_modules/@appstrate/cloud/node_modules; \
    mkdir -p "$NM/@appstrate"; \
    test ! -e "$NM/@appstrate/core"; \
    ln -s /app/packages/core "$NM/@appstrate/core"; \
    test -f "$NM/@appstrate/core/src/module.ts"

# Default MODULES for the cloud image — can be overridden at runtime.
# Mirrors the OSS default (core-providers + the reference OAuth-provider
# modules) plus the cloud billing module.
ENV MODULES=oidc,webhooks,core-providers,@appstrate/cloud,@appstrate/module-codex,@appstrate/module-claude-code

# Smoke-test: fail the build if the module can't be resolved, has no default
# export, or resolves the WRONG @appstrate/core.
#
# The core assertion is the load-bearing half. The previous version of this
# smoke test passed while cloud resolved a second, npm-installed core out of its
# own node_modules — so "the module loads" proves nothing on its own. Resolution
# is exercised from the module's own directory, which is where the platform's
# module loader imports it from.
RUN set -eux; \
    cd /app/node_modules/@appstrate/cloud; \
    bun -e ' \
      const core = import.meta.resolve("@appstrate/core/module"); \
      if (!core.startsWith("file:///app/packages/")) { \
        console.error("✗ @appstrate/core resolves to " + core + " — expected the platform copy under /app/packages/"); \
        process.exit(1); \
      } \
      const m = await import("@appstrate/cloud"); \
      if (typeof m.default !== "object") { \
        console.error("✗ cloud module default export missing"); \
        process.exit(1); \
      } \
      console.log("✓ cloud module resolved; @appstrate/core → " + core); \
    '

EXPOSE 3000

CMD ["bun", "apps/api/src/index.ts"]
