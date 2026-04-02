# ADR-002: Bun + Hono + Drizzle ORM Stack

## Status

Accepted

## Context

Appstrate needs a backend stack that supports:

- Fast startup times (important for development iteration and container-based deployment)
- Native TypeScript execution without a build/transpile step
- Type-safe database access with migration support for PostgreSQL
- Lightweight HTTP framework with SSE support, middleware composition, and OpenAPI compatibility
- Docker socket communication via `fetch()` over Unix sockets

Alternatives considered:

- **Node.js**: Requires transpilation for TypeScript, slower startup, no native `.env` loading
- **Express**: Heavy middleware ecosystem, poor TypeScript ergonomics, no built-in SSE
- **Prisma**: Heavy client generation step, slower queries, schema language instead of TypeScript
- **TypeORM**: Decorator-based, class-heavy API, weaker type inference

## Decision

Use **Bun** as the runtime, **Hono** as the API framework, and **Drizzle ORM** for database access across all Appstrate services.

- **Bun** runs `.ts` files directly (no build step for backend), auto-loads `.env`, provides native `fetch()` with Unix socket support for Docker API communication, and includes `bun:test` for testing.
- **Hono** provides lightweight routing, middleware composition, `streamSSE()` for real-time execution logs, and serves the React SPA as static files from the same `:3000` port.
- **Drizzle ORM** uses TypeScript for schema definitions, generates SQL migrations, and provides full type inference from schema to query result via `InferSelectModel`.

## Consequences

**Positive:**

- No build step for backend code: `.ts` files ship as-is, Bun resolves directly
- Fast startup (~200ms) benefits both development and container boot in production
- Docker socket communication works via native `fetch()` with `unix:` protocol (no need for dockerode, which has socket bugs under Bun)
- Single test runner (`bun:test`) across all packages, no vitest/jest configuration
- Drizzle schema is pure TypeScript: `InferSelectModel` types flow from schema to API responses via `@appstrate/shared-types`

**Negative:**

- Bun ecosystem is younger than Node.js: some npm packages may have compatibility issues
- Hono is less known than Express: smaller pool of developers familiar with its patterns
- Drizzle requires learning its query builder API (different from Prisma's object-oriented style)
- All backend engineers must use Bun (not Node) for local development

**Neutral:**

- Bun is compatible with most npm packages (same module resolution)
- Hono's API is similar enough to Express that onboarding is quick
- Drizzle migrations are plain SQL files, portable to any PostgreSQL tooling
