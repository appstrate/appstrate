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
 *      structured 410; transient failures bubble a 502.
 *   3. Resolve the live HTTP delivery plan via `resolveHttpDelivery`.
 *   4. Build a `ResolvedAuthCredentials` entry + the matching plan.
 *
 * Output is shaped to feed straight into the sidecar's
 * `MitmCredentialSource.current()` and `.deliveryPlans()`.
 */

import {
  resolveAfpsHttpDelivery,
  RefreshError,
  type AfpsHttpDelivery as ConnectAfpsHttpDelivery,
  type HttpDeliveryPlan,
  type ResolvedAuthCredentials,
  type IntegrationCredentialsWire,
} from "@appstrate/connect";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { expandScopesGranted } from "@appstrate/core/integration";
import { OAUTH_REFRESH_LEAD_MS } from "@appstrate/core/sidecar-types";
import type { AfpsManifestAuth } from "./integration-manifest-helpers.ts";
import { getRunEphemeralCredentials } from "./run-ephemeral-credentials.ts";

import { logger } from "../lib/logger.ts";
import { notFound, gone, internalError, badGateway } from "../lib/errors.ts";
import type { Actor } from "../lib/actor.ts";
import {
  buildIntegrationOAuthRefreshContext,
  decryptIntegrationConnectionFields,
  refreshAndClassify,
} from "./integration-token-refresh.ts";
import {
  assertIntegrationActive,
  selectAccessibleConnection,
  markIntegrationConnectionNeedsReconnection,
} from "./integration-connections.ts";
import { computeRequiredScopes } from "./integration-scope-resolver.ts";
import {
  readIntegrationManifestForRun,
  type ResolvedIntegrationVersion,
} from "./integration-service.ts";

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
 *   - 410: connection's refresh token was revoked upstream (sidecar
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
    /**
     * Snapshot from `runs.resolved_integration_versions` (#686). When present,
     * `[integrationId]` pins the manifest VERSION this resolver reads — so the
     * delivery/auth plan a mid-run MITM refresh injects matches the version the
     * spawn resolver used at kickoff. Absent (legacy / soft-resolved) → draft.
     */
    resolvedIntegrationVersions?: Record<string, ResolvedIntegrationVersion> | null;
  },
  options: ResolveLiveCredentialsOptions = {},
): Promise<IntegrationCredentialsWire> {
  if (!context.actor) {
    // Scheduled runs without an actor cannot connect to user-scoped
    // integrations; refuse early.
    throw notFound(`Integration '${integrationId}' has no actor-scoped connection for this run`);
  }

  const manifest = await loadIntegrationManifest(
    integrationId,
    context.resolvedIntegrationVersions?.[integrationId] ?? null,
  );
  await assertIntegrationActive(integrationId, context.applicationId);

  const auths = (manifest.auths ?? {}) as Record<string, AfpsManifestAuth>;
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

  // Merge run-scoped ephemeral fields (browser-captured session tokens)
  // OVER the durable connection's fields. This is how an in-run acquired
  // secret reaches the injection path without being persisted: the
  // durable connection holds only the stable login secret, the captured
  // token lives run-scoped (see `run-ephemeral-credentials.ts`), and the
  // delivery template resolves against the merged bag. No-op for
  // durable-only integrations.
  const ephemeral = getRunEphemeralCredentials(context.runId, integrationId, authKey);
  if (ephemeral) fields = { ...fields, ...ephemeral };

  let expiresAtEpochMs: number | null = connection.expiresAt
    ? connection.expiresAt.getTime()
    : null;

  // A FORCED refresh only ever happens after the sidecar saw an upstream 401.
  // When the credential cannot be recovered (a revoked refresh token is handled
  // inline below; here: an oauth2 auth with no refresh client, or any
  // non-oauth2 auth which has nothing to refresh), the credential is dead:
  // flag the connection for re-connect and surface 410 so the sidecar stops
  // retrying and the next-launch readiness gate fires. Shared by both terminal
  // branches so they cannot drift.
  // An auth marked ephemeral holds a RUN-ACQUIRED secret (a
  // browser-captured session token, merged from the run-scoped store
  // above). On the forced-refresh path below, the sidecar force-refreshes
  // AFTER a 401 — and by then capture has populated the run-scoped store,
  // so the ephemeral merge above already put the fresh token in `fields`.
  // For such an auth a forced refresh is therefore NOT terminal: we skip
  // `flagTerminalAndThrow` entirely and fall through to build the delivery
  // with the fresh token. (Flagging would also be self-defeating — it
  // blocks the next kickoff, but re-capturing requires a run: deadlock.)
  const isEphemeralAuth =
    (authDef as { _meta?: Record<string, unknown> })._meta?.["dev.appstrate/ephemeral"] !==
    undefined;

  const flagTerminalAndThrow = async (reason: string): Promise<never> => {
    await markIntegrationConnectionNeedsReconnection(connection.id);
    logger.warn(
      "Integration credential unrefreshable on forced refresh — flagging needsReconnection",
      {
        runId: context.runId,
        integrationId,
        authKey,
        reason,
      },
    );
    throw gone(
      "INTEGRATION_CONNECTION_NEEDS_RECONNECTION",
      `Integration '${integrationId}' auth '${authKey}' could not be refreshed (${reason}) — needs re-connection`,
    );
  };

  // Decide whether to refresh.
  const needsRefresh =
    authDef.type === "oauth2" &&
    (options.forceRefresh === true || isWithinLeadWindow(connection.expiresAt));

  if (needsRefresh) {
    let refreshContext;
    try {
      refreshContext = await buildIntegrationOAuthRefreshContext(
        integrationId,
        authKey,
        authDef,
        context.applicationId,
        connection.clientRef,
      );
    } catch (err) {
      // Transient token-endpoint discovery failure on an issuer-only manifest —
      // NEVER terminal (the row stays untouched; the next run re-discovers).
      if (err instanceof RefreshError && err.kind === "transient") {
        if (options.forceRefresh === true) {
          // Forced = the sidecar already saw an upstream 401, so the cached
          // token is known-bad. We can't refresh right now → 502 so the sidecar
          // keeps the original 401 and backs off.
          logger.warn("Integration token endpoint discovery transient failure (forced refresh)", {
            runId: context.runId,
            integrationId,
            authKey,
            error: err.message,
          });
          throw badGateway(
            `Integration '${integrationId}' auth '${authKey}' token endpoint discovery failed (transient)`,
          );
        }
        // Proactive (lead-window) path: the cached token is still valid (we're
        // merely ahead of expiry). A discovery blip must NOT fail the run —
        // serve the cached credential unchanged and let a later real 401 drive
        // forced re-discovery. `refreshContext` left null → refresh skipped.
        logger.info(
          "Integration token endpoint discovery transient failure on proactive refresh — serving cached credential",
          { runId: context.runId, integrationId, authKey, error: err.message },
        );
        refreshContext = null;
      } else {
        throw err;
      }
    }
    if (refreshContext) {
      // Re-acquisition = fast-path refresh_token POST. `needsRefresh`
      // already gated type=oauth2, so this is the only refreshable auth.
      const classified = await refreshAndClassify(
        connection.id,
        integrationId,
        authKey,
        connection.credentialsEncrypted,
        refreshContext,
      );
      if (classified.status === "revoked") {
        // 410 here propagates to the sidecar, which translates back
        // to a 401 to the integration's MCP client. The
        // needsReconnection flag has already been set by the helper.
        // Matches the model-provider token endpoint's revoked semantics.
        logger.warn("Integration token refresh revoked", {
          runId: context.runId,
          integrationId,
          authKey,
          status: classified.error.status,
        });
        throw gone(
          "INTEGRATION_CONNECTION_NEEDS_RECONNECTION",
          `Integration '${integrationId}' auth '${authKey}' needs re-connection (refresh token revoked)`,
        );
      }
      if (classified.status === "transient") {
        // Transient failure (network, upstream 5xx, parse error). The
        // cached credential may still be usable; surfacing 502 lets the
        // sidecar's `refreshOnUnauthorized` cooldown back off without
        // poisoning the connection row.
        const err = classified.error;
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

      const refreshed = classified.result;
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
          integrationId: integrationId,
          authKey,
        });
        // Expand the granted set through the manifest `implies` hierarchy
        // before diffing — a parent grant (e.g. GitHub `repo`) covers the
        // children it implies (`public_repo`), so a raw membership check
        // would falsely flag the connection as below the required floor.
        const expandedGranted = expandScopesGranted(granted, manifest, authKey);
        const missing = required.filter((s) => !expandedGranted.includes(s));
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
    } else if (options.forceRefresh === true) {
      // OAuth2 but `buildIntegrationOAuthRefreshContext` returned null — no
      // per-app OAuth client (DCR / system-wide / shared) or no token_endpoint,
      // so the token can never be refreshed. Terminal.
      await flagTerminalAndThrow("no OAuth client or token endpoint");
    }
  } else if (options.forceRefresh === true && !isEphemeralAuth) {
    // A FORCED refresh of a NON-oauth2 auth (api_key / basic / a custom auth
    // with no connect.tool re-login handler — those route to re-login in the
    // sidecar and never reach here). There is nothing to refresh and the
    // sidecar only forces a refresh after a 401, so the credential is dead.
    // This is what restores the "any terminal 401 invalidates the connection"
    // guarantee for non-OAuth integrations — without a separate report path.
    //
    // Ephemeral auths are exempt (guarded above): their forced refresh
    // re-reads the run-scoped store (the token was captured mid-run), so
    // it falls through here and returns the fresh merged credentials — a
    // 401 is recoverable, not terminal.
    await flagTerminalAndThrow(`auth type '${authDef.type}' is not refreshable`);
  }

  const http = authDef.delivery?.http;
  if (http) {
    const plan = resolveAfpsHttpDelivery(authDef.type, fields, http as ConnectAfpsHttpDelivery);
    if (plan) {
      out.deliveryPlans[authKey] = plan;
    }
  }

  out.auths.push({
    authKey,
    authType: authDef.type,
    fields: Object.freeze({ ...fields }),
    authorizedUris: Object.freeze([...(authDef.authorized_uris ?? [])]),
    // AFPS §7.3 (RFC 8707) names this field `resource`.
    ...(authDef.resource !== undefined ? { resource: authDef.resource } : {}),
    ...(connection.expiresAt ? { expiresAt: connection.expiresAt.toISOString() } : {}),
    ...(connection.scopesGranted.length > 0
      ? { scopesGranted: Object.freeze([...connection.scopesGranted]) }
      : {}),
  });
  out.expiresAtEpochMs[authKey] = expiresAtEpochMs;

  return out;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

async function loadIntegrationManifest(
  integrationId: string,
  frozenVersion: ResolvedIntegrationVersion | null,
): Promise<IntegrationManifest> {
  // Read AT the version frozen for this run (#686) so the delivery/auth plan
  // matches the spawn. No frozen entry → draft (legacy / soft-resolved).
  const res = await readIntegrationManifestForRun(integrationId, frozenVersion);
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

/**
 * Serialize the resolver's typed wire payload to the AFPS snake_case
 * HTTP response shape. The TS `IntegrationCredentialsWire` source-of-truth
 * type (in `@appstrate/connect/integration-credentials`) stays camelCase as
 * a TS-internal naming convention; this function is the JSON serialization
 * boundary that flips the field names to AFPS snake_case before they
 * cross the wire to the sidecar.
 *
 * Field mapping (TS internal camelCase → AFPS snake_case wire):
 *   authKey               → auth_key
 *   authType              → auth_type
 *   authorizedUris        → authorized_uris
 *   scopesGranted         → scopes_granted
 *   identityClaims        → identity_claims
 *   expiresAt             → expires_at
 *   deliveryPlans         → delivery_plans
 *   expiresAtEpochMs      → expires_at_epoch_ms
 *   headerName            → header_name           (per delivery plan)
 *   headerPrefix          → header_prefix         (per delivery plan)
 *   allowServerOverride   → allow_server_override (per delivery plan)
 *
 * `resource` (RFC 8707) passes through unchanged.
 */
export function serializeIntegrationCredentialsWire(
  wire: IntegrationCredentialsWire,
): Record<string, unknown> {
  const auths = wire.auths.map((a) => {
    const out: Record<string, unknown> = {
      auth_key: a.authKey,
      auth_type: a.authType,
      fields: a.fields,
      authorized_uris: a.authorizedUris,
    };
    if (a.resource !== undefined) out.resource = a.resource;
    if (a.expiresAt !== undefined) out.expires_at = a.expiresAt;
    if (a.scopesGranted !== undefined) out.scopes_granted = a.scopesGranted;
    if (a.identityClaims !== undefined) out.identity_claims = a.identityClaims;
    return out;
  });

  const delivery_plans: Record<string, unknown> = {};
  for (const [k, plan] of Object.entries(wire.deliveryPlans)) {
    delivery_plans[k] = {
      header_name: plan.headerName,
      header_prefix: plan.headerPrefix,
      value: plan.value,
      allow_server_override: plan.allowServerOverride,
    };
  }

  return {
    auths,
    delivery_plans,
    expires_at_epoch_ms: wire.expiresAtEpochMs,
  };
}
