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

import { logger } from "../lib/logger.ts";
import { notFound, gone, conflict, internalError, badGateway } from "../lib/errors.ts";
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
 * An EMPTY payload from this function means exactly one thing: the integration
 * declares no auth at all. Every state in which a credential was expected but
 * could not be produced throws — because the sidecar reads an empty payload as
 * "no `delivery.http` auths, skip the MITM listener entirely" and boots the run
 * anyway, so a silent empty return turns a broken connection into an agent
 * reporting "the API is unavailable" against a fleet of uncredentialed 401s.
 *
 * Throws ApiError on:
 *   - 404: integration not declared by the agent, not installed, or no
 *     connection for the actor (including a run-pinned connection that has
 *     since been deleted or unshared). Nothing exists to flag, so this is
 *     deliberately NOT the 410 below.
 *   - 409 `integration_auth_undeclared`: the connection's `auth_key` is not
 *     declared by the manifest VERSION this run is pinned to (auth renamed or
 *     removed since the connection was made). The credential is intact and may
 *     be valid under another version, so it is NOT flagged.
 *   - 410: the credential is dead and the connection has been flagged
 *     `needsReconnection` — refresh token revoked upstream, an unrefreshable
 *     auth on a forced refresh, or stored credentials that cannot be
 *     decrypted. The sidecar propagates it as a 401 to the integration so the
 *     LLM sees a clean "please re-connect" surface, and stops retrying.
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
    // The ONLY legitimate empty payload on this endpoint: the integration
    // genuinely declares no auth, so there is nothing to inject and nothing
    // has failed. Every other empty-looking state below is a broken one and
    // throws — an empty payload tells the sidecar "no `delivery.http` auths,
    // skip the MITM listener", which for a broken state means the run boots
    // and every upstream call goes out uncredentialed.
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
    // STATE A — nothing to decrypt. Either the row the run PINNED at kickoff is
    // no longer reachable (deleted, unshared, moved to another application), or
    // the actor never connected this integration at all. Both are 404: the
    // doc comment above already promises "no connection for the actor", there
    // is no row to flag `needsReconnection` on, and 410 would lie about one
    // having been flagged. Returning the empty payload here (the old
    // behaviour) was indistinguishable from "declares no auth" — the sidecar
    // skipped the MITM listener, every upstream call left uncredentialed, and
    // the agent reported a generic "the API is unavailable".
    logger.warn("Integration credentials unavailable — no accessible connection", {
      runId: context.runId,
      integrationId,
      declaredAuthKeys: Object.keys(auths),
      ...(snapshotEntry ? { pinnedConnectionId: snapshotEntry.connectionId } : {}),
      ...(snapshotEntry ? { pinnedSource: snapshotEntry.source } : {}),
    });
    throw notFound(
      snapshotEntry
        ? `Integration '${integrationId}': the connection pinned for this run ` +
            `(${snapshotEntry.connectionId}, source '${snapshotEntry.source}') is no longer ` +
            `reachable — it was deleted, unshared, or moved to another application after the ` +
            `run started. Re-connect '${integrationId}' and relaunch the run.`
        : `Integration '${integrationId}' has no connection for this run's actor ` +
            `(declared auths: ${Object.keys(auths).join(", ")}). Connect '${integrationId}' ` +
            `for this user, then relaunch the run.`,
    );
  }

  const authKey = connection.authKey;
  const authDef = auths[authKey];
  if (!authDef) {
    // STATE B — the connection exists and is readable, but the manifest VERSION
    // this run is pinned to no longer declares the auth it was created against
    // (renamed/removed auth key). Nothing can be injected: without the
    // declaration there is no `delivery.http` plan and no `authorized_uris`.
    //
    // 409, matching the vocabulary the run-definition guards in
    // `routes/internal.ts` already established for "the state this run was
    // pinned to no longer lines up" (`run_definition_gone` / `run_agent_deleted`).
    // NOT 410: the credential itself is intact and may still be valid under
    // another manifest version, so flagging `needsReconnection` — which 410
    // promises — would destroy a working connection over a manifest edit.
    // NOT 404: 404 on this endpoint already means "not a dependency / not
    // installed", and stacking a third unrelated cause behind it is exactly the
    // illegibility this path exists to remove.
    logger.warn("Integration connection's auth key is not declared by the pinned manifest", {
      runId: context.runId,
      integrationId,
      authKey,
      declaredAuthKeys: Object.keys(auths),
      manifestVersion: pinnedManifestVersionLabel(context, integrationId),
    });
    throw conflict(
      "integration_auth_undeclared",
      `Integration '${integrationId}' version ${pinnedManifestVersionLabel(context, integrationId)} ` +
        `does not declare auth '${authKey}', which this run's connection was created against ` +
        `(declared auths: ${Object.keys(auths).join(", ")}). The auth was renamed or removed ` +
        `after the connection was made: re-connect '${integrationId}' against a declared auth, ` +
        `or pin the run to an integration version that still declares '${authKey}'.`,
    );
  }

  // The credential is terminally unusable and the connection must be re-made.
  // Two entry classes, one behaviour so they cannot drift:
  //   • a FORCED refresh (the sidecar already saw an upstream 401) that cannot
  //     recover the credential — an oauth2 auth with no refresh client, or any
  //     non-oauth2 auth, which has nothing to refresh;
  //   • a credential nobody can decrypt (below), on ANY read — forced or not.
  // Both flag the connection for re-connect and surface 410 so the sidecar
  // stops retrying and the next-launch readiness gate fires. (A revoked refresh
  // token is handled inline further down, with the same flag + status.)
  const flagTerminalAndThrow = async (reason: string): Promise<never> => {
    await markIntegrationConnectionNeedsReconnection(connection.id);
    logger.warn("Integration credential terminally unusable — flagging needsReconnection", {
      runId: context.runId,
      integrationId,
      authKey,
      connectionId: connection.id,
      forced: options.forceRefresh === true,
      reason,
    });
    throw gone(
      "INTEGRATION_CONNECTION_NEEDS_RECONNECTION",
      `Integration '${integrationId}' auth '${authKey}' is unusable (${reason}) — ` +
        `the connection has been flagged as needing re-connection. Re-connect ` +
        `'${integrationId}' and relaunch the run.`,
    );
  };

  let fields = decryptIntegrationConnectionFields(
    connection.credentialsEncrypted,
    integrationId,
    authKey,
  );
  if (!fields) {
    // STATE C — the stored ciphertext cannot be decrypted (rotated
    // `CONNECTION_ENCRYPTION_KEY` without re-encrypting, corrupted blob, an
    // envelope this build cannot read). A credential nobody can read is dead
    // regardless of how we got here, so this is the terminal path: flag +
    // 410. The old silent empty return made this state answer 200 even on a
    // FORCED refresh — i.e. the sidecar had already seen a 401 and we told it
    // "nothing to inject, carry on".
    // `return` rather than a bare `await`: the helper's `Promise<never>` does
    // not narrow `fields` on its own, and everything below reads it non-null.
    return flagTerminalAndThrow("stored credentials could not be decrypted");
  }

  let expiresAtEpochMs: number | null = connection.expiresAt
    ? connection.expiresAt.getTime()
    : null;

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
  } else if (options.forceRefresh === true) {
    // A FORCED refresh of a NON-oauth2 auth (api_key / basic / a custom auth
    // with no connect.tool re-login handler — those route to re-login in the
    // sidecar and never reach here). There is nothing to refresh and the
    // sidecar only forces a refresh after a 401, so the credential is dead.
    // This is what restores the "any terminal 401 invalidates the connection"
    // guarantee for non-OAuth integrations — without a separate report path.
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
      // The response stays a bare 500 (the caller is the sidecar, not a human,
      // and the manifest is the platform's own data — a broken one is a server
      // fault). The Zod issues ride the log line instead of being dropped two
      // statements from the data: the operator reading this warning is the one
      // who has to go fix the field it names.
      logger.warn("integration manifest fails validation in credentials resolver", {
        integrationId,
        issues: res.failure.issues,
      });
      throw internalError();
  }
}

/**
 * Printable label for the integration manifest version this run reads (#686):
 * the semver frozen at kickoff, or the snapshot's `source` (`draft`/`system`,
 * which carry no semver), or `"draft"` when nothing was frozen at all (legacy /
 * soft-resolved runs). Used in the error messages that report a
 * manifest/connection mismatch, where naming the version IS the diagnosis —
 * "auth 'primary' is not declared" is unactionable without knowing by what.
 */
function pinnedManifestVersionLabel(
  context: { resolvedIntegrationVersions?: Record<string, ResolvedIntegrationVersion> | null },
  integrationId: string,
): string {
  const entry = context.resolvedIntegrationVersions?.[integrationId] ?? null;
  if (!entry) return "draft";
  return entry.version ?? entry.source;
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
