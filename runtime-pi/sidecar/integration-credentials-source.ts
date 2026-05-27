// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.5 — sidecar-side `MitmCredentialSource` factory that talks to
 * the platform's `/internal/integration-credentials/{scope}/{name}`
 * endpoints (GET = read-current-with-proactive-refresh, POST /refresh =
 * force-refresh).
 *
 * The factory is one-shot per (run × integration): it fetches the
 * initial payload at sidecar boot, caches it in memory, and exposes the
 * `MitmCredentialSource` contract that
 * {@link createIntegrationMitmListener} consumes. The cache is updated
 * in place on every successful refresh — the listener's
 * `refreshOnUnauthorized` hook calls back into this module rather than
 * tracking state itself.
 *
 * Why a per-integration source instead of a shared one: each integration
 * has its own MITM listener (per the existing 1.2d design — proxyUrl is
 * per-integration in `IntegrationToSpawn.credentialSource`), so the
 * source's `current()` already scopes naturally to one integration's
 * auths.
 */

import type {
  HttpDeliveryPlan,
  IntegrationCredentialsPayload,
  IntegrationCredentialsWire,
  ResolvedAuthCredentials,
} from "@appstrate/connect/integration-credentials";
import type { MitmCredentialSource } from "./integration-mitm-listener.ts";
import { logger } from "./logger.ts";

// Wire-level payload returned by both `/internal/integration-credentials`
// endpoints — canonical definition lives in `@appstrate/connect` (single
// source of truth shared with the platform-side resolver). Re-exported here
// for the sidecar's consumers + tests.
export type { IntegrationCredentialsWire };

/**
 * Normalize an HTTP-parsed credentials payload from the platform's AFPS 2.0
 * snake_case wire to the TS-internal camelCase `IntegrationCredentialsWire`
 * shape. The TS source-of-truth interface (in `@appstrate/connect/
 * integration-credentials`) is camelCase per the documented TS-internal
 * naming convention; this function is the deserialization boundary that
 * flips the field names from the platform's snake_case wire.
 *
 * Field mapping (AFPS 2.0 snake_case wire → TS internal camelCase):
 *   auth_key              → authKey
 *   auth_type             → authType
 *   authorized_uris       → authorizedUris
 *   scopes_granted        → scopesGranted
 *   identity_claims       → identityClaims
 *   expires_at            → expiresAt
 *   delivery_plans        → deliveryPlans
 *   expires_at_epoch_ms   → expiresAtEpochMs
 *   header_name           → headerName           (per delivery plan)
 *   header_prefix         → headerPrefix         (per delivery plan)
 *   allow_server_override → allowServerOverride  (per delivery plan)
 */
export function normalizeIntegrationCredentialsWire(raw: unknown): IntegrationCredentialsWire {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rawAuths = Array.isArray(r.auths) ? (r.auths as Record<string, unknown>[]) : [];
  const auths: ResolvedAuthCredentials[] = rawAuths.map((a) => {
    const out: ResolvedAuthCredentials = {
      authKey: a.auth_key as string,
      authType: a.auth_type as string,
      fields: (a.fields ?? {}) as Readonly<Record<string, string>>,
      authorizedUris: (a.authorized_uris ?? []) as readonly string[],
    };
    if (a.resource !== undefined) out.resource = a.resource as string;
    if (a.expires_at !== undefined) out.expiresAt = a.expires_at as string;
    if (a.scopes_granted !== undefined) {
      out.scopesGranted = a.scopes_granted as readonly string[];
    }
    if (a.identity_claims !== undefined) {
      out.identityClaims = a.identity_claims as Readonly<Record<string, string>>;
    }
    return out;
  });

  const rawPlans = (r.delivery_plans ?? {}) as Record<string, Record<string, unknown>>;
  const deliveryPlans: Record<string, HttpDeliveryPlan> = {};
  for (const [k, p] of Object.entries(rawPlans)) {
    deliveryPlans[k] = {
      headerName: p.header_name as string,
      headerPrefix: p.header_prefix as string,
      value: p.value as string,
      allowServerOverride: p.allow_server_override as boolean,
    };
  }

  const expiresAtEpochMs = (r.expires_at_epoch_ms ?? {}) as Record<string, number | null>;

  return { auths, deliveryPlans, expiresAtEpochMs };
}

export interface CreateIntegrationCredentialsSourceOptions {
  /** Package id (e.g. `@vendor/integration`). */
  integrationId: string;
  /** Platform base URL (e.g. `http://appstrate-api:3000`). */
  platformApiUrl: string;
  /** Run token used as `Bearer` for both endpoints. */
  runToken: string;
  /** Pre-fetched initial payload — skips the boot-time GET round-trip. */
  initialPayload: IntegrationCredentialsWire;
  /** Override for tests. Defaults to `globalThis.fetch`. */
  fetchFn?: typeof fetch;
  /**
   * Min-spacing between forced refreshes for the same authKey. Defaults
   * to 5 s — protects the platform refresh endpoint from getting
   * hammered if an integration repeatedly 401s on a non-credential
   * issue (e.g. wrong scope) and the listener keeps retrying.
   */
  minRefreshIntervalMs?: number;
}

export interface IntegrationCredentialsSource extends MitmCredentialSource {
  /** Latest known payload — useful for telemetry/tests. */
  snapshot(): IntegrationCredentialsWire;
  /**
   * Connect-login primitive (P1) — make a freshly-captured login session
   * injectable for the rest of the run. Replaces `payload.auths` with the
   * single supplied `auth`, installs its rendered `plan` under
   * `deliveryPlans[auth.authKey]`, and records the expiry (epoch ms or
   * null) in `expiresAtEpochMs[auth.authKey]`. After this call the MITM
   * listener injects the captured session header on every matching
   * upstream request.
   */
  setSessionOutputs(auth: ResolvedAuthCredentials, plan: HttpDeliveryPlan): void;
  /**
   * Open the transient-input substitution window. While a non-null bag is
   * active, the MITM listener substitutes `{{key}}` placeholders in the
   * outbound URL / body / headers (proxy-side) so the integration's login
   * tool never receives the raw secret. Fail-closed: an unresolved
   * placeholder refuses the request rather than forwarding a literal.
   *
   * When `acquiringAuthKey` is supplied, that auth's delivery plan is
   * SUPPRESSED from {@link MitmCredentialSource.deliveryPlans} for as long as
   * the window is open. The session being (re-)acquired is not yet injectable —
   * the login tool manages its own headers (e.g. a cookie jar carried across
   * the login redirect chain). Without this, a stale prior session (present on
   * a re-login) would be injected over, and its same-named header stripped
   * from, the login tool's own request — clobbering the fresh login. Dependency
   * auths (different keys) keep their plans and stay injectable during login.
   */
  setActiveInputs(bag: Record<string, string>, acquiringAuthKey?: string): void;
  /** Close the substitution window. Idempotent. */
  clearActiveInputs(): void;
  /** The active transient-input bag, or `null` when the window is closed. */
  activeInputs(): Record<string, string> | null;
  /**
   * connect.tool mid-run re-login (P3) — register a per-authKey re-login
   * closure plus the upstream status codes that should trigger it. After this
   * call, {@link shouldReauth} returns true for the registered statuses and
   * {@link MitmCredentialSource.refreshOnUnauthorized} runs the handler (a
   * fresh `runConnectLogin`) instead of the platform refresh POST. The handler
   * resolves `true` on a fresh session so the listener retries the request.
   */
  setReloginHandler(
    authKey: string,
    handler: () => Promise<boolean>,
    reauthStatuses: readonly number[],
  ): void;
  /**
   * True when a re-login handler is registered for `authKey` AND `status` is
   * one of its declared reauth statuses. The listener consults this to decide
   * whether a non-401 (or 401-but-non-OAuth) response should trigger the
   * connect.tool re-login retry path.
   */
  shouldReauth(authKey: string, status: number): boolean;
}

/**
 * Coerce an auth's `expiresAt` into an absolute epoch-ms timestamp.
 *
 * Accepted shapes:
 *   - ISO-8601 string (`"2026-01-01T00:00:00Z"`) → `Date.parse()`.
 *   - Numeric string of an absolute epoch in ms (`"1735689600000"`) →
 *     `Number()`.
 *   - Numeric/string `expires_in` in seconds-from-now (`60`, `"60"`) →
 *     `Date.now() + n * 1000`. Disambiguated by magnitude: values below
 *     `EPOCH_MS_THRESHOLD` (1e12, ~Sep 2001) are treated as seconds-from-now
 *     since no real absolute epoch-ms or ISO date parses that low.
 *   - `null` / `undefined` / unparseable → `null` (treated as never-expiring
 *     by upstream callers).
 *
 * Defence against `Date.parse(<numeric>) === NaN` regression (#F3): the
 * earlier `Date.parse(auth.expiresAt)` call rejected numeric `expires_in`
 * payloads silently, leaving the listener with no expiry signal.
 */
export function coerceExpiresAtToEpochMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const EPOCH_MS_THRESHOLD = 1e12; // ~2001-09-09; below this we assume seconds-from-now.
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value < EPOCH_MS_THRESHOLD ? Date.now() + value * 1000 : value;
  }
  if (typeof value === "string") {
    if (value === "") return null;
    // Try numeric first (covers `"60"` seconds-from-now and `"1735689600000"`).
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return n < EPOCH_MS_THRESHOLD ? Date.now() + n * 1000 : n;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Build a `MitmCredentialSource` backed by the platform's live
 * credentials endpoints. The returned source mutates its internal
 * state on refresh; the same object stays valid for the run's lifetime.
 */
export function createIntegrationCredentialsSource(
  options: CreateIntegrationCredentialsSourceOptions,
): IntegrationCredentialsSource {
  const fetchFn = options.fetchFn ?? fetch;
  const minRefreshIntervalMs = options.minRefreshIntervalMs ?? 5_000;
  let payload = options.initialPayload;
  // Transient-input substitution window (connect-login P1). Default null
  // (closed) — the MITM listener behaves byte-identically to today unless
  // a connect-login is actively in flight.
  let activeInputBag: Record<string, string> | null = null;
  // While a connect-login is in flight, the auth being (re-)acquired is not yet
  // injectable — its delivery plan is suppressed from `deliveryPlans()` so the
  // login tool's own headers (cookie jar) reach upstream untouched.
  let acquiringAuthKey: string | null = null;
  // Last successful refresh per authKey (or "*" for full-payload refreshes).
  const lastRefreshAt = new Map<string, number>();
  // Coalesce concurrent refreshes for the same authKey.
  const inflight = new Map<string, Promise<boolean>>();
  // connect.tool re-login handlers (P3) — keyed by authKey. When registered,
  // `refreshOnUnauthorized` runs the handler instead of the platform POST.
  const reloginHandlers = new Map<
    string,
    { handler: () => Promise<boolean>; reauthStatuses: ReadonlySet<number> }
  >();

  const current = (): IntegrationCredentialsPayload => ({
    auths: [...payload.auths],
  });

  const deliveryPlans = () => {
    // Suppress the in-flight acquired auth's plan so the login tool's own
    // headers (cookie jar) survive the MITM and a stale prior session is not
    // injected during a re-login.
    if (acquiringAuthKey && acquiringAuthKey in payload.deliveryPlans) {
      const { [acquiringAuthKey]: _suppressed, ...rest } = payload.deliveryPlans;
      return rest;
    }
    return payload.deliveryPlans;
  };

  const refreshOnUnauthorized = async (authKey: string): Promise<boolean> => {
    // Cheap dedup against retry storms. We don't track per-authKey
    // separately on the network side — the platform refreshes ALL auths
    // on this integration in one call — but we DO want to suppress
    // duplicates per authKey because the listener can fire concurrent
    // refresh calls if multiple requests racing on different SNI hosts
    // each see 401.
    const now = Date.now();
    const last = lastRefreshAt.get(authKey) ?? 0;
    if (now - last < minRefreshIntervalMs) {
      logger.info("integration credential refresh suppressed (cooldown)", {
        integrationId: options.integrationId,
        authKey,
        cooldownMs: minRefreshIntervalMs,
        elapsedMs: now - last,
      });
      return false;
    }
    const existing = inflight.get(authKey);
    if (existing) return existing;
    // connect.tool re-login (P3): when a handler is registered for this
    // authKey, mint a fresh session via the login tool instead of POSTing the
    // platform refresh endpoint. Reuses the same cooldown + in-flight dedup so
    // a hot-looping reauth status can't hammer the login tool.
    const relogin = reloginHandlers.get(authKey);
    const promise = relogin ? runRelogin(authKey, relogin.handler) : doRefresh(authKey);
    inflight.set(authKey, promise);
    try {
      return await promise;
    } finally {
      inflight.delete(authKey);
    }
  };

  async function runRelogin(authKey: string, handler: () => Promise<boolean>): Promise<boolean> {
    let ok = false;
    try {
      ok = await handler();
    } catch (err) {
      logger.warn("integration connect-login re-login handler failed", {
        integrationId: options.integrationId,
        authKey,
        error: err instanceof Error ? err.message : String(err),
      });
      ok = false;
    }
    // Stamp the cooldown on every attempt (success or failure) so a failing
    // re-login can't be retried faster than the configured interval.
    lastRefreshAt.set(authKey, Date.now());
    if (ok) {
      logger.info("integration connect-login session re-minted", {
        integrationId: options.integrationId,
        authKey,
      });
    }
    return ok;
  }

  async function doRefresh(authKey: string): Promise<boolean> {
    const url = `${options.platformApiUrl}/internal/integration-credentials/${options.integrationId}/refresh`;
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.runToken}` },
      });
    } catch (err) {
      logger.warn("integration credential refresh fetch failed", {
        integrationId: options.integrationId,
        authKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    if (res.status === 410) {
      // Refresh token revoked — connection now flagged needsReconnection
      // on the platform. The integration's next call will return 401
      // again; we don't want to chase it forever.
      logger.warn("integration credential refresh revoked", {
        integrationId: options.integrationId,
        authKey,
      });
      // Mark cooldown so we don't retry for at least the full interval.
      lastRefreshAt.set(authKey, Date.now());
      return false;
    }
    if (!res.ok) {
      logger.warn("integration credential refresh non-OK status", {
        integrationId: options.integrationId,
        authKey,
        status: res.status,
      });
      return false;
    }
    let next: IntegrationCredentialsWire;
    try {
      next = normalizeIntegrationCredentialsWire(await res.json());
    } catch (err) {
      logger.warn("integration credential refresh malformed JSON", {
        integrationId: options.integrationId,
        authKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    // Replace the payload in place — the listener reads `current()` /
    // `deliveryPlans()` on every request, so the next inbound request
    // automatically sees the new credentials.
    payload = next;
    lastRefreshAt.set(authKey, Date.now());
    logger.info("integration credentials refreshed", {
      integrationId: options.integrationId,
      authKey,
      authCount: payload.auths.length,
    });
    return true;
  }

  const setSessionOutputs = (auth: ResolvedAuthCredentials, plan: HttpDeliveryPlan): void => {
    // Re-build the immutable wire payload around the freshly-captured
    // session. The auth becomes the only injectable auth; its delivery
    // plan + expiry are keyed by authKey so the planner / listener pick
    // them up on the next request.
    payload = {
      auths: [auth],
      deliveryPlans: { ...payload.deliveryPlans, [auth.authKey]: plan },
      expiresAtEpochMs: {
        ...payload.expiresAtEpochMs,
        [auth.authKey]: coerceExpiresAtToEpochMs(auth.expiresAt),
      },
    };
    logger.info("integration session outputs installed", {
      integrationId: options.integrationId,
      authKey: auth.authKey,
    });
  };

  return {
    current,
    deliveryPlans,
    refreshOnUnauthorized,
    snapshot: () => payload,
    setSessionOutputs,
    setActiveInputs: (bag: Record<string, string>, acquiring?: string) => {
      activeInputBag = bag;
      acquiringAuthKey = acquiring ?? null;
    },
    clearActiveInputs: () => {
      activeInputBag = null;
      acquiringAuthKey = null;
    },
    activeInputs: () => activeInputBag,
    setReloginHandler: (authKey, handler, reauthStatuses) => {
      reloginHandlers.set(authKey, {
        handler,
        reauthStatuses: new Set(reauthStatuses),
      });
    },
    shouldReauth: (authKey, status) => {
      const entry = reloginHandlers.get(authKey);
      return entry ? entry.reauthStatuses.has(status) : false;
    },
  };
}

/**
 * Fetch the initial credentials payload at sidecar boot. Returns null
 * when the integration has no `delivery.http` auths (the GET still
 * succeeds but `deliveryPlans` is empty — caller decides to skip the
 * MITM listener entirely).
 */
export async function fetchInitialIntegrationCredentials(
  integrationId: string,
  opts: { platformApiUrl: string; runToken: string; fetchFn?: typeof fetch },
): Promise<IntegrationCredentialsWire> {
  const fetchFn = opts.fetchFn ?? fetch;
  const url = `${opts.platformApiUrl}/internal/integration-credentials/${integrationId}`;
  const res = await fetchFn(url, {
    headers: { Authorization: `Bearer ${opts.runToken}` },
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      // ignore
    }
    throw new Error(
      detail || `Failed to fetch integration credentials for ${integrationId}: HTTP ${res.status}`,
    );
  }
  return normalizeIntegrationCredentialsWire(await res.json());
}
