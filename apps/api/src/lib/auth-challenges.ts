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
 * Zero footprint when unused: an empty registry makes the responder a
 * pass-through, so a disabled module that never registers leaves no trace.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../types/index.ts";

export interface AuthChallengeArgs {
  /** Origin of the inbound request, e.g. `https://instance.example`. */
  origin: string;
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

/** Resolve the challenge builder for a request path, if any prefix matches. */
export function resolveAuthChallenge(path: string): AuthChallengeBuilder | undefined {
  return entries.find((e) => path === e.prefix || path.startsWith(`${e.prefix}/`))?.build;
}

/**
 * Middleware that, after the downstream chain runs, attaches a registered
 * `WWW-Authenticate` challenge to a 401/403 response on a matching path. Never
 * overwrites a challenge a handler already set. Mounted once, near the top of
 * the pipeline, so it wraps both the auth middleware (401) and route handlers
 * (403).
 */
export function authChallengeResponder(): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next) => {
    await next();
    const status = c.res.status;
    if (status !== 401 && status !== 403) return;
    if (c.res.headers.has("WWW-Authenticate")) return;
    const build = resolveAuthChallenge(c.req.path);
    if (!build) return;

    const headers = new Headers(c.res.headers);
    headers.set("WWW-Authenticate", build({ origin: new URL(c.req.url).origin, status }));
    c.res = new Response(c.res.body, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers,
    });
  };
}
