// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.2d — pure decision layer for the per-integration HTTPS MITM
 * listener (proposal §4.1.4 + §4.1.6.1).
 *
 * Given the resolved {@link IntegrationCredentialsPayload} for a single
 * integration plus the descriptor of an outbound HTTPS request the MCP
 * subprocess emitted, this module returns a structured {@link MitmAction}
 * the operational listener applies verbatim. No I/O, no node/Bun APIs,
 * no globals — every branch is unit-testable.
 *
 * Returned action covers three orthogonal mutations:
 *
 *   1. **Strip** — header names (case-insensitive) the listener MUST
 *      remove from the inbound request before injecting. Defaults to
 *      `Authorization`, `Proxy-Authorization`, and the manifest's
 *      `delivery.http.headerName` when the matched auth declares one.
 *      Suppressed per-header when the matching auth declared
 *      `allowServerOverride: true` (proposal §4.1.4 step 2).
 *
 *   2. **Inject** — the rendered `{name, value}` pair the listener sets
 *      on the upstream request. `null` when no auth matches (proposal
 *      §4.1.4 step 1 — forward without credentials, let upstream 401).
 *
 *   3. **Retry401** — boolean: when the upstream returns 401 on the
 *      first attempt and the matched auth is OAuth-shaped, the listener
 *      forces a credential refresh and retries once (§4.1.4 step 5).
 *      Pure planner cannot know if the refresh succeeded — it just
 *      tells the listener "this auth supports retry". The listener
 *      drives the refresh via the credential-resolver callback.
 *
 * What this module does NOT do:
 *   - Refresh OAuth tokens (planner has no network).
 *   - Resolve the manifest's `delivery.http` plan — the caller passes the
 *     payload's `auths[].delivery` decisions through {@link resolveHttpDelivery}
 *     and hands the {@link HttpDeliveryPlan} in as part of the
 *     {@link MitmRequestContext}. Keeps this file dependency-free.
 *   - Step-up auth via `WWW-Authenticate: Bearer scope="..."` — that
 *     belongs in `mcp-http-auth.ts` for the HTTP transport. The MITM
 *     listener does NOT step up because the spec only requires step-up
 *     for the runtime-as-MCP-client direction, not the
 *     MCP-server-talks-to-upstream direction §4.1.4 covers.
 */

import type {
  HttpDeliveryPlan,
  IntegrationCredentialsPayload,
  ResolvedAuthCredentials,
} from "./integration-credentials.ts";
import { matchesAuthorizedUriSpec } from "./proxy-primitives.ts";

// ─────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────

/**
 * Inbound HTTPS request descriptor — pure data the listener composes
 * from the inner HTTP/1.1 request it terminated after CONNECT.
 *
 * `headerNames` is the list of header names the caller (the MCP
 * subprocess) sent. The planner only needs the names — it does not
 * inspect values, since the action's `strip` directive operates by name
 * regardless of value.
 */
export interface MitmRequestContext {
  /** Full URL the request targets, e.g. `https://api.example.com/v1/items`. */
  url: string;
  /** Case-preserving list of header names the caller supplied. */
  headerNames: readonly string[];
  /**
   * Pre-computed delivery plans for each connected auth, keyed by
   * `authKey`. The caller (the listener wire-up) builds this by calling
   * {@link resolveHttpDelivery} on each `payload.auths[]` entry once and
   * caching the result. Mid-call refresh (after a 401 retry) replaces
   * the entry in place. Auths with no delivery plan (`null` from the
   * resolver) are simply absent from this map.
   */
  deliveryPlans: Readonly<Record<string, HttpDeliveryPlan>>;
}

/**
 * Action the listener applies. All fields are independent:
 *   - `injectedHeader` ⇒ set on outbound request (after strip)
 *   - `strippedHeaderNames` ⇒ remove (case-insensitive) from outbound
 *   - `matchedAuth` ⇒ informational; the listener uses it to drive
 *     401-retry refresh against the correct credential
 */
export interface MitmAction {
  matchedAuth: ResolvedAuthCredentials | null;
  /** Case-insensitive names — caller scans inbound headers and skips matches. */
  strippedHeaderNames: readonly string[];
  /** Header to add to the outbound request. `null` when no auth matched. */
  injectedHeader: { name: string; value: string } | null;
  /**
   * Whether to attempt a 401-retry path. Always `true` for `oauth2`
   * matches (refresh-capable). `false` for `api_key` / `basic` /
   * `custom` — no refresh path exists, so retrying would loop.
   */
  retry401: boolean;
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Pick the auth whose `authorizedUris` matches first in manifest order.
 * Returns `null` when none match (proposal §4.1.4 step 1).
 */
function pickAuthForUrl(
  url: string,
  payload: IntegrationCredentialsPayload,
): ResolvedAuthCredentials | null {
  for (const auth of payload.auths) {
    for (const pattern of auth.authorizedUris) {
      if (matchesAuthorizedUriSpec(pattern, url)) return auth;
    }
  }
  return null;
}

/**
 * Compute the {@link MitmAction} for one request.
 *
 * The planner is intentionally minimal — every conditional here maps 1:1
 * to a spec clause documented at the top of the file. Behaviour:
 *
 *   1. Pick the matching auth (manifest order; first match wins).
 *   2. If no auth matched → strip nothing custom (the universal pair
 *      `Authorization` + `Proxy-Authorization` are still removed so the
 *      MCP server cannot smuggle a token the listener wouldn't recognise),
 *      inject nothing, do not retry.
 *   3. If an auth matched → strip the universal pair PLUS the manifest
 *      `headerName`, EXCEPT each header the auth declared
 *      `allowServerOverride: true` for (currently a single flag covering
 *      the auth's own header; the universal pair is always stripped to
 *      respect the cross-auth confused-deputy mitigation).
 *   4. Render the injection from the pre-computed delivery plan. Empty
 *      values produce `injectedHeader: null` so the listener does not
 *      set a useless header.
 */
export function planMitmAction(
  ctx: MitmRequestContext,
  payload: IntegrationCredentialsPayload,
): MitmAction {
  const matched = pickAuthForUrl(ctx.url, payload);

  const universalStrip = ["Authorization", "Proxy-Authorization"];

  if (!matched) {
    return {
      matchedAuth: null,
      strippedHeaderNames: dedupeCaseInsensitive(universalStrip),
      injectedHeader: null,
      retry401: false,
    };
  }

  const plan = ctx.deliveryPlans[matched.authKey];
  const stripped: string[] = [...universalStrip];

  if (plan) {
    // By default the proxy strips a server-supplied header matching the
    // injection target (confused-deputy boundary — integration code must not
    // pre-empt the injected credential). The ONE exception is an explicit
    // `allowServerOverride` on an Authorization-typed auth: the manifest author
    // opted in, so the integration's own Authorization value is allowed to
    // survive and we drop it from the universal strip list below.
    if (plan.allowServerOverride && looseEquals(plan.headerName, "Authorization")) {
      // Override allowed for Authorization → drop it from the strip list so
      // the caller's own value survives.
      const idx = stripped.findIndex((h) => looseEquals(h, "Authorization"));
      if (idx >= 0) stripped.splice(idx, 1);
    } else if (
      plan.value.length > 0 &&
      !plan.allowServerOverride &&
      !looseEquals(plan.headerName, "Authorization")
    ) {
      // Protect the injected credential header from server override — but ONLY
      // when we actually have a credential to inject. An empty delivery value
      // means "no credential yet": e.g. a `connect.tool` session still being
      // acquired at run-start, where the placeholder plan is `value: ""`.
      // Stripping the caller's same-named header then would clobber the login
      // tool's own cookie jar (the CSRF / session cookies it must carry across
      // the login redirect chain) while protecting nothing — there is no
      // injected credential to shadow. The universal Authorization /
      // Proxy-Authorization strip above still applies unconditionally.
      stripped.push(plan.headerName);
    }
  }

  const injectedHeader = plan
    ? renderInjection(plan, ctx.headerNames, plan.allowServerOverride)
    : null;

  return {
    matchedAuth: matched,
    strippedHeaderNames: dedupeCaseInsensitive(stripped),
    injectedHeader,
    retry401: matched.authType === "oauth2",
  };
}

// ─────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────

/**
 * Render the `{name, value}` pair the listener writes onto the upstream
 * request. Returns `null` when:
 *   - the delivery plan's value is empty (the credential resolver
 *     surfaced an empty field; injecting "Bearer " with no token is a
 *     guaranteed 401 and wastes the round-trip), OR
 *   - `allowServerOverride: true` AND the caller already set the same
 *     header (the manifest opt-in says respect the caller's value).
 */
function renderInjection(
  plan: HttpDeliveryPlan,
  callerHeaderNames: readonly string[],
  allowServerOverride: boolean,
): { name: string; value: string } | null {
  if (plan.value.length === 0) return null;
  if (allowServerOverride) {
    const callerSetIt = callerHeaderNames.some((h) => looseEquals(h, plan.headerName));
    if (callerSetIt) return null;
  }
  const prefix = plan.headerPrefix.trim();
  const value = prefix ? `${prefix} ${plan.value}` : plan.value;
  return { name: plan.headerName, value };
}

function looseEquals(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function dedupeCaseInsensitive(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}
