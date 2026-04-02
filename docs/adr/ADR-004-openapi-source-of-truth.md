# ADR-004: OpenAPI Spec as Source of Truth

## Status

Accepted

## Context

Appstrate exposes 181 API endpoints across multiple route domains (agents, runs, connections, webhooks, organizations, etc.). We need a reliable way to:

- Document all endpoints with request/response schemas, auth requirements, and error codes
- Keep documentation in sync with the actual implementation
- Provide interactive API exploration for developers integrating with the platform
- Validate the spec in CI to catch documentation drift

Alternatives considered:

- **Auto-generated from code** (e.g., decorator-based): Couples documentation to runtime, makes it hard to document edge cases, SSE formats, and error schemas precisely
- **External documentation platform** (e.g., Readme.io): Adds a third-party dependency, documentation lives outside the repo, prone to drift
- **Markdown docs only**: No machine-readable schema, no interactive exploration, no CI validation

## Decision

Maintain **hand-written OpenAPI 3.1 specifications** as TypeScript modules in `apps/api/src/openapi/`. One file per route domain in `openapi/paths/`, with shared components for headers, schemas, and security definitions.

The spec is:

- **Served at runtime**: `GET /api/openapi.json` (raw JSON, no auth) and `GET /api/docs` (Swagger UI, no auth)
- **Validated in CI**: `bun run verify:openapi` runs structural and lint checks as part of `bun run check`
- **Modular**: Each route domain has its own path file, making it easy to review changes alongside route code

Route handlers and OpenAPI path files are kept in the same PR. The `verify:openapi` check fails the build if any endpoint is missing or malformed.

## Consequences

**Positive:**

- 181 endpoints fully documented with request/response schemas, error codes, and SSE event formats
- Interactive Swagger UI at `/api/docs` for developer exploration
- CI validation (`verify:openapi`) catches documentation drift before merge
- TypeScript modules allow sharing types between spec and implementation
- Machine-readable spec enables client SDK generation if needed in the future

**Negative:**

- Manual maintenance: every new or changed endpoint requires updating the corresponding OpenAPI path file
- Risk of spec and implementation diverging if a developer forgets to update the path file (mitigated by CI check)
- Hand-written specs require OpenAPI expertise from contributors

**Neutral:**

- OpenAPI 3.1 is the latest version, fully compatible with JSON Schema 2020-12
- The spec is modular TypeScript (not a single YAML file), which scales well with the codebase
