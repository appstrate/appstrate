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
   * connect.dependsOn (P5) — merge OTHER integrations' resolved credentials
   * into THIS source's payload so the MITM planner can inject a dependency's
   * credential when the login tool hits that dependency's `authorizedUris`.
   * Each entry is appended to `payload.auths` and its delivery plan installed
   * under `deliveryPlans[authKey]`. The authKeys are namespaced
   * (`${depId}::${authKey}`) by the platform so they never collide with the
   * login integration's own auth — its substitution window + captured session
   * (distinct authKey, distinct authorizedUris) are unaffected.
   *
   * No relogin/refresh handler is registered for dependency auths (MVP): their
   * credentials are resolved fresh at connect-login start; a mid-login
   * dependency 401 is an accepted edge case (no reauth).
   */
  seedDependencyAuths(
    deps: ReadonlyArray<{
      auth: ResolvedAuthCredentials;
      plan: HttpDeliveryPlan;
    }>,
  ): void;
  /**
   * Open the transient-input substitution window. While a non-null bag is
   * active, the MITM listener substitutes `{{key}}` placeholders in the
   * outbound URL / body / headers (proxy-side) so the integration's login
   * tool never receives the raw secret. Fail-closed: an unresolved
   * placeholder refuses the request rather than forwarding a literal.
   */
  setActiveInputs(bag: Record<string, string>): void;
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

  const deliveryPlans = () => payload.deliveryPlans;

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
    if (res.status === 403) {
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
      next = (await res.json()) as IntegrationCredentialsWire;
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
        [auth.authKey]: auth.expiresAt ? Date.parse(auth.expiresAt) : null,
      },
    };
    logger.info("integration session outputs installed", {
      integrationId: options.integrationId,
      authKey: auth.authKey,
    });
  };

  const seedDependencyAuths = (
    deps: ReadonlyArray<{ auth: ResolvedAuthCredentials; plan: HttpDeliveryPlan }>,
  ): void => {
    if (deps.length === 0) return;
    const nextAuths = [...payload.auths];
    const nextPlans = { ...payload.deliveryPlans };
    const nextExpiry = { ...payload.expiresAtEpochMs };
    for (const { auth, plan } of deps) {
      nextAuths.push(auth);
      nextPlans[auth.authKey] = plan;
      nextExpiry[auth.authKey] = auth.expiresAt ? Date.parse(auth.expiresAt) : null;
    }
    payload = { auths: nextAuths, deliveryPlans: nextPlans, expiresAtEpochMs: nextExpiry };
    logger.info("integration dependency auths seeded into MITM source", {
      integrationId: options.integrationId,
      dependencyAuthKeys: deps.map((d) => d.auth.authKey),
    });
  };

  return {
    current,
    deliveryPlans,
    refreshOnUnauthorized,
    snapshot: () => payload,
    setSessionOutputs,
    seedDependencyAuths,
    setActiveInputs: (bag: Record<string, string>) => {
      activeInputBag = bag;
    },
    clearActiveInputs: () => {
      activeInputBag = null;
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
  return (await res.json()) as IntegrationCredentialsWire;
}
