# ── Stage 1: Install dependencies ──────────────────────────────────
FROM oven/bun:1-alpine AS deps

WORKDIR /app

# Copy workspace structure for dependency resolution
COPY package.json bun.lock turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/connect/package.json packages/connect/
COPY packages/db/package.json packages/db/
COPY packages/env/package.json packages/env/

RUN bun install --frozen-lockfile

# ── Stage 2: Build ────────────────────────────────────────────────
FROM oven/bun:1-alpine AS build

WORKDIR /app

# Copy all node_modules (root + workspace-specific)
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/connect/node_modules ./packages/connect/node_modules

COPY . .

RUN bun run build

# ── Stage 3: Production image ─────────────────────────────────────
FROM oven/bun:1-alpine

WORKDIR /app

# Runtime dependencies (root hoisted + workspace-specific)
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/connect/node_modules ./packages/connect/node_modules

# API source (Bun runs TypeScript directly)
COPY --from=build /app/apps/api/src ./apps/api/src
COPY --from=build /app/apps/api/package.json ./apps/api/

# Shared types (used by API at runtime)
COPY --from=build /app/packages/shared-types/src ./packages/shared-types/src
COPY --from=build /app/packages/shared-types/package.json ./packages/shared-types/

# Connect package (used by API at runtime)
COPY --from=build /app/packages/connect/src ./packages/connect/src
COPY --from=build /app/packages/connect/package.json ./packages/connect/

# DB package (schema, client, auth, storage, notify — used by API at runtime)
COPY --from=build /app/packages/db/src ./packages/db/src
COPY --from=build /app/packages/db/package.json ./packages/db/

# Env package (Zod-validated env vars — used by API, DB, connect at runtime)
COPY --from=build /app/packages/env/src ./packages/env/src
COPY --from=build /app/packages/env/package.json ./packages/env/

# Built frontend
COPY --from=build /app/apps/web/dist ./apps/web/dist

# Create mount points for runtime volumes (data + storage)
RUN mkdir -p data storage

# Root package.json needed for workspace resolution
COPY --from=build /app/package.json ./

EXPOSE 3000

CMD ["bun", "apps/api/src/index.ts"]
