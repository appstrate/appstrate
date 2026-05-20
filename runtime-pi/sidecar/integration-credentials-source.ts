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
  ResolvedAuthCredentials,
} from "@appstrate/connect/integration-credentials";
import type { MitmCredentialSource } from "./integration-mitm-listener.ts";
import { logger } from "./logger.ts";

/**
 * Wire-level payload returned by both endpoints. The `auths[]` shape is
 * exactly the `IntegrationCredentialsPayload` the MITM planner consumes
 * — `deliveryPlans` and `expiresAtEpochMs` are sibling maps the sidecar
 * needs but the planner doesn't.
 */
export interface IntegrationCredentialsWire {
  auths: ReadonlyArray<ResolvedAuthCredentials>;
  deliveryPlans: Readonly<Record<string, HttpDeliveryPlan>>;
  expiresAtEpochMs: Readonly<Record<string, number | null>>;
}

export interface CreateIntegrationCredentialsSourceOptions {
  /** Package id (e.g. `@vendor/integration`). */
  packageId: string;
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
  // Last successful refresh per authKey (or "*" for full-payload refreshes).
  const lastRefreshAt = new Map<string, number>();
  // Coalesce concurrent refreshes for the same authKey.
  const inflight = new Map<string, Promise<boolean>>();

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
        packageId: options.packageId,
        authKey,
        cooldownMs: minRefreshIntervalMs,
        elapsedMs: now - last,
      });
      return false;
    }
    const existing = inflight.get(authKey);
    if (existing) return existing;
    const promise = doRefresh(authKey);
    inflight.set(authKey, promise);
    try {
      return await promise;
    } finally {
      inflight.delete(authKey);
    }
  };

  async function doRefresh(authKey: string): Promise<boolean> {
    const url = `${options.platformApiUrl}/internal/integration-credentials/${options.packageId}/refresh`;
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.runToken}` },
      });
    } catch (err) {
      logger.warn("integration credential refresh fetch failed", {
        packageId: options.packageId,
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
        packageId: options.packageId,
        authKey,
      });
      // Mark cooldown so we don't retry for at least the full interval.
      lastRefreshAt.set(authKey, Date.now());
      return false;
    }
    if (!res.ok) {
      logger.warn("integration credential refresh non-OK status", {
        packageId: options.packageId,
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
        packageId: options.packageId,
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
      packageId: options.packageId,
      authKey,
      authCount: payload.auths.length,
    });
    return true;
  }

  return {
    current,
    deliveryPlans,
    refreshOnUnauthorized,
    snapshot: () => payload,
  };
}

/**
 * Fetch the initial credentials payload at sidecar boot. Returns null
 * when the integration has no `delivery.http` auths (the GET still
 * succeeds but `deliveryPlans` is empty — caller decides to skip the
 * MITM listener entirely).
 */
export async function fetchInitialIntegrationCredentials(
  packageId: string,
  opts: { platformApiUrl: string; runToken: string; fetchFn?: typeof fetch },
): Promise<IntegrationCredentialsWire> {
  const fetchFn = opts.fetchFn ?? fetch;
  const url = `${opts.platformApiUrl}/internal/integration-credentials/${packageId}`;
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
      detail || `Failed to fetch integration credentials for ${packageId}: HTTP ${res.status}`,
    );
  }
  return (await res.json()) as IntegrationCredentialsWire;
}
