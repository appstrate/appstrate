# ADR-005: App-Level Security over PostgreSQL RLS

## Status

Accepted

## Context

Appstrate is multi-tenant: each organization has its own agents, connections, runs, and settings. We need to ensure strict data isolation between organizations. Two approaches were evaluated:

1. **PostgreSQL Row-Level Security (RLS)**: Database-enforced policies that filter rows based on a session variable (e.g., `current_setting('app.org_id')`). Every query is automatically filtered by the database, regardless of application code.

2. **Application-level filtering**: Every query explicitly includes an `orgId` filter in its `WHERE` clause. Middleware extracts the organization context from the `X-Org-Id` header (validated against the user's membership) and passes it to service functions.

## Decision

Use **application-level security** for all multi-tenant data access. Every database query filters by `orgId` explicitly in the Drizzle ORM query builder. No PostgreSQL RLS policies are configured.

The org context is established by the `org-context` middleware, which:

1. Reads the `X-Org-Id` header from the request
2. Verifies the authenticated user is a member of that organization
3. Sets `c.set("orgId", orgId)` and `c.set("orgRole", role)` on the Hono context
4. All downstream service functions receive `orgId` as an explicit parameter

Route guards (`requireAdmin()`, `requireOwner()`) provide role-based access control on top of the org context.

## Consequences

**Positive:**

- Simpler debugging: `orgId` filters are visible in every query, making it straightforward to trace data access in logs and during development
- Explicit security: every service function signature includes `orgId`, making it impossible to accidentally write a query without tenant filtering
- No hidden database-level magic: the security model is fully expressed in TypeScript, reviewable in PRs
- Drizzle ORM queries are portable: no dependency on PostgreSQL-specific session variables or policies
- Easier testing: no need to set up RLS policies in test databases or manage session variables per test

**Negative:**

- Every new query must remember to include the `orgId` filter (mitigated by consistent patterns and code review)
- No database-level safety net: a bug in application code could expose cross-tenant data (mitigated by integration tests that verify tenant isolation)
- Cannot leverage RLS for direct database access scenarios (e.g., ad-hoc SQL queries by operators)

**Neutral:**

- Compatible with the Drizzle ORM query builder pattern used throughout the codebase
- The `org-context` middleware is the single enforcement point, tested in `test/integration/middleware/`
