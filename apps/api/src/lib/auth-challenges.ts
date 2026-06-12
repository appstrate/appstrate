// SPDX-License-Identifier: Apache-2.0

/**
 * Generic resource-server auth-challenge registry.
 *
 * The platform auth pipeline owns the `/api/*` 401 (missing/invalid
 * credential) and RBAC owns the 403 (insufficient scope). RFC 9728 §5.1 / the
 * MCP authorization spec want a protected resource to answer those with a
 * `WWW-Authenticate: Bearer resource_metadata="…", scope="…"` challenge so a
 * tokenless or under-scoped client can discover the authorization server and
 * start (or step up) an OAuth flow.
 *
 * Rather than special-case one path inside the shared auth/permission code, a
 * resource server registers a challenge for its path prefix here, and a single
 * generic responder middleware attaches the header to any 401/403 it produces
 * on a matching path. Any future protected resource reuses this with one
 * `registerAuthChallenge` call — no edits to the auth pipeline.
 *
 * Independently of the registry, the responder also guarantees the RFC 6750
 * §3 baseline: every 401 it sees carries at least a generic
 * `WWW-Authenticate: Bearer` challenge (with `error="invalid_token"` when a
 * credential was presented but rejected). A disabled module that never
 * registers leaves no richer trace — its paths simply get the generic
 * challenge like everything else.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../types/index.ts";

export interface AuthChallengeArgs {
  /** Origin of the inbound request, e.g. `https://instance.example`. */
  origin: string;
  /**
   * Path of the inbound request, e.g. `/api/mcp/o/<orgId>`. A prefix-registered
   * builder uses this to derive a per-resource challenge (e.g. the per-org MCP
   * PRM URL) for the concrete resource that was requested, not just the prefix.
   */
  path: string;
  /** The status the pipeline produced: 401 (no/invalid token) or 403 (insufficient scope). */
  status: 401 | 403;
}

/** Builds the `WWW-Authenticate` header value for a matched resource. */
export type AuthChallengeBuilder = (args: AuthChallengeArgs) => string;

interface Entry {
  prefix: string;
  build: AuthChallengeBuilder;
}

const entries: Entry[] = [];

/**
 * Register a challenge for a path prefix. Idempotent per prefix (re-registering
 * replaces — safe across test-harness module reloads). Entries are matched
 * longest-prefix-first so a more specific resource wins over a broader one.
 */
export function registerAuthChallenge(prefix: string, build: AuthChallengeBuilder): void {
  const existing = entries.findIndex((e) => e.prefix === prefix);
  if (existing >= 0) entries[existing] = { prefix, build };
  else entries.push({ prefix, build });
  entries.sort((a, b) => b.prefix.length - a.prefix.length);
}

/** Test-only: clear the registry between cases. */
export function resetAuthChallenges(): void {
  entries.length = 0;
}

/**
 * Test-only: snapshot/restore the registry. The registry is a process-wide
 * singleton shared with the live app (a module registers its challenge once,
 * when its router is built). A unit test that mutates it via
 * `resetAuthChallenges` would otherwise LEAK — wiping the app's registration
 * for every test file that runs afterwards in the same `bun test` process. Wrap
 * such a test with `beforeAll(snapshot)` / `afterAll(restore)` so it leaves the
 * registry exactly as it found it, making cross-file order irrelevant.
 */
export function snapshotAuthChallenges(): readonly Entry[] {
  return entries.slice();
}
export function restoreAuthChallenges(snapshot: readonly Entry[]): void {
  entries.length = 0;
  entries.push(...snapshot);
}

/** Resolve the challenge builder for a request path, if any prefix matches. */
export function resolveAuthChallenge(path: string): AuthChallengeBuilder | undefined {
  return entries.find((e) => path === e.prefix || path.startsWith(`${e.prefix}/`))?.build;
}

/**
 * Middleware that, after the downstream chain runs, attaches a
 * `WWW-Authenticate` challenge to a 401/403 response. Never overwrites a
 * challenge a handler already set. Mounted once, near the top of the
 * pipeline, so it wraps both the auth middleware (401) and route handlers
 * (403).
 *
 * Precedence:
 *   1. A handler-set `WWW-Authenticate` is left untouched.
 *   2. A registered (RFC 9728) challenge on a matching path prefix —
 *      e.g. the MCP resource-metadata challenge — wins next.
 *   3. Otherwise every 401 falls back to the generic RFC 6750 §3 Bearer
 *      challenge: `Bearer error="invalid_token"` when the request carried
 *      an `Authorization` header that failed validation, bare `Bearer`
 *      when no credential was presented at all (§3.1 says the error code
 *      SHOULD be omitted in that case). 403s get no generic fallback —
 *      an `insufficient_scope` challenge needs scope knowledge only a
 *      registered resource has.
 */
export function authChallengeResponder(): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next) => {
    await next();
    const status = c.res.status;
    if (status !== 401 && status !== 403) return;
    if (c.res.headers.has("WWW-Authenticate")) return;
    const build = resolveAuthChallenge(c.req.path);
    let challenge: string | undefined;
    if (build) {
      challenge = build({ origin: new URL(c.req.url).origin, path: c.req.path, status });
    } else if (status === 401) {
      challenge = c.req.header("Authorization") ? 'Bearer error="invalid_token"' : "Bearer";
    }
    if (!challenge) return;

    const headers = new Headers(c.res.headers);
    headers.set("WWW-Authenticate", challenge);
    c.res = new Response(c.res.body, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers,
    });
  };
}
