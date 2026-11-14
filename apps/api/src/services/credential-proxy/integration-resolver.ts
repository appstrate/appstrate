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
 * connection is decrypted is `selectAccessibleConnection`'s call: a member of the
 * `X-Run-Id` run's bound set, else one {@link listConnectionsOutsideRun} lists.
 *
 * Both this path and the in-container sidecar path
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
import { credentialTemplateRefs } from "@appstrate/afps-shared/credential-template";
import {
  renderAuthAuthorizedUris,
  type AfpsManifestAuth,
} from "../integration-manifest-helpers.ts";
import { actorOwns, type Actor } from "../../lib/actor.ts";
import { connectionVariablesOf } from "../../lib/connection-identity.ts";
import { logger } from "../../lib/logger.ts";
import { decryptStoredCredential } from "../../lib/stored-credential.ts";
import type { ResolutionFieldError } from "../../lib/errors.ts";
import type { ConnectOfferPolicy } from "../../lib/connect-offer-policy.ts";
import type { SpaceScope } from "../../lib/scope.ts";
import { attachConnectOffers } from "../connect/preflight-connect-offer.ts";
import { requireCallerRun } from "./access.ts";
import {
  assertIntegrationActive,
  connectionParam,
  listIntegrationIdsActiveInSpace,
  listReachableConnections,
  proxyConnectionVerdicts,
  selectAccessibleConnection,
  upstreamRejectionStreak,
  type ConnectionNaming,
  type ProxyConnectionStatus,
  type ProxyReach,
  type ResolvedConnectionRow,
  type RunBoundSelection,
} from "../integration-connections.ts";
import { listOrgDefaultsForResolver } from "../integration-org-defaults-service.ts";
import type { ConnectionVariables } from "../connect/connection-variables.ts";
import {
  readIntegrationManifestForProxy,
  type ResolvedIntegrationVersion,
} from "../integration-service.ts";
import { refreshConnectionCredential } from "../integration-token-refresh.ts";
import {
  isUnauthenticatedIntegration,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import type { CredentialStatus } from "../../lib/credential-status-header.ts";

/**
 * What the proxy's forced refresh leaves it with: a credential to replay the call with, the
 * {@link CredentialStatus} of a rejected credential it could not recover (the relayed 401's
 * `X-Appstrate-Credential-Status`), or `null` when nothing accessible serves.
 */
export type ForcedRefreshResult =
  | { kind: "replay"; payload: ProxyCredentialsPayload }
  | { kind: "verdict"; credential: CredentialStatus }
  | null;

/** An `X-Run-Id` run, which also names the integration version the call is authorized against. */
export interface ProxyRunSelection extends RunBoundSelection {
  /** The version the run froze at kickoff for this integration; `null` when it froze none. */
  frozenVersion: () => Promise<ResolvedIntegrationVersion | null>;
}

/**
 * The `X-Run-Id` run, bound to the ACTOR: a caller borrows only the snapshot of a run of its own
 * that it executes itself ({@link requireCallerRun}). Each read checks the run anew, so a run that
 * finished since the call started stops lending.
 */
export function runBoundSelection(input: {
  orgId: string;
  spaceId: string;
  runId: string;
  integrationId: string;
  actor: Actor;
}): ProxyRunSelection {
  const { orgId, spaceId, runId, integrationId, actor } = input;
  const callerRun = () => requireCallerRun({ orgId, runId, spaceId, actor });
  return {
    id: runId,
    boundSet: async () => (await callerRun()).resolvedConnections?.[integrationId] ?? [],
    frozenVersion: async () =>
      (await callerRun()).resolvedIntegrationVersions?.[integrationId] ?? null,
  };
}

/**
 * Which way a proxy call is authorized: for a run, against the version it froze; outside one,
 * against the latest published version, or the one `version` names.
 *
 * `version` is internal-only: no HTTP door sets it. The `/api/credential-proxy/proxy` route (and
 * the MCP `call_integration_tool`, which re-enters it) builds its input field by field and never names it;
 * the one caller is the server sync of a draft (`integration-server-sync.ts`), whose route
 * requires write authority on the package's home, the authority a run launched with the
 * integration's draft (`dependency_overrides`, `403 draft_not_writable`) requires.
 */
export type ProxyCallPath =
  | { run: ProxyRunSelection; reach?: never; version?: never }
  | { reach: ProxyReach; run?: never; version?: ResolvedIntegrationVersion };

/** Errors mapped by the route to 404 (credential not found). */
export class IntegrationCredentialNotFoundError extends Error {
  readonly code = "CREDENTIAL_NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "IntegrationCredentialNotFoundError";
  }
}

type ResolveIntegrationProxyInput = {
  /** Integration package id from `X-Integration-Id` (`@scope/name`). */
  integrationId: string;
  orgId: string;
  spaceId: string;
  actor: Actor;
  /** Optional connection id pin (from `X-Connection-Id`, or a body's `connection_id`). */
  connectionId?: string;
  /** How the caller names `connectionId`; the header when omitted. */
  connectionNaming?: ConnectionNaming;
} & ProxyCallPath;

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

  if (isUnauthenticatedIntegration(manifest)) {
    throw new IntegrationCredentialNotFoundError(
      `Integration '${input.integrationId}' declares no auth methods`,
    );
  }

  const connection = await resolveConnection(input, manifest);
  if (!connection) throw new IntegrationCredentialNotFoundError(noConnectionMessage(input));

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
 * {@link refreshConnectionCredential} judged the rejection of the credential of `rejectedRevision`
 * (`kept`: superseded, so replay with the one the connection holds now).
 *
 * On `retry` / `dead` the proxy relays the upstream 401 with their public {@link CredentialStatus}
 * (`in_use` / `needs_reconnection`); on `null` (nothing accessible serves), with nothing.
 */
export async function forceRefreshIntegrationProxyCredentials(
  input: ResolveIntegrationProxyInput,
  rejectedRevision: string | null,
): Promise<ForcedRefreshResult> {
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
      return {
        kind: "verdict",
        credential:
          outcome.status === "dead"
            ? { status: "needs_reconnection", cause: outcome.cause }
            : { status: "in_use", cause: outcome.cause, ...outcome.rejections },
      };
  }
  if (!fields) return null;
  const payload = buildPayloadFromFields(
    manifest,
    connection.authKey,
    fields,
    connection.variables,
  );
  return payload ? { kind: "replay", payload } : null;
}

/** One connection a call outside a run may use (`GET /api/credential-proxy/connections`). */
export interface ConnectionOutsideRun {
  integration_package_id: string;
  connection_id: string;
  label: string;
  owned_by_actor: boolean;
  auth_key: string;
  scopes_granted: string[];
  /** {@link listedAuthorizedUris}: never a value of the connection's credential. */
  authorized_uris: string[];
  allow_all_uris: boolean;
  /** A call binding it answers `409 needs_reconnection` until its owner reconnects it. */
  needs_reconnection: boolean;
  call_permission_required: boolean;
}

/** What a call outside a run may use under `reach`. It decrypts nothing: a model reads it. */
export async function listConnectionsOutsideRun(
  scope: SpaceScope,
  actor: Actor,
  reach: ProxyReach,
): Promise<ConnectionOutsideRun[]> {
  const manifests = await publishedManifests(
    scope.orgId,
    await listIntegrationIdsActiveInSpace(scope),
  );
  return connectionsOutsideRun(scope, actor, reach, manifests);
}

/**
 * The published manifest of each of `integrationIds` that has one: the version a call outside a
 * run is authorized against.
 */
export async function publishedManifests(
  orgId: string,
  integrationIds: readonly string[],
): Promise<Map<string, IntegrationManifest>> {
  const loaded = await Promise.all(
    integrationIds.map((id) => readIntegrationManifestForProxy(id, orgId, null)),
  );
  const manifests = new Map<string, IntegrationManifest>();
  integrationIds.forEach((id, i) => {
    const result = loaded[i]!;
    if (result.ok) manifests.set(id, result.manifest);
  });
  return manifests;
}

/**
 * {@link listConnectionsOutsideRun}, over the integrations of `manifests` alone: those active in
 * the space, each with its published manifest, as the caller read them.
 */
export async function connectionsOutsideRun(
  scope: SpaceScope,
  actor: Actor,
  reach: ProxyReach,
  manifests: ReadonlyMap<string, IntegrationManifest>,
): Promise<ConnectionOutsideRun[]> {
  const [rows, orgDefaults] = await Promise.all([
    listReachableConnections({ spaceId: scope.spaceId, actor }, reach),
    listOrgDefaultsForResolver(scope.spaceId),
  ]);
  const listed = rows.flatMap((row): ConnectionOutsideRun[] => {
    const authDef = manifests.get(row.integrationId)?.auths?.[row.authKey] as
      AfpsManifestAuth | undefined;
    if (!authDef) return [];
    const orgDefault = orgDefaults[row.integrationId];
    const enforcedMembers = orgDefault?.enforce ? orgDefault.connectionIds : null;
    if (reach === "usable" && enforcedMembers && !enforcedMembers.includes(row.id)) return [];
    return [
      {
        integration_package_id: row.integrationId,
        connection_id: row.id,
        label: row.label,
        owned_by_actor: actorOwns(actor, row),
        auth_key: row.authKey,
        scopes_granted: row.scopesGranted,
        authorized_uris: listedAuthorizedUris(authDef, connectionVariablesOf(row.variables)),
        allow_all_uris: authDef.allow_all_uris === true,
        needs_reconnection: row.needsReconnection,
        call_permission_required: reach === "own" && enforcedMembers !== null,
      },
    ];
  });
  // Grouped by integration; within one, oldest first.
  return listed.sort((a, b) => a.integration_package_id.localeCompare(b.integration_package_id));
}

/** An integration active in the space, with what a call outside a run naming no connection gets. */
export interface IntegrationOutsideRun {
  integration_package_id: string;
  display_name: string;
  /** What a call naming no connection gets ({@link proxyConnectionVerdict}). */
  proxy_connection: { status: ProxyConnectionStatus; imposed: boolean };
  /** The selection's item behind a refusal, with its `connect_url` when the caller asks for one. */
  refusal?: ResolutionFieldError;
}

/**
 * The integrations of `manifests` (active in the space, each with its published manifest), each
 * with the verdict of a call outside a run naming no connection, judged against that version
 * under `reach`. With `connectOffers`, a refusal item a connect flow clears carries its
 * `connect_url`, minted by the run launch's one minter under its policy (`attachConnectOffers`).
 */
export async function integrationsOutsideRun(
  scope: SpaceScope,
  actor: Actor,
  reach: ProxyReach,
  connectOffers: ConnectOfferPolicy | null,
  manifests: ReadonlyMap<string, IntegrationManifest>,
): Promise<IntegrationOutsideRun[]> {
  const verdicts = await proxyConnectionVerdicts(manifests, {
    spaceId: scope.spaceId,
    actor,
    reach,
  });
  const refusals = verdicts.flatMap((verdict) => (verdict.refusal ? [verdict.refusal] : []));
  const offered = connectOffers
    ? await attachConnectOffers({ errors: refusals, scope, actor, policy: connectOffers })
    : refusals;
  // `offered` holds the refusals in verdict order.
  let next = 0;
  return verdicts.map(({ integrationId, manifest, status, imposed, refusal }) => ({
    integration_package_id: integrationId,
    display_name: manifest.display_name ?? manifest.name,
    proxy_connection: { status, imposed },
    ...(refusal ? { refusal: offered[next++]! } : {}),
  }));
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Why no connection answers. Outside a run the wording depends only on whether an id was named,
 * never on whose row it names or whether it exists.
 */
export function noConnectionMessage(
  input: Pick<ResolveIntegrationProxyInput, "integrationId" | "connectionId" | "connectionNaming"> &
    ({ run: Pick<ProxyRunSelection, "id">; reach?: never } | { reach: ProxyReach; run?: never }),
): string {
  const { integrationId, run } = input;
  if (run) return `Run '${run.id}' binds no usable connection of integration '${integrationId}'`;
  const named = connectionParam(input.connectionNaming).label;
  if (input.reach === "usable") {
    return input.connectionId
      ? `${named} names no connection of integration '${integrationId}' usable in this space`
      : `No connection of integration '${integrationId}' is usable in this space`;
  }
  const subject = input.connectionId
    ? `${named} names none of your own connections of integration '${integrationId}' usable in this space`
    : `You have no connection of integration '${integrationId}' usable in this space`;
  return (
    `${subject}. A connection shared into the space is reached by a caller holding ` +
    `credential-proxy:call, or through an agent run the platform executes.`
  );
}

async function loadManifest(input: ResolveIntegrationProxyInput): Promise<IntegrationManifest> {
  const { integrationId } = input;
  const frozen = input.run ? await input.run.frozenVersion() : (input.version ?? null);
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
    ...(input.connectionNaming ? { naming: input.connectionNaming } : {}),
    ...(input.run ? { run: input.run } : { reach: input.reach }),
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

/**
 * An auth's `authorized_uris` as the listing gives them: rendered from the connection's variables
 * alone. An entry templated on a credential field stays as the manifest declares it — a bare
 * `{$credential.<field>}` entry renders to that field's whole URL, query string included, and the
 * field may be the secret itself. Only {@link buildPayloadFromFields} renders with the credential.
 */
function listedAuthorizedUris(
  authDef: Pick<AfpsManifestAuth, "authorized_uris">,
  variables: ConnectionVariables,
): string[] {
  return (authDef.authorized_uris ?? []).flatMap((pattern) =>
    credentialTemplateRefs(pattern).length > 0
      ? [pattern]
      : renderAuthAuthorizedUris({ authorized_uris: [pattern] }, {}, variables),
  );
}
