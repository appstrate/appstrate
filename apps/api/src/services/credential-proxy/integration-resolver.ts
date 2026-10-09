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
  decryptCredentialsToStringMap,
  type AfpsHttpDelivery as ConnectAfpsHttpDelivery,
  type ProxyCredentialsPayload,
} from "@appstrate/connect";
import {
  renderAuthAuthorizedUris,
  type AfpsManifestAuth,
} from "../integration-manifest-helpers.ts";
import type { Actor } from "../../lib/actor.ts";
import { logger } from "../../lib/logger.ts";
import { decryptStoredCredential } from "../../lib/stored-credential.ts";
import { requireAttributableRun } from "../state/runs.ts";
import {
  assertIntegrationActive,
  selectAccessibleConnection,
  upstreamRejectionStreak,
  type ResolvedConnectionRow,
  type RunBoundSelection,
} from "../integration-connections.ts";
import type { ConnectionVariables } from "../connect/connection-variables.ts";
import {
  readIntegrationManifestForProxy,
  type ResolvedIntegrationVersion,
} from "../integration-service.ts";
import { refreshConnectionCredential } from "../integration-token-refresh.ts";
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
  /** The `credential_revision` of the decrypted credential, which a 401 rejects. */
  credentialRevision: string;
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
    credentialRevision: connection.credentialRevision,
    authKey: connection.authKey,
    rejectionStreak: upstreamRejectionStreak(connection),
  };
}

/**
 * The proxy's reactive 401 path: the payload to replay the call with, after
 * {@link refreshConnectionCredential} judged the rejection of the credential of `rejectedRevision`.
 * `input.connectionId` names the connection the failed call used; the selection still re-checks
 * reach. `refreshed` replays with the new credential, `kept` (the rejected credential was
 * superseded) with the one the connection holds now.
 *
 * Throws the 503 of a key missing from the keyring, which `core.ts` answers instead of the
 * upstream 401, and any error that is not a verdict on the connection. Returns `null` — the proxy
 * relays the upstream 401 unchanged — when there is no accessible connection or declared auth,
 * and on `retry` (row untouched, or a rejection counted below the threshold) and `dead` (the
 * connection is flagged `needsReconnection`, so the relayed 401 is not what stands between the
 * user and a reconnect prompt).
 */
export async function forceRefreshIntegrationProxyCredentials(
  input: ResolveIntegrationProxyInput,
  rejectedRevision: string | null,
): Promise<ProxyCredentialsPayload | null> {
  const manifest = await loadManifest(input);
  const connection = await resolveConnection(input, manifest);
  if (!connection) return null;

  const authDef = manifest.auths?.[connection.authKey];
  if (!authDef) return null;
  const outcome = await refreshConnectionCredential({
    connection,
    integrationId: input.integrationId,
    manifest,
    authDef,
    scope: { orgId: input.orgId, spaceId: input.spaceId },
    actor: input.actor,
    trigger: { kind: "rejected", revision: rejectedRevision },
  });
  let fields: Record<string, string> | null;
  switch (outcome.status) {
    case "refreshed":
      fields = outcome.fields;
      break;
    case "kept":
      fields = decryptStoredCredential(
        () => decryptCredentialsToStringMap(connection.credentialsEncrypted),
        {
          connectionId: connection.id,
          packageId: input.integrationId,
          authKey: connection.authKey,
        },
      );
      break;
    case "retry":
    case "dead":
      logger.warn("credential-proxy: integration credential not refreshed — relaying the 401", {
        integrationId: input.integrationId,
        authKey: connection.authKey,
        connectionId: connection.id,
        outcome: outcome.status,
        cause: outcome.cause,
        detail: outcome.detail,
      });
      return null;
  }
  if (!fields) return null;
  return buildPayloadFromFields(manifest, connection.authKey, fields, connection.variables);
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

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
  const fields = decryptStoredCredential(
    () => decryptCredentialsToStringMap(connection.credentialsEncrypted),
    { connectionId: connection.id, packageId: integrationId, authKey: connection.authKey },
  );
  if (!fields) {
    throw new IntegrationCredentialNotFoundError(
      `Failed to decrypt credentials for integration '${integrationId}'`,
    );
  }
  const payload = buildPayloadFromFields(
    manifest,
    connection.authKey,
    fields,
    connection.variables,
  );
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
  variables: ConnectionVariables,
): ProxyCredentialsPayload | null {
  const authDef = manifest.auths?.[authKey] as AfpsManifestAuth | undefined;
  if (!authDef) return null;

  const http = authDef.delivery?.http;
  const plan = http
    ? resolveAfpsHttpDelivery(authDef.type, fields, http as ConnectAfpsHttpDelivery, variables)
    : null;

  // Integrations always declare ≥1 authorized_uri unless allow_all_uris is set.
  return buildProxyCredentialsPayload({
    fields,
    plan,
    authorizedUris: renderAuthAuthorizedUris(authDef, fields, variables),
    allowAllUris: authDef.allow_all_uris === true,
  });
}
