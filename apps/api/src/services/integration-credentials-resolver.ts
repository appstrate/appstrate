// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.5 — live integration credentials resolver for the sidecar's MITM
 * `MitmCredentialSource`. Backs both `GET /internal/integration-credentials/
 * {scope}/{name}` (read-current) and `POST .../refresh` (force-refresh-then-read).
 *
 * For each declared auth on the integration's manifest:
 *
 *   1. Find the connection row for the run's actor.
 *   2. If the auth is OAuth2 AND (forced OR within the lead window),
 *      call {@link forceRefreshIntegrationConnection}. RefreshError
 *      with `kind="revoked"` flips needsReconnection and bubbles a
 *      structured 403; transient failures bubble a 502.
 *   3. Resolve the live HTTP delivery plan via `resolveHttpDelivery`.
 *   4. Build a `ResolvedAuthCredentials` entry + the matching plan.
 *
 * Output is shaped to feed straight into the sidecar's
 * `MitmCredentialSource.current()` and `.deliveryPlans()`.
 */

import {
  RefreshError,
  resolveHttpDelivery,
  type HttpDeliveryPlan,
  type ResolvedAuthCredentials,
  type IntegrationCredentialsWire,
} from "@appstrate/connect";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { OAUTH_REFRESH_LEAD_MS } from "@appstrate/core/sidecar-types";

import { logger } from "../lib/logger.ts";
import { notFound, forbidden, internalError, badGateway } from "../lib/errors.ts";
import type { Actor } from "../lib/actor.ts";
import {
  buildIntegrationOAuthRefreshContext,
  decryptIntegrationConnectionFields,
} from "./integration-token-refresh.ts";
import { resolveStrategy } from "./connect/registry.ts";
import {
  assertIntegrationActive,
  selectAccessibleConnection,
  markIntegrationConnectionNeedsReconnection,
} from "./integration-connections.ts";
import { computeRequiredScopes } from "./integration-scope-resolver.ts";
import { fetchIntegrationManifest } from "./integration-service.ts";

/** Mutable builder for the wire payload (returned widened to the readonly wire type). */
interface MutableCredentialsWire {
  auths: ResolvedAuthCredentials[];
  deliveryPlans: Record<string, HttpDeliveryPlan>;
  expiresAtEpochMs: Record<string, number | null>;
}

export interface ResolveLiveCredentialsOptions {
  /** When true, refresh OAuth tokens regardless of remaining lifetime. */
  forceRefresh?: boolean;
}

/**
 * Throws ApiError on:
 *   - 404: integration not declared by the agent, not installed, or no
 *     connection for the actor.
 *   - 403: connection's refresh token was revoked upstream (sidecar
 *     should propagate as 401 to the integration so the LLM sees a
 *     clean "please re-connect" surface).
 *   - 502: transient OAuth refresh failure (network, upstream 5xx, etc).
 *     The cached credential may still be valid; the sidecar treats it as
 *     retry-later and the listener's `refreshOnUnauthorized` cooldown
 *     keeps a flapping upstream from hammering this endpoint.
 */
export async function resolveLiveIntegrationCredentials(
  integrationId: string,
  context: {
    runId: string;
    orgId: string;
    applicationId: string;
    agentPackageId: string;
    actor: Actor | null;
    /**
     * Snapshot from `runs.resolved_connections`. When present, the
     * `[integrationId].connectionId` entry pins which row the MITM listener
     * decrypts — so the cascade's pick (admin pin / run override /
     * schedule override / member pin / auto fallback) survives past
     * kickoff into the live credential surface. One connection per
     * integration; its authKey drives which `manifest.auths[X]`
     * declaration is materialised.
     */
    resolvedConnections?: Record<string, { connectionId: string; source: string }> | null;
  },
  options: ResolveLiveCredentialsOptions = {},
): Promise<IntegrationCredentialsWire> {
  if (!context.actor) {
    // Scheduled runs without an actor cannot connect to user-scoped
    // integrations; refuse early.
    throw notFound(`Integration '${integrationId}' has no actor-scoped connection for this run`);
  }

  const manifest = await loadIntegrationManifest(integrationId);
  await assertIntegrationActive(integrationId, context.applicationId);

  const auths = manifest.auths ?? {};
  if (Object.keys(auths).length === 0) {
    return { auths: [], deliveryPlans: {}, expiresAtEpochMs: {} };
  }

  const out: MutableCredentialsWire = {
    auths: [],
    deliveryPlans: {},
    expiresAtEpochMs: {},
  };

  // Flat model: one connection per integration, chosen by the cascade
  // at kickoff. The snapshot pins which row to load; without a snapshot
  // (legacy/manual paths) fall back to the actor's accessible connections
  // (first-found across declared auths — matches the spawn resolver).
  const snapshotEntry = context.resolvedConnections?.[integrationId] ?? null;
  const connection = await selectAccessibleConnection(
    integrationId,
    Object.keys(auths),
    snapshotEntry?.connectionId ?? null,
    { applicationId: context.applicationId, actor: context.actor },
  );
  if (!connection) {
    return out;
  }

  const authKey = connection.authKey;
  const authDef = auths[authKey];
  // Falls through to the empty `out` when the connection's authKey no longer
  // maps to a declared auth (manifest renamed since the connection was created).
  if (!authDef) return out;

  let fields = decryptIntegrationConnectionFields(
    connection.credentialsEncrypted,
    integrationId,
    authKey,
  );
  if (!fields) return out;

  let expiresAtEpochMs: number | null = connection.expiresAt
    ? connection.expiresAt.getTime()
    : null;

  // Decide whether to refresh.
  const needsRefresh =
    authDef.type === "oauth2" &&
    (options.forceRefresh === true || isWithinLeadWindow(connection.expiresAt));

  if (needsRefresh) {
    const refreshContext = await buildIntegrationOAuthRefreshContext(
      integrationId,
      authKey,
      authDef,
      context.applicationId,
    );
    if (refreshContext) {
      try {
        // Single re-acquisition path — OAuth2Strategy.reacquire wraps the
        // fast-path refresh_token POST. needsRefresh already gated type=oauth2,
        // so the connect.tool OrchestratedStrategy is never reached here and no
        // connect-run executor is constructed on this hot path.
        const refreshed = await resolveStrategy(authDef).reacquire!({
          connectionId: connection.id,
          packageId: integrationId,
          authKey,
          credentialsEncrypted: connection.credentialsEncrypted,
          refreshContext,
        });
        fields = refreshed.fields;
        expiresAtEpochMs = refreshed.expiresAt ? refreshed.expiresAt.getTime() : null;

        // Niveau 2 Phase 6 — IdP-side scope shrink awareness. When the
        // refresh response narrowed `scopesGranted` (user revoked some
        // permissions in their account settings between issuance and
        // refresh), cross-check against the union of `requiredScopes`
        // across every installed agent and flip `needsReconnection`
        // if the actor has dropped below that floor. Fast-path: skip
        // the agent scan unless the refresh actually shrank scopes.
        if (refreshed.shrinkDetected && refreshed.scopesGranted !== null) {
          const granted = refreshed.scopesGranted;
          const { required } = await computeRequiredScopes({
            scope: { orgId: context.orgId, applicationId: context.applicationId },
            integrationPackageId: integrationId,
            authKey,
          });
          const missing = required.filter((s) => !granted.includes(s));
          if (missing.length > 0) {
            await markIntegrationConnectionNeedsReconnection(connection.id);
            logger.warn("Integration scope shrink dropped below required floor", {
              runId: context.runId,
              integrationId,
              authKey,
              granted,
              required,
              missing,
            });
          } else {
            logger.info("Integration scope shrink absorbed (still covers required)", {
              runId: context.runId,
              integrationId,
              authKey,
              granted,
              required,
            });
          }
        }
      } catch (err) {
        if (err instanceof RefreshError && err.kind === "revoked") {
          // 403 here propagates to the sidecar, which translates back
          // to a 401 to the integration's MCP client. The
          // needsReconnection flag has already been set by the helper.
          logger.warn("Integration token refresh revoked", {
            runId: context.runId,
            integrationId,
            authKey,
            status: err.status,
          });
          throw forbidden(
            `Integration '${integrationId}' auth '${authKey}' needs re-connection (refresh token revoked)`,
          );
        }
        // Transient failure (network, upstream 5xx, parse error). The
        // cached credential may still be usable; surfacing 502 lets the
        // sidecar's `refreshOnUnauthorized` cooldown back off without
        // poisoning the connection row.
        logger.warn("Integration token refresh transient error", {
          runId: context.runId,
          integrationId,
          authKey,
          error: err instanceof Error ? err.message : String(err),
        });
        throw badGateway(
          `Integration '${integrationId}' auth '${authKey}' token refresh failed upstream (transient)`,
        );
      }
    }
  }

  const http = authDef.delivery?.http;
  if (http) {
    const plan = resolveHttpDelivery(authDef.type, fields, http);
    if (plan) {
      out.deliveryPlans[authKey] = plan;
    }
  }

  out.auths.push({
    authKey,
    authType: authDef.type,
    fields: Object.freeze({ ...fields }),
    authorizedUris: Object.freeze([...authDef.authorizedUris]),
    ...(authDef.audience !== undefined ? { audience: authDef.audience } : {}),
    ...(connection.expiresAt ? { expiresAt: connection.expiresAt.toISOString() } : {}),
    ...(connection.scopesGranted.length > 0
      ? { scopesGranted: Object.freeze([...connection.scopesGranted]) }
      : {}),
  });
  out.expiresAtEpochMs[authKey] = expiresAtEpochMs;

  return out;
}

// ─────────────────────────────────────────────
// connect.dependsOn — cross-integration credential injection
// ─────────────────────────────────────────────

/**
 * One resolved dependency auth, ready to inject. Mirrors the shape embedded in
 * {@link IntegrationSpawnSpec.connectLogin.dependsOnAuths} — the `authKey` is
 * namespaced (`${depId}::${authKey}`) so it can never collide with the login
 * integration's own auth in the merged MITM payload.
 */
export interface DependsOnAuth {
  authKey: string;
  authType: string;
  fields: Record<string, string>;
  authorizedUris: string[];
  deliveryPlan: {
    headerName: string;
    headerPrefix: string;
    value: string;
    allowServerOverride: boolean;
  };
}

/**
 * Resolve `connect.dependsOn` into ready-to-inject credentials for the login
 * tool's MITM source.
 *
 * For each dependency integration id, resolve the SAME actor's accessible
 * connection, decrypt its credential fields, and build one {@link DependsOnAuth}
 * per declared auth that yields a non-null HTTP delivery plan. The resulting
 * `authKey` is namespaced (`${depId}::${authKey}`) so the merged MITM payload
 * keeps the dependency's auth distinct from the login integration's own auth.
 *
 * A dependency is SKIPPED (logged at info, not fatal) when it:
 *   - has no manifest / isn't an integration / fails validation,
 *   - isn't connected for the actor,
 *   - has no auth with an injectable `delivery.http` plan (the login tool then
 *     simply fails to reach it — surfaced as a login failure, not a run abort).
 *
 * Bounded by the manifest schema's `dependsOn` max (8). OAuth refresh is NOT
 * performed here (MVP): dependency credentials are resolved fresh at
 * connect-login start; a mid-login dependency 401 is an accepted edge case.
 */
export async function resolveDependsOnAuths(
  context: { applicationId: string; actor: Actor },
  dependsOn: readonly string[],
): Promise<DependsOnAuth[]> {
  const out: DependsOnAuth[] = [];
  for (const depId of dependsOn) {
    const res = await fetchIntegrationManifest(depId);
    if (!res.ok) {
      logger.info("connect.dependsOn dependency manifest unavailable; skipping", {
        dependencyId: depId,
        reason: res.failure.kind,
      });
      continue;
    }
    const auths = res.manifest.auths ?? {};
    const authKeys = Object.keys(auths);
    if (authKeys.length === 0) {
      logger.info("connect.dependsOn dependency declares no auth; skipping", {
        dependencyId: depId,
      });
      continue;
    }

    // One connection per integration (flat model). No resolver snapshot on the
    // connect-login path — fall back to the actor's accessible connection.
    const connection = await selectAccessibleConnection(depId, authKeys, null, {
      applicationId: context.applicationId,
      actor: context.actor,
    });
    if (!connection) {
      logger.info("connect.dependsOn dependency not connected for actor; skipping", {
        dependencyId: depId,
      });
      continue;
    }

    const authDef = auths[connection.authKey];
    if (!authDef) {
      logger.info("connect.dependsOn dependency connection points at unknown authKey; skipping", {
        dependencyId: depId,
        authKey: connection.authKey,
      });
      continue;
    }

    const http = authDef.delivery?.http;
    if (!http) {
      logger.info("connect.dependsOn dependency auth has no delivery.http; skipping", {
        dependencyId: depId,
        authKey: connection.authKey,
      });
      continue;
    }

    const fields = decryptIntegrationConnectionFields(
      connection.credentialsEncrypted,
      depId,
      connection.authKey,
    );
    if (!fields) continue;

    const plan = resolveHttpDelivery(authDef.type, fields, http);
    if (!plan) {
      logger.info("connect.dependsOn dependency delivery.http produced no plan; skipping", {
        dependencyId: depId,
        authKey: connection.authKey,
        authType: authDef.type,
      });
      continue;
    }

    out.push({
      authKey: `${depId}::${connection.authKey}`,
      authType: authDef.type,
      fields,
      authorizedUris: [...authDef.authorizedUris],
      deliveryPlan: {
        headerName: plan.headerName,
        headerPrefix: plan.headerPrefix,
        value: plan.value,
        allowServerOverride: plan.allowServerOverride,
      },
    });
  }
  return out;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

async function loadIntegrationManifest(integrationId: string): Promise<IntegrationManifest> {
  const res = await fetchIntegrationManifest(integrationId);
  if (res.ok) return res.manifest;
  switch (res.failure.kind) {
    case "not_found":
      throw notFound(`Integration '${integrationId}' not found`);
    case "not_integration":
      throw notFound(`Package '${integrationId}' is not an integration`);
    case "invalid_manifest":
      logger.warn("integration manifest fails validation in credentials resolver", {
        integrationId,
      });
      throw internalError();
  }
}

function isWithinLeadWindow(expiresAt: Date | null): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() - Date.now() < OAUTH_REFRESH_LEAD_MS;
}
