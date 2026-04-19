# ── Stage 1: Install dependencies ──────────────────────────────────
FROM oven/bun:1.3.11-alpine AS deps

LABEL org.opencontainers.image.source="https://github.com/appstrate/appstrate"
LABEL org.opencontainers.image.description="Appstrate — Open-source platform for running autonomous AI agents in sandboxed Docker containers"
LABEL org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /app

# Copy workspace structure for dependency resolution
COPY package.json bun.lock turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/connect/package.json packages/connect/
COPY packages/db/package.json packages/db/
COPY packages/emails/package.json packages/emails/
COPY packages/env/package.json packages/env/
COPY packages/ui/package.json packages/ui/
COPY runtime-pi/package.json runtime-pi/
COPY runtime-pi/sidecar/package.json runtime-pi/sidecar/
COPY e2e/package.json e2e/
COPY patches/ patches/

RUN bun install --frozen-lockfile

# ── Stage 2: Build ────────────────────────────────────────────────
FROM oven/bun:1.3.11-alpine AS build

WORKDIR /app

# Copy all node_modules (root + workspace-specific)
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/connect/node_modules ./packages/connect/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/env/node_modules ./packages/env/node_modules
COPY --from=deps /app/packages/shared-types/node_modules ./packages/shared-types/node_modules
COPY --from=deps /app/packages/ui/node_modules ./packages/ui/node_modules

COPY . .

# Re-link workspace packages after COPY overwrites symlinks. Without this,
# Rolldown (Vite 8) can't resolve transitive deps like i18next via the broken
# apps/web/node_modules/i18next → /app/node_modules/.bun/i18next@X symlink.
RUN bun install --frozen-lockfile

RUN bun run build

# ── Stage 3: Production image ─────────────────────────────────────
FROM oven/bun:1.3.11-alpine

WORKDIR /app

# Runtime dependencies (root hoisted + workspace-specific)
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/connect/node_modules ./packages/connect/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/env/node_modules ./packages/env/node_modules
COPY --from=deps /app/packages/shared-types/node_modules ./packages/shared-types/node_modules

# API source (Bun runs TypeScript directly)
COPY --from=build /app/apps/api/src ./apps/api/src
COPY --from=build /app/apps/api/package.json ./apps/api/

# Core package (validation, storage, utilities — used by API + all packages at runtime)
COPY --from=build /app/packages/core/src ./packages/core/src
COPY --from=build /app/packages/core/schema ./packages/core/schema
COPY --from=build /app/packages/core/package.json ./packages/core/

# Shared types (used by API at runtime)
COPY --from=build /app/packages/shared-types/src ./packages/shared-types/src
COPY --from=build /app/packages/shared-types/package.json ./packages/shared-types/

# Connect package (used by API at runtime)
COPY --from=build /app/packages/connect/src ./packages/connect/src
COPY --from=build /app/packages/connect/package.json ./packages/connect/

# DB package (schema, client, auth, storage, notify, migrate — used by API at runtime)
COPY --from=build /app/packages/db/src ./packages/db/src
COPY --from=build /app/packages/db/package.json ./packages/db/
COPY --from=build /app/packages/db/drizzle ./packages/db/drizzle

# Emails package (templates + rendering — used by API and DB/auth at runtime)
COPY --from=build /app/packages/emails/src ./packages/emails/src
COPY --from=build /app/packages/emails/package.json ./packages/emails/

# Env package (Zod-validated env vars — used by API, DB, connect at runtime)
COPY --from=build /app/packages/env/src ./packages/env/src
COPY --from=build /app/packages/env/package.json ./packages/env/

# Built frontend
COPY --from=build /app/apps/web/dist ./apps/web/dist

# Create mount points for runtime volumes (data + storage)
RUN mkdir -p data storage && chown -R bun:bun data storage

# Root package.json needed for workspace resolution
COPY --from=build /app/package.json ./
COPY --from=build /app/system-packages ./system-packages

# su-exec for lightweight privilege drop in entrypoint
RUN apk add --no-cache su-exec

# Entrypoint: detects Docker socket GID and adds bun to that group before exec
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/ || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "apps/api/src/index.ts"]
