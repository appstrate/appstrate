// SPDX-License-Identifier: Apache-2.0

import { parseBearer } from "@appstrate/core/bearer";
import {
  INTEGRATION_CALLBACK_PATH,
  INTEGRATION_TAGGED_CALLBACK_PATH,
} from "./integration-callback-url.ts";

/**
 * Paths that skip both auth and org-context middleware. The `publicPaths`
 * set is passed in so callers can merge module-contributed paths with the
 * core allowlist.
 *
 * Exported so call sites that need to gate downstream middleware on the
 * same rule (e.g. space-context, api-version) can share this function.
 *
 * `headers` carries the request-scoped bypasses (e.g. pairing-token bearer
 * auth on /pair/redeem) that would otherwise have to be encoded as
 * conditionals inside the static `publicPaths` allowlist.
 *
 * It is REQUIRED, and deliberately so: it used to be optional, and the test
 * harness (`apps/api/test/helpers/app.ts`) silently omitted it on the two
 * middlewares it wires after the pipeline — the omission type-checked, so the
 * harness evaluated a different predicate from production with nothing to say
 * so. Every call site has a `Context` in hand and can pass `c.req.raw.headers`;
 * making the parameter mandatory turns that class of drift into a compile
 * error.
 */
export function skipAuth(
  path: string,
  publicPaths: ReadonlySet<string>,
  headers: Headers,
): boolean {
  if (!path.startsWith("/api/")) return true;
  if (path.startsWith("/api/auth/")) return true; // Better Auth handles its own auth
  if (path.startsWith("/api/realtime/")) return true; // SSE endpoints use cookie auth internally
  if (path === INTEGRATION_CALLBACK_PATH) return true; // Integration OAuth redirect — no session
  if (INTEGRATION_TAGGED_CALLBACK_PATH.test(path)) return true; // Its per-authorization-server twin
  // Hosted connect portal — token/page-cookie authenticated at the
  // route layer. The authed MINT route lives at
  // `/api/integrations/:packageId/auths/:authKey/connect/session` (packageId
  // prefix) and does NOT match this, so it keeps its session/permission guard.
  if (path.startsWith("/api/integrations/connect/")) return true;
  if (path === "/api/uploads/_content") return true; // FS direct-upload sink — auth via HMAC token
  if (path === "/api/docs" || path === "/api/openapi.json") return true;
  // Unified-runner run-scoped routes: event ingestion
  // (`/api/runs/:id/events[/finalize|/heartbeat]`) and the agent
  // workspace self-provisioning fetches (`/api/runs/:id/workspace`,
  // `/files`, `/files/:name`), and the run MCP server of a remote run
  // (`/api/runs/:id/mcp`). All authenticate via a Standard
  // Webhooks HMAC signature at the route layer — not via JWT / API key /
  // cookie.
  if (REMOTE_RUN_EVENT_PATH_PATTERN.test(path)) return true;
  if (publicPaths.has(path)) return true; // module-contributed public paths
  // OAuth model-provider pair-redeem is bearer-only: `Authorization: Bearer appp_…`
  // is the ONLY accepted auth shape. The route handler atomically consumes
  // the matching `model_provider_pairings` row; the row's userId/orgId/
  // providerId become the request context, replacing the cookie/API-key
  // chain entirely. Requests without the bearer reach the route handler
  // and 401 there.
  if (path === "/api/model-providers-oauth/pair/redeem") {
    const auth = headers.get("authorization") ?? headers.get("Authorization");
    if (parseBearer(auth)?.startsWith("appp_")) return true;
  }
  return false;
}

const REMOTE_RUN_EVENT_PATH_PATTERN =
  /^\/api\/runs\/[^/]+\/(events(\/finalize|\/heartbeat)?|workspace|files(\/[^/]+)?|mcp)$/;
