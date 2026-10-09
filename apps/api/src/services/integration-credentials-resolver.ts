// SPDX-License-Identifier: Apache-2.0

/**
 * Live integration credentials resolver for the sidecar's MITM `MitmCredentialSource`. Backs both
 * `GET /internal/integration-credentials/{scope}/{name}` (a read) and `POST .../refresh` (after an
 * upstream 401).
 *
 * For the ONE bound connection the caller names (`connection_id`):
 *
 *   1. Find the connection row for the run's actor.
 *   2. Ask {@link refreshConnectionCredential} and translate its outcome: a dead
 *      credential (flagged needsReconnection) bubbles a structured 410, a
 *      retryable failure a 502.
 *   3. Resolve the live HTTP delivery plan via `resolveHttpDelivery`.
 *   4. Build a `ResolvedAuthCredentials` entry + the matching plan.
 *
 * Output is shaped to feed straight into the sidecar's
 * `MitmCredentialSource.current()` and `.deliveryPlans()`.
 */

import {
  resolveAfpsHttpDelivery,
  decryptCredentialsToStringMap,
  type AfpsHttpDelivery as ConnectAfpsHttpDelivery,
  type HttpDeliveryPlan,
  type ResolvedAuthCredentials,
  type IntegrationCredentialsWire,
} from "@appstrate/connect";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { renderAuthAuthorizedUris, type AfpsManifestAuth } from "./integration-manifest-helpers.ts";

import type { CredentialFailureCause } from "@appstrate/core/sidecar-types";
import { logger } from "../lib/logger.ts";
import { CREDENTIAL_FAILURE_SENTENCES } from "../lib/credential-failure.ts";
import { decryptStoredCredential } from "../lib/stored-credential.ts";
import { notFound, gone, conflict, internalError, badGateway } from "../lib/errors.ts";
import type { Actor } from "../lib/actor.ts";
import { refreshConnectionCredential, type RefreshTrigger } from "./integration-token-refresh.ts";
import {
  assertIntegrationActive,
  loadAccessibleConnectionById,
  markIntegrationConnectionNeedsReconnection,
  readCredentialRevision,
  upstreamRejectionStreak,
} from "./integration-connections.ts";
import {
  readIntegrationManifestForRun,
  type ResolvedIntegrationVersion,
} from "./integration-service.ts";

/** Mutable builder for the wire payload (returned widened to the readonly wire type). */
interface MutableCredentialsWire {
  auths: ResolvedAuthCredentials[];
  deliveryPlans: Record<string, HttpDeliveryPlan>;
  expiresAtEpochMs: Record<string, number | null>;
  rejectionStreak?: number;
  credentialRevision?: string;
}

/**
 * NEVER returns an empty payload — the sidecar would read it as "skip the MITM
 * listener" and boot uncredentialed — so every unproducible credential throws.
 *
 * Throws ApiError on:
 *   - 404: integration not declared by the agent, not active, or the named connection
 *     is gone. Nothing exists to flag, so this is deliberately NOT the 410 below.
 *   - 409 `integration_auth_undeclared`: the connection's `auth_key` is not
 *     declared by the manifest VERSION this run is pinned to (auth renamed or
 *     removed since the connection was made). The credential is intact and may
 *     be valid under another version, so it is NOT flagged.
 *   - 410 `integration_connection_needs_reconnection`: the credential is dead
 *     and the connection is flagged `needsReconnection`. The sidecar propagates
 *     it as a 401 to the integration so the LLM sees a clean "please re-connect"
 *     surface, and stops retrying.
 *   - 502: not refreshed now, the connection stays usable — the cached
 *     credential may still be valid; the sidecar treats it as retry-later and
 *     the listener's `refreshOnUnauthorized` cooldown keeps a flapping upstream
 *     from hammering this endpoint.
 *   Both carry the `CredentialFailureCause` as the `cause` extension member.
 *   - 503 `encryption_key_unavailable`: a stored credential or client secret
 *     it needs is under a key id the keyring lacks — operator config, NOT flagged.
 */
export async function resolveLiveIntegrationCredentials(
  integrationId: string,
  context: {
    runId: string;
    orgId: string;
    spaceId: string;
    agentPackageId: string;
    actor: Actor | null;
    /** A member of the run's bound set (the route checked it), and its cascade layer. */
    connectionId: string;
    connectionSource: string;
    /**
     * Snapshot from `runs.resolved_integration_versions`. When present,
     * `[integrationId]` pins the manifest VERSION this resolver reads — so the
     * delivery/auth plan a mid-run MITM refresh injects matches the version the
     * spawn resolver used at kickoff. Absent (legacy / soft-resolved) → draft.
     */
    resolvedIntegrationVersions?: Record<string, ResolvedIntegrationVersion> | null;
  },
  trigger: RefreshTrigger = { kind: "expiring" },
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
  await assertIntegrationActive(integrationId, context.spaceId);

  const auths = (manifest.auths ?? {}) as Record<string, AfpsManifestAuth>;

  const out: MutableCredentialsWire = {
    auths: [],
    deliveryPlans: {},
    expiresAtEpochMs: {},
  };

  const reach = { spaceId: context.spaceId, actor: context.actor };
  const connection = await loadAccessibleConnectionById(
    context.connectionId,
    integrationId,
    null,
    reach,
  );
  if (!connection) {
    // STATE A — 404 and not 410: no row is left to flag `needsReconnection` on.
    logger.warn("Integration credentials unavailable — no accessible connection", {
      runId: context.runId,
      integrationId,
      connectionId: context.connectionId,
      declaredAuthKeys: Object.keys(auths),
      pinnedSource: context.connectionSource,
    });
    throw notFound(
      `Integration '${integrationId}': the connection bound to this run ` +
        `(${context.connectionId}, source '${context.connectionSource}') ` +
        `is no longer reachable — it was deleted, unshared, or moved to another space after ` +
        `the run started. Re-connect '${integrationId}' and relaunch the run.`,
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
    // active", and stacking a third unrelated cause behind it is exactly the
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

  // Terminally unusable, and already flagged by whoever concluded it: surface 410 so the sidecar
  // stops retrying and the next-launch readiness gate fires.
  const throwTerminal = (cause: CredentialFailureCause, detail?: string): never => {
    logger.warn("Integration credential terminally unusable — flagged needsReconnection", {
      runId: context.runId,
      integrationId,
      authKey,
      connectionId: connection.id,
      trigger: trigger.kind,
      cause,
      detail,
    });
    throw gone(
      "integration_connection_needs_reconnection",
      `Integration '${integrationId}' auth '${authKey}' is unusable ` +
        `(${CREDENTIAL_FAILURE_SENTENCES[cause]}) — the connection has been flagged as needing ` +
        `re-connection. Re-connect '${integrationId}' and relaunch the run.`,
      { cause },
    );
  };

  const { variables } = connection;
  let fields = decryptStoredCredential(
    () => decryptCredentialsToStringMap(connection.credentialsEncrypted),
    { connectionId: connection.id, packageId: integrationId, authKey },
  );
  if (!fields) {
    // STATE C — unreadable ciphertext (a missing key has thrown the 503 instead):
    // a credential nobody can read is dead — flag + 410, even on a plain read.
    // `return` rather than a bare `await`: the helper's `Promise<never>` does
    // not narrow `fields` on its own, and everything below reads it non-null.
    await markIntegrationConnectionNeedsReconnection(connection.id);
    return throwTerminal("credentials_undecryptable");
  }

  let expiresAtEpochMs = connection.expiresAt ? connection.expiresAt.getTime() : null;
  let credentialRevision: string | null = connection.credentialRevision;

  const outcome = await refreshConnectionCredential({
    connection,
    integrationId,
    manifest,
    authDef,
    scope: { orgId: context.orgId, spaceId: context.spaceId },
    actor: context.actor,
    trigger,
  });
  switch (outcome.status) {
    case "dead":
      return throwTerminal(outcome.cause, outcome.detail);
    case "retry": {
      // The cached credential may still be usable: 502 lets the sidecar's
      // `refreshOnUnauthorized` cooldown back off without poisoning the row.
      const { cause, detail, rejections } = outcome;
      logger.warn("Integration credential not refreshed — retry later", {
        runId: context.runId,
        integrationId,
        authKey,
        connectionId: connection.id,
        cause,
        detail,
      });
      const streak = rejections
        ? ` (${rejections.failures}/${rejections.maxFailures} consecutive upstream rejections before it is flagged)`
        : "";
      throw badGateway(
        `Integration '${integrationId}' auth '${authKey}' was not refreshed: ` +
          `${CREDENTIAL_FAILURE_SENTENCES[cause]}${streak}`,
        { cause },
      );
    }
    case "kept":
      logger.debug("Integration credential not refreshed — serving the stored one", {
        runId: context.runId,
        integrationId,
        authKey,
        connectionId: connection.id,
        cause: outcome.cause,
        detail: outcome.detail,
      });
      break;
    case "refreshed":
      fields = outcome.fields;
      credentialRevision = await readCredentialRevision(connection.id);
      expiresAtEpochMs = outcome.expiresAt ? outcome.expiresAt.getTime() : null;
      break;
  }

  const http = authDef.delivery?.http;
  if (http) {
    const plan = resolveAfpsHttpDelivery(
      authDef.type,
      fields,
      http as ConnectAfpsHttpDelivery,
      variables,
    );
    if (plan) {
      out.deliveryPlans[authKey] = plan;
    }
  }

  out.auths.push({
    authKey,
    authType: authDef.type,
    fields: Object.freeze({ ...fields }),
    // Rendered from the post-refresh fields.
    authorizedUris: Object.freeze(renderAuthAuthorizedUris(authDef, fields, variables)),
    // AFPS §7.3 (RFC 8707) names this field `resource`.
    ...(authDef.resource !== undefined ? { resource: authDef.resource } : {}),
    ...(connection.expiresAt ? { expiresAt: connection.expiresAt.toISOString() } : {}),
    ...(connection.scopesGranted.length > 0
      ? { scopesGranted: Object.freeze([...connection.scopesGranted]) }
      : {}),
  });
  out.expiresAtEpochMs[authKey] = expiresAtEpochMs;
  const streak = upstreamRejectionStreak(connection);
  if (streak > 0) out.rejectionStreak = streak;
  if (credentialRevision !== null) out.credentialRevision = credentialRevision;

  return out;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

async function loadIntegrationManifest(
  integrationId: string,
  frozenVersion: ResolvedIntegrationVersion | null,
): Promise<IntegrationManifest> {
  // Read AT the version frozen for this run so the delivery/auth plan
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
 * Printable label for the integration manifest version this run reads:
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
 *   rejectionStreak       → rejection_streak
 *   credentialRevision    → credential_revision
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
    ...(wire.rejectionStreak !== undefined ? { rejection_streak: wire.rejectionStreak } : {}),
    ...(wire.credentialRevision !== undefined
      ? { credential_revision: wire.credentialRevision }
      : {}),
  };
}
