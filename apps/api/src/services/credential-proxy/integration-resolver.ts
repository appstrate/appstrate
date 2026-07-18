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
 * `X-Integration-Id` carries the integration package id (`@scope/name`). The
 * actor (dashboard user, CLI/JWT user, or impersonated end-user) selects
 * which `integration_connections` row is decrypted; an optional
 * connection id (from `X-Connection-Id`) pins a specific row.
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
import type { AfpsManifestAuth } from "../integration-manifest-helpers.ts";
import type { Actor } from "../../lib/actor.ts";
import { logger } from "../../lib/logger.ts";
import {
  assertIntegrationActive,
  selectAccessibleConnection,
  type ResolvedConnectionRow,
} from "../integration-connections.ts";
import { fetchIntegrationManifest } from "../integration-service.ts";
import {
  buildIntegrationOAuthRefreshContext,
  decryptIntegrationConnectionFields,
  refreshAndClassify,
} from "../integration-token-refresh.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";

/** Errors mapped by the route to 404 (credential not found). */
export class IntegrationCredentialNotFoundError extends Error {
  readonly code = "CREDENTIAL_NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "IntegrationCredentialNotFoundError";
  }
}

/** Errors mapped by the route to 403 (connection revoked, re-connect needed). */
export class IntegrationCredentialRevokedError extends Error {
  readonly code = "CREDENTIAL_REVOKED";
  constructor(message: string) {
    super(message);
    this.name = "IntegrationCredentialRevokedError";
  }
}

export interface ResolveIntegrationProxyInput {
  /** Integration package id from `X-Integration-Id` (`@scope/name`). */
  integrationId: string;
  applicationId: string;
  actor: Actor;
  /** Optional connection id pin (from `X-Connection-Id`). */
  connectionId?: string;
}

export interface ResolvedIntegrationProxyCredentials {
  payload: ProxyCredentialsPayload;
  /** The decrypted connection id — used by the route's 401 force-refresh path. */
  connectionId: string;
  authKey: string;
}

/**
 * Resolve live credentials for the credential-proxy from an
 * integration connection. Throws {@link IntegrationCredentialNotFoundError}
 * when the integration is not installed / has no accessible connection,
 * or {@link IntegrationCredentialRevokedError} on a revoked refresh token.
 */
export async function resolveIntegrationProxyCredentials(
  input: ResolveIntegrationProxyInput,
): Promise<ResolvedIntegrationProxyCredentials> {
  const manifest = await loadManifest(input.integrationId);
  await assertIntegrationActive(input.integrationId, input.applicationId);

  const auths = manifest.auths ?? {};
  const declaredAuthKeys = Object.keys(auths);
  if (declaredAuthKeys.length === 0) {
    throw new IntegrationCredentialNotFoundError(
      `Integration '${input.integrationId}' declares no auth methods`,
    );
  }

  const connection = await resolveConnection(input, declaredAuthKeys);
  if (!connection) {
    throw new IntegrationCredentialNotFoundError(
      `No credentials configured for integration '${input.integrationId}' in application ${input.applicationId}`,
    );
  }

  const payload = buildPayload(input.integrationId, manifest, connection);
  return { payload, connectionId: connection.id, authKey: connection.authKey };
}

/**
 * Force-refresh the integration connection's OAuth2 token (the proxy's
 * reactive 401-retry path) and rebuild the payload. Returns `null` when
 * the auth is not refreshable (no token URL / no per-app OAuth client /
 * public client). Throws {@link IntegrationCredentialRevokedError} when
 * the refresh token was revoked upstream.
 */
export async function forceRefreshIntegrationProxyCredentials(
  input: ResolveIntegrationProxyInput,
): Promise<ResolvedIntegrationProxyCredentials | null> {
  const manifest = await loadManifest(input.integrationId);
  const auths = manifest.auths ?? {};
  const declaredAuthKeys = Object.keys(auths);

  const connection = await resolveConnection(input, declaredAuthKeys);
  if (!connection) return null;

  const authDef = auths[connection.authKey];
  if (!authDef || authDef.type !== "oauth2") return null;

  let refreshContext;
  try {
    refreshContext = await buildIntegrationOAuthRefreshContext(
      input.integrationId,
      connection.authKey,
      authDef,
      input.applicationId,
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
  if (!refreshContext) return null;

  // Re-acquisition = fast-path refresh_token POST. `authDef.type` is gated
  // to oauth2 above, so this is the only refreshable auth.
  const classified = await refreshAndClassify(
    connection.id,
    input.integrationId,
    connection.authKey,
    connection.credentialsEncrypted,
    refreshContext,
  );
  if (classified.status === "revoked") {
    throw new IntegrationCredentialRevokedError(
      `Integration '${input.integrationId}' auth '${connection.authKey}' needs re-connection (refresh token revoked)`,
    );
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
  return { payload, connectionId: connection.id, authKey: connection.authKey };
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

async function loadManifest(integrationId: string): Promise<IntegrationManifest> {
  const res = await fetchIntegrationManifest(integrationId);
  if (res.ok) return res.manifest;
  switch (res.failure.kind) {
    case "not_found":
      throw new IntegrationCredentialNotFoundError(`Integration '${integrationId}' not found`);
    case "not_integration":
      throw new IntegrationCredentialNotFoundError(
        `Package '${integrationId}' is not an integration`,
      );
    case "invalid_manifest":
      logger.warn("credential-proxy: integration manifest fails validation", { integrationId });
      throw new IntegrationCredentialNotFoundError(
        `Integration '${integrationId}' has an invalid manifest`,
      );
  }
}

async function resolveConnection(
  input: ResolveIntegrationProxyInput,
  declaredAuthKeys: string[],
): Promise<ResolvedConnectionRow | null> {
  // Single source of truth for connection selection (snapshot-pin-by-id vs
  // auto-pick over declared auths) — shared with the spawn + credentials
  // resolvers so the proxy can't drift on which connection it picks.
  // The by-id branch (caller-supplied `X-Connection-Id`) is bound to
  // `input.integrationId` inside the selector: a connection id belonging
  // to another integration resolves to null (→ 404) instead of leaking
  // that integration's credentials into this integration's payload.
  return selectAccessibleConnection(
    input.integrationId,
    declaredAuthKeys,
    input.connectionId ?? null,
    { applicationId: input.applicationId, actor: input.actor },
  );
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
    authorizedUris: authDef.authorized_uris ?? [],
    allowAllUris: authDef.allow_all_uris === true,
  });
}
