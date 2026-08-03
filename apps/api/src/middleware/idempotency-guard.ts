// SPDX-License-Identifier: Apache-2.0

/**
 * `Idempotency-Key` honesty guard.
 *
 * `idempotency()` is mounted on a handful of routes. Every other mutating
 * endpoint used to accept the header and silently ignore it — a retrying SDK
 * had no way to learn that its de-duplication guarantee did not exist there.
 * This middleware closes that hole: the header is either honoured or refused,
 * never quietly dropped.
 *
 * ## What it covers — and what it does not
 *
 * It covers every route registered *after* it in `apps/api/src/index.ts`:
 * all of `routes/` and every module router (`registerModuleRoutes`).
 *
 * It does **not** cover `/api/auth/*`. Better Auth is mounted as a terminal
 * handler earlier in the pipeline (`lib/auth-pipeline.ts`, before this guard
 * in `index.ts`), owns its own router, and answers the request without ever
 * reaching here — so sign-up/sign-in/sign-out, the RFC 8628 device flow,
 * `cli/token`, `cli/revoke` and `organization/create|update|delete` still
 * accept an `Idempotency-Key` and ignore it. (Even mounted first, the
 * registration is `/api/auth/*` and `isWildcardRoute` would exclude it.)
 * Bringing that surface under the guard means reaching into Better Auth's
 * routing, which buys a consistency this docblock can state for free.
 *
 * It covers module routers, but only **in-tree** modules can opt *in*.
 * `idempotency()` lives in `apps/api/src/middleware/` and is exported from no
 * package. Built-in dir modules import it by relative path (`webhooks` and
 * `oidc` both do); `@appstrate/module-chat`, `@appstrate/cloud` and any
 * operator-installed module cannot, so every mutating route they register is
 * permanently in "refuse" mode. Nothing breaks today — none of them advertises
 * the header — but they are held to a policy they have no way to satisfy. See
 * `apps/api/src/modules/README.md` → "Idempotency".
 *
 * ## Where the supported set comes from
 *
 * Nowhere but the mounts themselves. `idempotency()` stamps a marker on the
 * middleware it returns (see `isIdempotencyAware`), and Hono hands every
 * middleware the *complete* match result for the request — including the
 * handlers of routes further down the chain — via `matchedRoutes()`. So this
 * guard asks the router "does this request's chain include an
 * idempotency-aware handler?" instead of consulting a list. A list would be a
 * second thing to maintain, and the failure mode of it going stale is exactly
 * the silence this change exists to remove.
 *
 * The OpenAPI side (the `Idempotency-Key` parameter on the supported
 * operations) is the one hand-written mirror, and
 * `test/integration/middleware/idempotency-contract.test.ts` fails when it
 * stops matching the mounts — matching the parameter by *name*, so an inline
 * declaration is caught as well as a `$ref` to the shared component.
 *
 * ## Why not `c.req.routePath`
 *
 * Hono resolves the route *before* running any handler, but `routePath(c)`
 * returns the path the *current* handler was registered under — `"/*"` for a
 * globally-mounted middleware like this one. `routePath(c, -1)` returns the
 * last matched route, which is the `/api/*` 404 fallback, not the real
 * endpoint. `matchedRoutes(c)` is the accurate view, and it is populated from
 * the first middleware onward — verified against hono 4.12.
 */

import type { Context, Next } from "hono";
import { matchedRoutes } from "hono/route";
import type { AppEnv } from "../types/index.ts";
import { ApiError } from "../lib/errors.ts";
import { isIdempotencyAware } from "./idempotency.ts";

/**
 * Methods on which the header is ignored rather than refused.
 *
 * RFC 9110 §9.2.1 makes GET/HEAD/OPTIONS safe: replaying one has no effect to
 * de-duplicate, so the client's retry guarantee already holds without any
 * server mechanism and there is no false promise to correct. Refusing them
 * would only break clients (and proxies, and generated SDKs) that stamp the
 * header onto every outbound request — a cost with no honesty gained.
 *
 * Every unsafe method is refused, including PUT and DELETE. Those are
 * idempotent per RFC 9110 §9.2.2, but `Idempotency-Key` promises more than
 * "repeating is harmless": it promises the *original response* is replayed and
 * that concurrent duplicates collide. We do not provide that here either.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Wildcard registrations — `app.use("*", …)`, the `/api/*` 404 fallback, the
 * SPA `/*` catch-all. They are not endpoints, so a request that matched only
 * these has no endpoint to be honest about: let it fall through and 404
 * instead of masking that with a header complaint.
 */
function isWildcardRoute(path: string): boolean {
  return path === "*" || path === "/*" || path.endsWith("/*");
}

/**
 * Reject `Idempotency-Key` on mutating routes that do not honour it.
 *
 * Mount globally, before the routers. Costs nothing on requests that do not
 * carry the header (single header read, then `next()`).
 */
export function idempotencyGuard() {
  return async function idempotencyGuardMiddleware(c: Context<AppEnv>, next: Next) {
    if (c.req.header("Idempotency-Key") === undefined) return next();
    if (SAFE_METHODS.has(c.req.method)) return next();

    const routes = matchedRoutes(c as unknown as Context);

    // Honoured here — hand off to `idempotency()` further down the chain.
    if (routes.some((r) => isIdempotencyAware(r.handler))) return next();

    // No concrete endpoint matched: this is a 404 (or the SPA fallback), and a
    // "not found" is the more useful answer than a header complaint.
    if (!routes.some((r) => !isWildcardRoute(r.path))) return next();

    throw new ApiError({
      status: 400,
      code: "idempotency_not_supported",
      title: "Idempotency Not Supported",
      detail:
        "This endpoint does not support Idempotency-Key. Retrying it will not be de-duplicated. " +
        "Remove the header, or check the OpenAPI spec — operations that honour it declare it as a parameter.",
      param: "Idempotency-Key",
    });
  };
}
