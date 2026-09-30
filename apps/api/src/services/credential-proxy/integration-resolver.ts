// SPDX-License-Identifier: Apache-2.0

/**
 * Credential-proxy integration resolver — backs the public
 * `/api/credential-proxy/proxy` endpoint on `integration_connections`.
 *
 * Resolves credentials from the same integration credential
 * machinery that backs the sidecar's `/internal/integration-credentials/*`
 * surface — `integration_connections` rows + the manifest's `delivery.http`
 * plan — and synthesises a {@link ProxyCredentialsPayload} that
 * {@link proxyCall} consumes verbatim (header injection +
 * `{{var}}` substitution + `authorized_uris` allowlist).
 *
 * `X-Integration-Id` carries the integration package id (`@scope/name`); which
 * connection is decrypted is `selectAccessibleConnection`'s call.
 *
 * Both this external-runner path and the in-container sidecar path
 * (`api-call-credentials.ts`) build the payload via the shared
 * `buildProxyCredentialsPayload` helper in `@appstrate/connect`, so the
 * payload shape and injection contract cannot drift between them.
 */

import {
  resolveAfpsHttpDelivery,
  buildProxyCredentialsPayload,
  RefreshError,
  type AfpsHttpDelivery as ConnectAfpsHttpDelivery,
  type ProxyCredentialsPayload,
} from "@appstrate/connect";
import {
  renderAuthAuthorizedUris,
  type AfpsManifestAuth,
} from "../integration-manifest-helpers.ts";
import type { Actor } from "../../lib/actor.ts";
import { logger } from "../../lib/logger.ts";
import { requireAttributableRun } from "../state/runs.ts";
import {
  assertIntegrationActive,
  selectAccessibleConnection,
  recordUnrefreshableRejection,
  upstreamRejectionStreak,
  type ResolvedConnectionRow,
  type RunBoundSelection,
} from "../integration-connections.ts";
import {
  readIntegrationManifestForProxy,
  type ResolvedIntegrationVersion,
} from "../integration-service.ts";
import {
  buildIntegrationOAuthRefreshContext,
  decryptIntegrationConnectionFields,
  refreshAndClassify,
} from "../integration-token-refresh.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";

/** An `X-Run-Id` run, which also names the integration version the call is authorized against. */
export interface ProxyRunSelection extends RunBoundSelection {
  /** The version the run froze at kickoff for this integration; `null` when it froze none. */
  frozenVersion: () => Promise<ResolvedIntegrationVersion | null>;
}

/**
 * The `X-Run-Id` run, bound to the ACTOR: a caller borrows only the snapshot of its own run.
 * Each read checks the run anew, so a run that finished since the call started stops lending.
 */
export function runBoundSelection(input: {
  orgId: string;
  spaceId: string;
  runId: string;
  integrationId: string;
  actor: Actor;
}): ProxyRunSelection {
  const { orgId, spaceId, runId, integrationId, actor } = input;
  const attributableRun = () => requireAttributableRun({ orgId, runId, spaceId, owner: actor });
  return {
    id: runId,
    boundSet: async () => (await attributableRun()).resolvedConnections?.[integrationId] ?? [],
    frozenVersion: async () =>
      (await attributableRun()).resolvedIntegrationVersions?.[integrationId] ?? null,
  };
}

/** Errors mapped by the route to 404 (credential not found). */
export class IntegrationCredentialNotFoundError extends Error {
  readonly code = "CREDENTIAL_NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "IntegrationCredentialNotFoundError";
  }
}

interface ResolveIntegrationProxyInput {
  /** Integration package id from `X-Integration-Id` (`@scope/name`). */
  integrationId: string;
  orgId: string;
  spaceId: string;
  actor: Actor;
  /** Optional connection id pin (from `X-Connection-Id`). */
  connectionId?: string;
  /** The run named by `X-Run-Id` — confines the call to the connections and version it froze. */
  run?: ProxyRunSelection;
}

interface ResolvedIntegrationProxyCredentials {
  /** `payload.authorizedUris` is rendered for the connection: it decides what matches. */
  payload: ProxyCredentialsPayload;
  /** The auth's declared (unrendered) `authorized_uris`: only its literal hosts share cookies. */
  declaredUris: readonly string[];
  /** The decrypted connection id — used by the route's 401 force-refresh path. */
  connectionId: string;
  authKey: string;
  /** Consecutive upstream rejections counted before this call (`upstreamRejectionStreak`). */
  rejectionStreak: number;
}

/**
 * Live credentials for the credential-proxy. Throws {@link IntegrationCredentialNotFoundError}
 * when there is no usable connection, and the selection's `ApiError` when it has no single answer.
 */
export async function resolveIntegrationProxyCredentials(
  input: ResolveIntegrationProxyInput,
): Promise<ResolvedIntegrationProxyCredentials> {
  const manifest = await loadManifest(input);
  await assertIntegrationActive(input.integrationId, input.spaceId);

  if (Object.keys(manifest.auths ?? {}).length === 0) {
    throw new IntegrationCredentialNotFoundError(
      `Integration '${input.integrationId}' declares no auth methods`,
    );
  }

  const connection = await resolveConnection(input, manifest);
  if (!connection) {
    throw new IntegrationCredentialNotFoundError(
      `No credentials configured for integration '${input.integrationId}' in space ${input.spaceId}`,
    );
  }

  const payload = buildPayload(input.integrationId, manifest, connection);
  return {
    payload,
    declaredUris: declaredUrisOf(manifest, connection.authKey),
    connectionId: connection.id,
    authKey: connection.authKey,
    rejectionStreak: upstreamRejectionStreak(connection),
  };
}

/**
 * Force-refresh the integration connection's OAuth2 token (the proxy's
 * reactive 401-retry path) and rebuild the payload. `input.connectionId` names
 * the connection the failed call used; the selection still re-checks reach. Never throws for a
 * credential outcome — both call sites in `core.ts` sit inside `catch {}`, so
 * a throw would be swallowed and buy nothing. Returns `null` in the four
 * not-refreshed cases, which are NOT equivalent and are told apart by what
 * they leave behind:
 *
 *   - transient (discovery blip, upstream 5xx) — row untouched, retry later;
 *   - no accessible connection — nothing to conclude;
 *   - UNREFRESHABLE (a non-oauth2 auth, or oauth2 whose minting client is gone
 *     or whose manifest can never yield a token endpoint) — the rejection is
 *     counted by `recordUnrefreshableRejection`, as on the sidecar path, and
 *     flags the connection at the threshold;
 *   - TERMINAL (the stored bundle has no `refresh_token`) — the connection is
 *     flagged `needsReconnection` before returning;
 *   - REVOKED (the refresh token was rejected upstream) — `refreshAndClassify`
 *     has already flagged `needsReconnection`, so the caller relaying the
 *     upstream 401 is not what stands between the user and a reconnect prompt.
 */
export async function forceRefreshIntegrationProxyCredentials(
  input: ResolveIntegrationProxyInput,
): Promise<ResolvedIntegrationProxyCredentials | null> {
  const manifest = await loadManifest(input);
  const connection = await resolveConnection(input, manifest);
  if (!connection) return null;

  const authDef = manifest.auths?.[connection.authKey];
  if (!authDef) return null;
  if (authDef.type !== "oauth2") {
    return countUnrefreshableRejection(input, connection, `auth type '${authDef.type}'`);
  }

  let refreshContext;
  try {
    refreshContext = await buildIntegrationOAuthRefreshContext(
      input.integrationId,
      connection.authKey,
      authDef,
      input.spaceId,
      connection.clientRef,
    );
  } catch (err) {
    // Transient token-endpoint discovery failure (issuer-only manifest) —
    // surface as not-refreshed; the route keeps the original 401, the row is
    // untouched, the next run re-discovers. Same handling as a transient
    // exchange failure below.
    if (err instanceof RefreshError && err.kind === "transient") {
      logger.warn("credential-proxy: integration token endpoint discovery transient failure", {
        integrationId: input.integrationId,
        authKey: connection.authKey,
        error: err.message,
      });
      return null;
    }
    throw err;
  }
  if (!refreshContext) {
    return countUnrefreshableRejection(input, connection, "no OAuth client or token endpoint");
  }

  // Re-acquisition = fast-path refresh_token POST. `authDef.type` is gated
  // to oauth2 above, so this is the only refreshable auth. `force` is left at
  // its default (true): this whole function IS the proxy's 401-retry hook, so
  // the stored token is known-bad and its remaining lifetime proves nothing.
  const classified = await refreshAndClassify(
    connection.id,
    input.integrationId,
    connection.authKey,
    connection.credentialsEncrypted,
    refreshContext,
  );
  if (classified.status === "terminal") {
    // Terminal, and already recorded: the connection carries no refresh_token
    // at all, and `refreshAndClassify` flagged `needsReconnection` before
    // returning. Degrade-and-mark: the caller keeps seeing the real upstream 401.
    logger.warn("credential-proxy: integration credential unrefreshable — needs re-connection", {
      integrationId: input.integrationId,
      authKey: connection.authKey,
      connectionId: connection.id,
      reason: classified.reason,
    });
    return null;
  }
  if (classified.status === "revoked") {
    // Terminal, and already recorded: `refreshAndClassify` flipped
    // `needsReconnection` on the connection before returning this status.
    logger.warn("credential-proxy: integration refresh token revoked — needs re-connection", {
      integrationId: input.integrationId,
      authKey: connection.authKey,
      connectionId: connection.id,
    });
    return null;
  }
  if (classified.status === "transient") {
    // Transient failure — surface as not-refreshed; the route keeps the
    // original 401.
    const err = classified.error;
    logger.warn("credential-proxy: integration token refresh transient error", {
      integrationId: input.integrationId,
      authKey: connection.authKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const fields = classified.result.fields;
  const payload = buildPayloadFromFields(manifest, connection.authKey, fields);
  if (!payload) return null;
  return {
    payload,
    declaredUris: declaredUrisOf(manifest, connection.authKey),
    connectionId: connection.id,
    authKey: connection.authKey,
    rejectionStreak: upstreamRejectionStreak(connection),
  };
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * A 401 nothing can refresh: counted like the sidecar's (one 401 can be a transient upstream
 * fault), so CLI / GitHub Action / runner callers still reach a reconnect prompt. Returns `null`:
 * the proxy relays the upstream 401 unchanged.
 */
async function countUnrefreshableRejection(
  input: ResolveIntegrationProxyInput,
  connection: ResolvedConnectionRow,
  reason: string,
): Promise<null> {
  const { failures, maxFailures, needsReconnection } = await recordUnrefreshableRejection(
    connection.id,
  );
  logger.warn("credential-proxy: integration credential rejected upstream and unrefreshable", {
    integrationId: input.integrationId,
    authKey: connection.authKey,
    connectionId: connection.id,
    reason,
    failures,
    maxFailures,
    needsReconnection,
  });
  return null;
}

async function loadManifest(input: ResolveIntegrationProxyInput): Promise<IntegrationManifest> {
  const { integrationId } = input;
  const frozen = input.run ? await input.run.frozenVersion() : null;
  const res = await readIntegrationManifestForProxy(integrationId, input.orgId, frozen);
  if (res.ok) return res.manifest;
  switch (res.failure.kind) {
    case "not_found":
      throw new IntegrationCredentialNotFoundError(`Integration '${integrationId}' not found`);
    case "not_published":
      throw new IntegrationCredentialNotFoundError(
        `Integration '${integrationId}' has no published version; publish it before calling it through the credential proxy`,
      );
    case "not_integration":
      throw new IntegrationCredentialNotFoundError(
        `Package '${integrationId}' is not an integration`,
      );
    case "invalid_manifest":
      // Both halves carry the issues: the log for the operator, the thrown
      // message because it travels to the agent as a `credential_not_found`
      // (`credential-proxy/core.ts`) — the only channel a run has for finding
      // out why its integration went away. Schema issues name manifest fields,
      // never credentials, so nothing secret rides along.
      logger.warn("credential-proxy: integration manifest fails validation", {
        integrationId,
        issues: res.failure.issues,
      });
      throw new IntegrationCredentialNotFoundError(
        `Integration '${integrationId}' has an invalid manifest: ${res.failure.issues}`,
      );
  }
}

function resolveConnection(
  input: ResolveIntegrationProxyInput,
  manifest: IntegrationManifest,
): Promise<ResolvedConnectionRow | null> {
  return selectAccessibleConnection(input.integrationId, manifest, input.connectionId ?? null, {
    spaceId: input.spaceId,
    actor: input.actor,
    ...(input.run ? { run: input.run } : {}),
  });
}

function buildPayload(
  integrationId: string,
  manifest: IntegrationManifest,
  connection: ResolvedConnectionRow,
): ProxyCredentialsPayload {
  const fields = decryptIntegrationConnectionFields(
    connection.credentialsEncrypted,
    integrationId,
    connection.authKey,
  );
  if (!fields) {
    throw new IntegrationCredentialNotFoundError(
      `Failed to decrypt credentials for integration '${integrationId}'`,
    );
  }
  const payload = buildPayloadFromFields(manifest, connection.authKey, fields);
  if (!payload) {
    throw new IntegrationCredentialNotFoundError(
      `Integration '${integrationId}' auth '${connection.authKey}' has no resolvable credentials`,
    );
  }
  return payload;
}

function declaredUrisOf(manifest: IntegrationManifest, authKey: string): readonly string[] {
  return (manifest.auths?.[authKey] as AfpsManifestAuth | undefined)?.authorized_uris ?? [];
}

/**
 * Map an integration auth's decrypted fields + `delivery.http` plan into a
 * {@link ProxyCredentialsPayload}. Mirrors the sidecar's
 * `api-call-credentials.ts:toPayload`.
 */
function buildPayloadFromFields(
  manifest: IntegrationManifest,
  authKey: string,
  fields: Record<string, string>,
): ProxyCredentialsPayload | null {
  const authDef = manifest.auths?.[authKey] as AfpsManifestAuth | undefined;
  if (!authDef) return null;

  const http = authDef.delivery?.http;
  const plan = http
    ? resolveAfpsHttpDelivery(authDef.type, fields, http as ConnectAfpsHttpDelivery)
    : null;

  // Integrations always declare ≥1 authorized_uri unless allow_all_uris is set.
  return buildProxyCredentialsPayload({
    fields,
    plan,
    authorizedUris: renderAuthAuthorizedUris(authDef, fields),
    allowAllUris: authDef.allow_all_uris === true,
  });
}
