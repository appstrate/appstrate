// SPDX-License-Identifier: Apache-2.0

/**
 * Integration connection layer, the write side of `/api/integrations/*`: OAuth2 client
 * registration (space and org, `integration_oauth_clients`, the secret v1-envelope encrypted), the
 * connection writers (`integration_connections`, v2 envelope; the acquisition flows live in
 * `services/connect/*-strategy.ts`), and the lookups of the UI and the runtime resolvers. Client
 * provisioning at connect time lives in `integration-oauth-provisioning.ts`.
 */

import {
  and,
  arrayContains,
  arrayOverlaps,
  asc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  spacePackages,
  integrationConnections,
  integrationConnectionShares,
  integrationOauthClients,
  integrationOrgDefaults,
  integrationPins,
  packages,
  schedules,
  spaces,
} from "@appstrate/db/schema";
import {
  encryptCredentials,
  encryptCredentialEnvelope,
  decryptCredentials,
  decryptCredentialsToStringMap,
  isClientMetadataRedirectTag,
} from "@appstrate/connect";
import { getEnv } from "@appstrate/env";
import { issuerOfClientMetadataDocumentRef } from "../lib/integration-client-metadata.ts";
import {
  resolveSystemClientForAuth,
  getDefaultSystemIntegrationClient,
  listSystemIntegrationClientsFor,
  type SystemIntegrationClientDefinition,
} from "./integration-client-registry.ts";
import { isActiveHere } from "./package-activation.ts";
import { placementReadFilter, placementRowJoin } from "./package-placement.ts";
import {
  setExactlyOneDefault,
  isUniqueViolation,
  isUuid,
  type DbOrTx,
  type Tx,
} from "../lib/db-helpers.ts";
import { logger } from "../lib/logger.ts";
import {
  decryptForDisplay,
  decryptStoredCredential,
  encryptionKeyUnavailable,
  KEY_UNAVAILABLE,
} from "../lib/stored-credential.ts";
import { ApiError, notFound, conflict, invalidRequest, forbidden } from "../lib/errors.ts";
import { proxyProblem } from "../lib/proxy-status.ts";
import {
  evaluateJsonPath,
  JsonPathSyntaxError,
  parseJsonPath,
} from "@appstrate/afps-shared/jsonpath";
import type { OrgScope, SpaceScope } from "../lib/scope.ts";
import { actorFromIds, actorInsert, actorFilter, actorOwns } from "../lib/actor.ts";
import {
  connectionActions,
  meConnectionAuthorityFilter,
  OLDEST_FIRST,
  ownRowInSpace,
  ownUsableInSpace,
  sharedInto,
  usableInSpace,
  type ConnectionCaller,
} from "./connection-reach.ts";
import { shareableSpaces } from "./connection-shares.ts";
import { boundSpaceOf, type ConnectionPrincipal } from "../lib/connection-principal.ts";
import type { OrgRole } from "@appstrate/core/permissions";
import { readReconnectTarget } from "./integration-scope-resolver.ts";
import {
  getPackageDisplayName,
  notEphemeralFilter,
  orgOrSystemFilter,
} from "../lib/package-helpers.ts";
import {
  integrationCallbackUrl,
  authorizationServerTag,
  redirectTagOf,
} from "../lib/integration-callback-url.ts";
import { CONNECTION_LABEL_MAX, toMintedLabel } from "../lib/connection-label.ts";
import { dedupeLabel } from "@appstrate/core/dedupe-label";
import type { Actor, AuthorizationServerBinding, ResolvedOAuthClient } from "@appstrate/connect";
import {
  isUnauthenticatedIntegration,
  resolveIntegrationToolCatalog,
  readDefaultTools,
  type ConnectionCandidate,
  type ConnectionOverrides,
  type ConnectionResolutionError,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import type { ConnectionReach, IntegrationToolCatalogEntry } from "@appstrate/shared-types";
import type { ConnectionVariables } from "./connect/connection-variables.ts";
import {
  PLACEHOLDER_ACCOUNT_ID,
  connectionVariablesOf,
  displayAccountId,
  sameConnectionVariables,
} from "../lib/connection-identity.ts";
import {
  getLocalServerRef,
  hasPerConnectionAuthServer,
  toSupportedTokenEndpointAuthMethod,
  usesAutoProvisionedClient,
} from "./integration-manifest-helpers.ts";
import { fetchMcpServerManifest, readMcpServerTools } from "./integration-service.ts";
import { resolveConnectionOwnerNames } from "./integration-connection-owner-names.ts";
import {
  disableSchedules,
  isForeignNaming,
  scheduleActorIs,
  scheduleOverridesName,
  schedulesNamingAny,
} from "./schedules-naming-connection.ts";
import {
  disableSchedulesLeftUnnamed,
  pinLayer,
  schedulesLayerMayName,
} from "./schedules-named-by-layer.ts";
import { lockIntegrationGovernance } from "./integration-pins-service.ts";
import {
  actorIdentityOf,
  candidateOf,
  proxyRequirement,
  resolveConnections,
  toLaunchOverrides,
  translateResolutionError,
} from "./integration-connection-resolver.ts";
import {
  listOrgDefaultsForResolver,
  type OrgDefaultPick,
} from "./integration-org-defaults-service.ts";
import { requireRunBoundMember } from "../lib/run-bound-connection.ts";
import type { AfpsManifestAuth } from "./integration-manifest-helpers.ts";
import type { IntegrationAuthStatus } from "@appstrate/shared-types";
import { readIntegrationManifestForConnect } from "./integration-service.ts";
import { assertSpaceInScope } from "./spaces.ts";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type { IntegrationConnection as IntegrationConnectionSummary } from "@appstrate/shared-types";

import type {
  IntegrationConnection as IntegrationConnectionSummary,
  IntegrationOAuthClient,
} from "@appstrate/shared-types";

/** A client record with its decrypted secret: project with {@link toPublicClient} before responding. */
export interface IntegrationOAuthClientWithSecret extends IntegrationOAuthClient {
  /** Row PK — the connection's `client_ref` when this custom client mints it. */
  id: string;
  clientSecret: string;
  /** Whether this custom client is the default for new connections (else system). */
  isDefault: boolean;
  /** `true` for a DCR-minted machine client (remote MCP public client). */
  autoProvisioned: boolean;
  /** The server an auto-provisioned client is registered at and bound to (AFPS §7.3). */
  issuer: string | null;
  /** The secret is under a key id the keyring lacks: connecting answers a 503. */
  secretKeyUnavailable: boolean;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function lookupAuth(
  manifest: IntegrationManifest,
  authKey: string,
): NonNullable<IntegrationManifest["auths"]>[string] {
  const auths = manifest.auths ?? {};
  const auth = auths[authKey];
  if (!auth) {
    throw notFound(`Integration '${manifest.name}' has no auth '${authKey}'`);
  }
  return auth;
}

/** The manifest connecting reads ({@link readIntegrationManifestForConnect}), or a 404. */
async function loadManifestOrThrow(
  scope: SpaceScope | OrgScope,
  packageId: string,
): Promise<IntegrationManifest> {
  const read = await readIntegrationManifestForConnect(scope, packageId);
  if (read.ok) return read.manifest;
  throw notFound(
    read.reason === "no_usable_version"
      ? `Integration '${packageId}' has no usable published version to connect through: publish one`
      : `Integration '${packageId}' not found in this organization`,
  );
}

// ─────────────────────────────────────────────
// Cross-service helpers (shared with the credentials + spawn resolvers)
// ─────────────────────────────────────────────

/** What every credential and spawn resolver reads of a connection row (`id`: refresh write-back). */
interface ActorConnectionRow {
  id: string;
  credentialsEncrypted: string;
  expiresAt: Date | null;
  scopesGranted: string[];
  /** The minting client's flat id, so refresh uses the same credentials; `null` for non-oauth2. */
  clientRef: string | null;
  refreshFailureCount: number;
  /** Read with `credentialsEncrypted`: the upstream that credential is for. */
  variables: ConnectionVariables;
  oauthResource: string | null;
}

/** Spawn-side row: its `authKey` picks the auth's `delivery` declaration. */
export interface ResolvedConnectionRow extends ActorConnectionRow {
  authKey: string;
  /** {@link credentialRevision} of `credentialsEncrypted`, read in the same statement. */
  credentialRevision: string;
}

/** The connection a reconnect targets, read once at the door ({@link readReconnectTarget}). */
export interface ReconnectTarget {
  id: string;
  /** `null`: the row serves its whole org, so its reconnect resolves no space client. */
  spaceId: string | null;
  scopesGranted: string[];
}

// IDOR guard on a client-supplied reconnect target. Ownership, not usability:
// `block_user_connections` never stops a renewal.
export async function assertConnectionBelongsToActor(
  connectionId: string,
  input: { spaceId: string; integrationId: string; authKey: string },
  principal: ConnectionPrincipal,
): Promise<ReconnectTarget> {
  const target = await readReconnectTarget({ ...input, connectionId, actor: principal.actor });
  if (!target) throw notFound("Connection not found");
  assertDelegatedReconnect(principal.kind === "delegated", target.spaceId, input.spaceId);
  return target;
}

/**
 * A delegated credential (API key, third-party token) reconnects only a row scoped to the space it
 * acts in. Asked at the door and again under the write's row lock.
 */
function assertDelegatedReconnect(
  delegated: boolean | undefined,
  rowSpaceId: string | null,
  spaceId: string,
): void {
  if (delegated && rowSpaceId !== spaceId) {
    throw forbidden(
      "A delegated credential cannot reconnect a connection serving the whole organization: its owner reconnects it from their own session",
    );
  }
}

function scopeNarrowingRefused(remedy: string): ApiError {
  return conflict(
    "connection_scope_narrowing",
    `This connection serves the whole organization, and the OAuth client that would reconnect it belongs to one space only. ${remedy}`,
  );
}

/**
 * {@link loadAccessibleConnectionById}'s reach: the connection, of `integrationId`, in the
 * space, the actor's own or shared.
 */
function reachableConnection(
  connectionId: string,
  integrationId: string,
  context: { spaceId: string; actor: Actor },
): SQL {
  return and(
    eq(integrationConnections.id, connectionId),
    eq(integrationConnections.integrationId, integrationId),
    usableInSpace(context.spaceId, context.actor),
  )!;
}

/**
 * Short, non-reversible digest of the stored ciphertext: any credential write changes it, so a
 * caller holding a superseded credential can say which one it holds without seeing the current one.
 */
const credentialRevision = sql<string>`left(encode(sha256(convert_to(${integrationConnections.credentialsEncrypted}, 'UTF8')), 'hex'), 16)`;

/** The connection's current {@link credentialRevision}; `null` once the row is gone. */
export async function readCredentialRevision(connectionId: string): Promise<string | null> {
  const [row] = await db
    .select({ credentialRevision })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
    .limit(1);
  return row?.credentialRevision ?? null;
}

/**
 * A connection by id, in the space, within the actor's reach (own or shared): the spawn and
 * live-credential resolvers' run-bound load. `integrationId` is a required filter: the id is
 * caller-supplied on some paths, and without it integration B's credentials could be injected
 * under A's manifest and `authorized_uris`. `expectedAuthKey` narrows to a pinned auth (`null`:
 * the row's own is authoritative).
 */
export async function loadAccessibleConnectionById(
  connectionId: string,
  integrationId: string,
  expectedAuthKey: string | null,
  context: { spaceId: string; actor: Actor },
): Promise<ResolvedConnectionRow | null> {
  const [row] = await db
    .select({
      id: integrationConnections.id,
      integrationId: integrationConnections.integrationId,
      authKey: integrationConnections.authKey,
      credentialsEncrypted: integrationConnections.credentialsEncrypted,
      credentialRevision,
      expiresAt: integrationConnections.expiresAt,
      scopesGranted: integrationConnections.scopesGranted,
      clientRef: integrationConnections.clientRef,
      refreshFailureCount: integrationConnections.refreshFailureCount,
      variables: integrationConnections.variables,
      oauthResource: integrationConnections.oauthResource,
    })
    .from(integrationConnections)
    .where(
      and(
        reachableConnection(connectionId, integrationId, context),
        ...(expectedAuthKey !== null ? [eq(integrationConnections.authKey, expectedAuthKey)] : []),
      ),
    )
    .limit(1);
  if (!row) return null;

  // Defence in depth: the WHERE already binds the row; a mismatch means the query drifted.
  if (
    row.integrationId !== integrationId ||
    (expectedAuthKey !== null && row.authKey !== expectedAuthKey)
  ) {
    throw forbidden(
      `Connection '${connectionId}' does not belong to integration '${integrationId}'` +
        (expectedAuthKey !== null ? ` auth '${expectedAuthKey}'` : ""),
    );
  }
  const { integrationId: _integrationId, variables, ...resolved } = row;
  return { ...resolved, variables: connectionVariablesOf(variables) };
}

/** The `X-Run-Id` run; `boundSet` re-checks it on every selection, the 401 refresh included. */
export interface RunBoundSelection {
  id: string;
  boundSet: () => Promise<readonly { connectionId: string }[]>;
}

export type ProxyReach = "own" | "usable";

/** What a proxy call selects from: a run's bound set, or the caller's reach outside a run. */
type ProxySelectionPath =
  { run: RunBoundSelection; reach?: never } | { reach: ProxyReach; run?: never };

type ConnectionSelectionContext = {
  spaceId: string;
  actor: Actor;
  /**
   * The space's org defaults, when the caller already read them (the detail's verdict): outside a
   * run they are then not read again. Never mutated.
   */
  orgDefaults?: Record<string, OrgDefaultPick>;
} & ProxySelectionPath;

/**
 * The credential proxy's connection of `packageId`. Under a run, a member of its bound set, a
 * colleague's shared row included: the kickoff applied every layer. Outside a run, one of the
 * rows in reach: `usable` walks the cascade, pins aside — under an ENFORCED org default a named
 * id must be one of its members and is picked alone (the resolver would bind the imposed set
 * whole), an unnamed call binds the default; under `own` no org default applies, and an
 * integration an enforced one governs answers `call_permission_required`. `null` when nothing
 * answers, as for an id out of reach (a colleague's row or none). The pick passes health checks.
 */
export async function selectAccessibleConnection(
  packageId: string,
  manifest: IntegrationManifest,
  namedConnectionId: string | null,
  context: ConnectionSelectionContext,
): Promise<ResolvedConnectionRow | null> {
  let named = namedConnectionId?.toLowerCase() ?? null;
  const identity = actorIdentityOf(context.actor);
  const candidatesOf = (set: readonly SelectableRow[]) =>
    set.map((r) => candidateOf(identity, r, []));
  const { run, reach } = context;
  let rows: SelectableRow[];
  // A run's bound set passed governance at kickoff, and the `own` reach skips every layer.
  let orgDefaults: Record<string, OrgDefaultPick> | null = null;
  if (run) {
    const bound = await run.boundSet();
    if (named) {
      requireRunBoundMember({
        runId: run.id,
        packageId,
        connectionId: named,
        bound,
        param: "X-Connection-Id",
      });
    } else if (bound.length === 1) {
      named = bound[0]!.connectionId;
    } else if (bound.length === 0) {
      return null;
    }
    rows = await listReachableConnections(context, "usable", [packageId]);
    if (!named) {
      const ids = new Set(bound.map((m) => m.connectionId));
      throw mustChoose(
        packageId,
        candidatesOf(rows.filter((r) => ids.has(r.id))),
        `Run '${run.id}' bound several connections`,
      );
    }
  } else {
    // A copy: the named-member branch below removes this integration's entry.
    const spaceDefaults = context.orgDefaults
      ? { ...context.orgDefaults }
      : await listOrgDefaultsForResolver(context.spaceId);
    const spaceDefault = spaceDefaults[packageId];
    const enforcedIds = spaceDefault?.enforce ? spaceDefault.connectionIds : null;
    if (reach === "usable") {
      if (named && enforcedIds) {
        if (!enforcedIds.includes(named)) {
          throw proxyProblem(
            "connection_not_in_org_default",
            `X-Connection-Id names a connection outside the enforced org default of '${packageId}', ` +
              `which binds every call in this space: name one of its members, or none.`,
            "X-Connection-Id",
          );
        }
        // The named member alone: the resolver would bind the imposed set whole.
        delete spaceDefaults[packageId];
      }
      orgDefaults = spaceDefaults;
    } else if (enforcedIds) {
      throw proxyProblem(
        "call_permission_required",
        `Integration '${packageId}' is governed by an enforced org default in this space: it is ` +
          `reached by a caller holding credential-proxy:call, or through an agent run the ` +
          `platform executes.`,
      );
    }
    rows = await listReachableConnections(context, reach, [packageId]);
  }

  const { resolved, errors } = resolveConnections({
    requirements: [proxyRequirement(packageId, manifest)],
    accessibleConnections: rows,
    pins: [],
    orgDefaults,
    launchOverrides: toLaunchOverrides(named ? { [packageId]: [named] } : null, "run_override"),
    ...identity,
  });
  const error = errors[0];
  if (error?.code === "not_connected" || error?.code === "override_connection_unavailable") {
    return null;
  }
  if (error?.code === "must_choose_connection") {
    const candidates = error.candidateConnections ?? [];
    const reason = candidates.some((c) => c.ownedByActor)
      ? "No single connection applies"
      : "Only connections shared by other members exist";
    throw mustChoose(packageId, candidates, reason);
  }
  if (error) throw resolutionConflict(error);

  const set = resolved[packageId]!.map((m) => rows.find((r) => r.id === m.connectionId)!);
  if (set.length === 1) return toResolvedRow(set[0]!);
  throw mustChoose(packageId, candidatesOf(set), "The org default holds several connections");
}

/**
 * The connection an unnamed credential-proxy call outside a run gets for the caller, as one status:
 * {@link selectAccessibleConnection}'s outcome under `reach`, judged against `manifest` — the one
 * the integration detail serves (its latest published version, else the draft while none is), which
 * the proxy authorizes against. It names no connection and no colleague; `active` reports the
 * other condition the proxy checks.
 *
 *   - `ready`: one connection binds and passes its health checks.
 *   - `must_choose`: several apply (or only colleagues' shared ones); a call names one.
 *   - `needs_reconnection`: the bound connection must be reconnected.
 *   - `none`: no connection in reach.
 *   - `not_permitted`: no proxy permission, or `call_permission_required` (an enforced org
 *     default, and only `credential-proxy:call-own`).
 *   - `default_unavailable`: the org default cannot bind (a member gone or off-auth, an empty set,
 *     a set too large); pins never apply outside a run.
 *   - `unusable`: `insufficient_scopes`, `auth_serves_no_selected_tool`, or another refusal (logged).
 *
 * `imposed`: an enforced org default governs the integration here — the space's admins decide.
 */
export type ProxyConnectionStatus =
  | "ready"
  | "must_choose"
  | "needs_reconnection"
  | "none"
  | "not_permitted"
  | "default_unavailable"
  | "unusable"
  | "not_required";

export async function proxyConnectionVerdict(
  packageId: string,
  manifest: IntegrationManifest,
  context: { spaceId: string; actor: Actor; reach: ProxyReach | null },
): Promise<{ status: ProxyConnectionStatus; imposed: boolean }> {
  // Read once, for `imposed` and for the selection.
  const orgDefaults = await listOrgDefaultsForResolver(context.spaceId);
  const imposed = orgDefaults[packageId]?.enforce === true;
  if (isUnauthenticatedIntegration(manifest)) return { status: "not_required", imposed };
  const { reach } = context;
  // The proxy route admits neither: nothing is selected for such a caller.
  if (reach === null) return { status: "not_permitted", imposed };
  const selection = { spaceId: context.spaceId, actor: context.actor, reach, orgDefaults };
  const status = await selectAccessibleConnection(packageId, manifest, null, selection).then(
    (row): ProxyConnectionStatus => (row ? "ready" : "none"),
    (err: unknown): ProxyConnectionStatus => {
      if (!(err instanceof ApiError)) throw err;
      switch (err.code) {
        case "must_choose_connection":
          return "must_choose";
        case "needs_reconnection":
          return "needs_reconnection";
        case "call_permission_required":
          return "not_permitted";
        case "pinned_connection_unavailable":
        case "required_integration_unbound":
        case "connection_set_too_large":
          return "default_unavailable";
        case "insufficient_scopes":
        case "auth_serves_no_selected_tool":
          return "unusable";
        default:
          logger.warn("proxy connection verdict: unmapped selection refusal", {
            packageId,
            code: err.code,
          });
          return "unusable";
      }
    },
  );
  return { status, imposed };
}

/**
 * The rows the actor reaches in `spaceId`, {@link OLDEST_FIRST}: under `usable` what it may bind
 * there ({@link usableInSpace}), under `own` its own ({@link ownUsableInSpace}); of
 * `integrationIds` when given, of every integration otherwise.
 */
export async function listReachableConnections(
  context: { spaceId: string; actor: Actor },
  reach: ProxyReach,
  integrationIds?: string[],
): Promise<SelectableRow[]> {
  if (integrationIds?.length === 0) return [];
  const inReach = reach === "own" ? ownUsableInSpace : usableInSpace;
  return loadSelectableRows(
    and(
      integrationIds === undefined
        ? undefined
        : inArray(integrationConnections.integrationId, integrationIds),
      inReach(context.spaceId, context.actor),
    ),
  );
}

function loadSelectableRows(where: SQL | undefined) {
  return db
    .select({ ...getTableColumns(integrationConnections), credentialRevision })
    .from(integrationConnections)
    .where(where)
    .orderBy(...OLDEST_FIRST);
}

type SelectableRow = Awaited<ReturnType<typeof loadSelectableRows>>[number];

function toResolvedRow(row: SelectableRow): ResolvedConnectionRow {
  const {
    id,
    authKey,
    credentialsEncrypted,
    credentialRevision,
    expiresAt,
    scopesGranted,
    clientRef,
    refreshFailureCount,
    variables,
    oauthResource,
  } = row;
  return {
    id,
    authKey,
    credentialsEncrypted,
    credentialRevision,
    expiresAt,
    scopesGranted,
    clientRef,
    refreshFailureCount,
    variables: connectionVariablesOf(variables),
    oauthResource,
  };
}

function mustChoose(
  packageId: string,
  candidateConnections: ConnectionCandidate[],
  reason: string,
): ApiError {
  return resolutionConflict({
    integrationId: packageId,
    code: "must_choose_connection",
    message: `${reason} for '${packageId}' — name one with the X-Connection-Id header.`,
    candidateConnections,
  });
}

function resolutionConflict(error: ConnectionResolutionError): ApiError {
  const item = translateResolutionError(error);
  return new ApiError({
    status: 409,
    code: error.code,
    title: item.title ?? "Conflict",
    detail: item.message,
    errors: [item],
  });
}

/** An integration's activation in a space; `blockUserConnections` is `false` without a row. */
interface IntegrationActivation {
  active: boolean;
  blockUserConnections: boolean;
}

/**
 * The activation of each integration of `packageIds` in the space, in one SELECT, by the rule
 * {@link isActiveHere} states for every package type: a `space_packages` row's `enabled` wins (a
 * deactivated system integration keeps an `enabled = false` row: the opt-out is sticky); without a
 * row, a system integration (`SYSTEM_INTEGRATIONS`) is active and any other is not. Every
 * requested id is in the map.
 */
export async function resolveIntegrationActivations(
  packageIds: readonly string[],
  spaceId: string,
): Promise<Map<string, IntegrationActivation>> {
  const result = new Map<string, IntegrationActivation>();
  if (packageIds.length === 0) return result;
  const rows = await db
    .select({
      packageId: spacePackages.packageId,
      enabled: spacePackages.enabled,
      blockUserConnections: spacePackages.blockUserConnections,
    })
    .from(spacePackages)
    .where(
      and(
        eq(spacePackages.spaceId, spaceId),
        inArray(spacePackages.packageId, packageIds as string[]),
      ),
    );
  const byId = new Map(rows.map((r) => [r.packageId, r]));
  for (const id of packageIds) {
    const row = byId.get(id);
    result.set(id, {
      // `source` is not read for an integration: `SYSTEM_INTEGRATIONS` is the offer.
      active: isActiveHere({ id, type: "integration", source: null }, row),
      blockUserConnections: row?.blockUserConnections === true,
    });
  }
  return result;
}

/** Whether the integration is active in the space ({@link resolveIntegrationActivations}). */
export async function isIntegrationActive(packageId: string, spaceId: string): Promise<boolean> {
  const map = await resolveIntegrationActivations([packageId], spaceId);
  return map.get(packageId)!.active;
}

/** The active subset of `packageIds` ({@link resolveIntegrationActivations}). */
export async function listActiveIntegrationIds(
  packageIds: readonly string[],
  spaceId: string,
): Promise<Set<string>> {
  const map = await resolveIntegrationActivations(packageIds, spaceId);
  const active = new Set<string>();
  for (const [id, activation] of map) {
    if (activation.active) active.add(id);
  }
  return active;
}

/** Throw `notFound` unless the integration is active in the space. */
export async function assertIntegrationActive(packageId: string, spaceId: string): Promise<void> {
  if (!(await isIntegrationActive(packageId, spaceId))) {
    throw notFound(`Integration '${packageId}' is not active in this space`);
  }
}

// ─────────────────────────────────────────────
// OAuth client registration (admin)
// ─────────────────────────────────────────────

type IntegrationOAuthClientRow = typeof integrationOauthClients.$inferSelect;

/**
 * Project a client row, decrypting `client_secret`. A decrypt failure does not throw — the admin
 * list must still load to fix the row — but yields an empty secret beside `has_client_secret: true`;
 * acting on the client is refused by `assertConnectClientUsable` (503 or 403).
 */
function projectClientWithSecret(row: IntegrationOAuthClientRow): IntegrationOAuthClientWithSecret {
  // A public client stores no ciphertext at all, so there is nothing to decrypt.
  const stored =
    row.clientSecretEncrypted === ""
      ? null
      : decryptForDisplay(
          () => decryptCredentials<{ client_secret?: string }>(row.clientSecretEncrypted),
          { packageId: row.integrationId, authKey: row.authKey, clientId: row.id },
        );
  const secretKeyUnavailable = stored === KEY_UNAVAILABLE;
  // Unreadable: "" here, while `has_client_secret` below still reads the column.
  const secret = stored && stored !== KEY_UNAVAILABLE ? (stored.client_secret ?? "") : "";
  return {
    id: row.id,
    spaceId: row.spaceId,
    integration_package_id: row.integrationId,
    auth_key: row.authKey,
    client_id: row.clientId,
    clientSecret: secret,
    // From the column, never from the decrypt: an unreadable secret is not an absent one, and
    // `assertConnectClientUsable` stops the row rather than send it as public.
    has_client_secret: row.clientSecretEncrypted.length > 0,
    // `null`: the manifest's method applies; never re-derived from the secret.
    token_endpoint_auth_method: row.tokenEndpointAuthMethod ?? null,
    redirect_uri: row.redirectUri,
    isDefault: row.isDefault,
    autoProvisioned: row.autoProvisioned,
    issuer: row.issuer,
    secretKeyUnavailable,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Project a `…WithSecret` record into the public wire shape (drops the secret). */
export function toPublicClient(client: IntegrationOAuthClientWithSecret): IntegrationOAuthClient {
  const {
    clientSecret: _clientSecret,
    isDefault: _isDefault,
    autoProvisioned: _auto,
    issuer: _issuer,
    secretKeyUnavailable: _secretKeyUnavailable,
    ...rest
  } = client;
  return rest;
}

/** A client row's tier: a space, or its org (stored as `space_id IS NULL`). */
type ClientOwner = SpaceScope | OrgScope;

function isSpaceOwner(owner: ClientOwner): owner is SpaceScope {
  return "spaceId" in owner;
}

function tierFilter(owner: ClientOwner): SQL {
  return isSpaceOwner(owner)
    ? eq(integrationOauthClients.spaceId, owner.spaceId)
    : and(eq(integrationOauthClients.orgId, owner.orgId), isNull(integrationOauthClients.spaceId))!;
}

export function tierAuthFilter(owner: ClientOwner, packageId: string, authKey: string): SQL {
  return and(
    tierFilter(owner),
    eq(integrationOauthClients.integrationId, packageId),
    eq(integrationOauthClients.authKey, authKey),
  )!;
}

function clientByIdFilter(owner: ClientOwner, packageId: string, clientId: string): SQL {
  return and(
    tierFilter(owner),
    eq(integrationOauthClients.integrationId, packageId),
    eq(integrationOauthClients.id, clientId),
  )!;
}

function spaceVisibleFilter(scope: SpaceScope): SQL {
  return and(
    eq(integrationOauthClients.orgId, scope.orgId),
    or(isNull(integrationOauthClients.spaceId), eq(integrationOauthClients.spaceId, scope.spaceId)),
  )!;
}

async function assertOwnerInScope(
  owner: ClientOwner,
  packageId: string,
  authKey: string,
): Promise<void> {
  if (isSpaceOwner(owner)) return assertSpaceInScope(owner);
  assertClientAuth(await loadManifestOrThrow(owner, packageId), authKey);
}

/** oauth2 auths only; a manual client on a DCR auth would shadow auto-registration. */
function assertClientAuth(
  manifest: IntegrationManifest,
  authKey: string,
  autoProvisioned = false,
): void {
  const auth = lookupAuth(manifest, authKey) as AfpsManifestAuth;
  if (auth.type !== "oauth2") {
    throw invalidRequest(
      `Auth '${authKey}' is type '${auth.type}', not oauth2: it has no OAuth clients`,
    );
  }
  if (!autoProvisioned && hasPerConnectionAuthServer(manifest, auth)) {
    throw invalidRequest(
      `Integration '${manifest.name}' auth '${authKey}' chooses its authorization server per connection, so its OAuth client is provisioned automatically for each server (client metadata document or DCR); a manual client, bound to one server, must not be registered.`,
    );
  }
  if (!autoProvisioned && usesAutoProvisionedClient(manifest, auth)) {
    throw invalidRequest(
      `Integration '${manifest.name}' auth '${authKey}' provisions its OAuth client automatically at connect time (client metadata document or DCR); a manual client must not be registered. Connect without supplying credentials, or delete the existing client to restore auto-registration.`,
    );
  }
}

/**
 * `owner`'s custom clients, decrypted, oldest-first (a space sees its org's): `selectable`, the
 * manual rows only — an auto-provisioned one is found by {@link getAutoProvisionedClient} alone,
 * even once its auth turned classic; `all` adds them.
 */
export async function loadClientTiers(
  owner: ClientOwner,
  packageId: string,
  authKey: string,
  rows: "selectable" | "all" = "selectable",
): Promise<{ space: IntegrationOAuthClientWithSecret[]; org: IntegrationOAuthClientWithSecret[] }> {
  const found = await db
    .select()
    .from(integrationOauthClients)
    .where(
      and(
        isSpaceOwner(owner) ? spaceVisibleFilter(owner) : tierFilter(owner),
        eq(integrationOauthClients.integrationId, packageId),
        eq(integrationOauthClients.authKey, authKey),
        rows === "selectable" ? eq(integrationOauthClients.autoProvisioned, false) : undefined,
      ),
    )
    .orderBy(integrationOauthClients.createdAt);
  const clients = found.map(projectClientWithSecret);
  return {
    space: clients.filter((c) => c.spaceId !== null),
    org: clients.filter((c) => c.spaceId === null),
  };
}

/** The effective default: flagged space ?? flagged org ?? system ?? first space ?? first org client. */
function pickDefault<C extends { isDefault: boolean }, S>(
  space: readonly C[],
  org: readonly C[],
  system: S | null,
): C | S | null {
  return (
    space.find((c) => c.isDefault) ??
    org.find((c) => c.isDefault) ??
    system ??
    space[0] ??
    org[0] ??
    null
  );
}

/** Copies of `clients` with no flag — the tier as if none of its clients were flagged. */
function unflagged<C extends { isDefault: boolean }>(clients: readonly C[]): C[] {
  return clients.map((c) => ({ ...c, isDefault: false }));
}

/** The {@link pickDefault} of `owner`'s tier with its own clients unflagged; compare by `.id`. */
function inheritedDefault<C extends { isDefault: boolean }, S>(
  owner: ClientOwner,
  space: readonly C[],
  org: readonly C[],
  system: S | null,
): C | S | null {
  return isSpaceOwner(owner)
    ? pickDefault(unflagged(space), org, system)
    : pickDefault([], unflagged(org), system);
}

/** The auto-provisioned client of `(packageId, authKey, issuer)` (at most one, `idx_ioc_one_auto`). */
export async function getAutoProvisionedClient(
  org: OrgScope,
  packageId: string,
  authKey: string,
  issuer: string | null,
  executor: DbOrTx = db,
): Promise<IntegrationOAuthClientWithSecret | null> {
  const [row] = await executor
    .select()
    .from(integrationOauthClients)
    .where(
      and(
        tierAuthFilter({ orgId: org.orgId }, packageId, authKey),
        eq(integrationOauthClients.autoProvisioned, true),
        issuer === null
          ? isNull(integrationOauthClients.issuer)
          : eq(integrationOauthClients.issuer, issuer),
      ),
    )
    .limit(1);
  return row ? projectClientWithSecret(row) : null;
}

/** Whether any custom client for this auth is currently flagged default. */
async function hasTierDefault(
  owner: ClientOwner,
  packageId: string,
  authKey: string,
  executor: DbOrTx = db,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: integrationOauthClients.id })
    .from(integrationOauthClients)
    .where(
      and(tierAuthFilter(owner, packageId, authKey), eq(integrationOauthClients.isDefault, true)),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Encode a client row's (method, ciphertext) pair together, so a row never claims public with a
 * secret nor a secret-based method without one: `"none"` → no ciphertext; an undefined secret →
 * `null` (preserve); an empty secret otherwise → refused, as the CHECK cannot see it inside a
 * ciphertext and it would surface only at the provider.
 */
export function encodeClientAuthForStorage(input: {
  clientSecret?: string | undefined;
  tokenEndpointAuthMethod?: string | undefined;
}): { tokenEndpointAuthMethod: string | null; clientSecretEncrypted: string } | null {
  if (input.clientSecret === undefined) {
    // Declaring a client public needs no secret; anything else without one is a preserve.
    if (input.tokenEndpointAuthMethod === "none") {
      return { tokenEndpointAuthMethod: "none", clientSecretEncrypted: "" };
    }
    return null;
  }
  const secret = input.clientSecret;
  if (input.tokenEndpointAuthMethod === "none") {
    // A secret beside "none" is refused by the route schemas, and auto-DCR declares "none" only
    // once the server registered a public client: nothing a caller asked to keep is dropped.
    return { tokenEndpointAuthMethod: "none", clientSecretEncrypted: "" };
  }
  if (secret.length === 0) {
    // Callers may bypass the route schema (auto-DCR): an empty secret is stored only beside an
    // explicit "none", never a method this function would have to invent.
    throw invalidRequest(
      input.tokenEndpointAuthMethod !== undefined
        ? `token_endpoint_auth_method='${input.tokenEndpointAuthMethod}' requires a client_secret, but an empty one was supplied. Send the secret, or declare token_endpoint_auth_method='none' to register a public client.`
        : `an empty client_secret was supplied with no token_endpoint_auth_method. Declare token_endpoint_auth_method='none' to register a public client, or send the secret with the method it belongs to.`,
    );
  }
  return {
    tokenEndpointAuthMethod: input.tokenEndpointAuthMethod ?? null,
    clientSecretEncrypted: encryptCredentials({ client_secret: secret }),
  };
}

/**
 * Register a new custom OAuth2 client (an INSERT: N coexist), the default when its tier has none.
 * A public client is stored as `none` with no ciphertext; `opts.autoProvisioned` marks a DCR
 * machine client, one per auth and issuer (`idx_ioc_one_auto`).
 */
export async function createIntegrationOAuthClient(
  owner: ClientOwner,
  packageId: string,
  authKey: string,
  input: {
    clientId: string;
    clientSecret: string;
    redirectUri?: string;
    /** Explicit `token_endpoint_auth_method` for this client; `"none"` = public. */
    tokenEndpointAuthMethod?: string;
  },
  opts: { autoProvisioned?: boolean; issuer?: string | null } = {},
): Promise<IntegrationOAuthClientWithSecret> {
  if (isSpaceOwner(owner)) await assertSpaceInScope(owner);
  const autoProvisioned = opts.autoProvisioned ?? false;
  assertRedirectUriNotReserved(input.redirectUri, autoProvisioned);
  const issuer = opts.issuer ?? null;
  assertClientAuth(await loadManifestOrThrow(owner, packageId), authKey, autoProvisioned);

  // An auto-provisioned client is never a default: the auto-provisioned path finds it by its
  // issuer (`getAutoProvisionedClient`), and no classic flow or default picker ever sees it. A
  // classic client wins the default only when no manual client holds it.
  const isDefault = !autoProvisioned && !(await hasTierDefault(owner, packageId, authKey));

  const clientAuth = encodeClientAuthForStorage(input)!;
  const now = new Date();
  const insert = (asDefault: boolean) =>
    db
      .insert(integrationOauthClients)
      .values({
        orgId: owner.orgId,
        spaceId: isSpaceOwner(owner) ? owner.spaceId : null,
        integrationId: packageId,
        authKey,
        clientId: input.clientId,
        clientSecretEncrypted: clientAuth.clientSecretEncrypted,
        tokenEndpointAuthMethod: clientAuth.tokenEndpointAuthMethod,
        redirectUri: input.redirectUri ?? null,
        isDefault: asDefault,
        autoProvisioned,
        issuer,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
  const [row] = await insert(isDefault).catch((err: unknown) => {
    // A concurrent create took the tier's first default since `hasTierDefault` read it: land as
    // non-default (`pickDefault` falls back to the tier's first client anyway).
    if (!isDefault || !isUniqueViolation(err)) throw err;
    return insert(false);
  });

  if (!row) {
    throw new Error("createIntegrationOAuthClient: insert returned no row");
  }
  return projectClientWithSecret(row);
}

/**
 * Update a custom client of `owner`'s tier in place (any other id: 404); an absent field is
 * unchanged, an omitted secret preserves the stored pair unless a method is declared.
 */
export async function updateIntegrationOAuthClient(
  owner: ClientOwner,
  packageId: string,
  clientId: string,
  input: {
    /** Omit to PRESERVE the stored secret; `""` declares the client public. */
    clientSecret?: string;
    /** Omit to keep, `null` to clear. */
    redirectUri?: string | null;
    /** Explicit `token_endpoint_auth_method` for this client; `"none"` = public. */
    tokenEndpointAuthMethod?: string;
  },
): Promise<{
  previous: IntegrationOAuthClientWithSecret;
  client: IntegrationOAuthClientWithSecret;
}> {
  if (isSpaceOwner(owner)) await assertSpaceInScope(owner);
  // Only a manual client reaches an edit (auto-provisioned ones are refused below).
  assertRedirectUriNotReserved(input.redirectUri, false);
  const byId = clientByIdFilter(owner, packageId, clientId);
  const [existing] = await db.select().from(integrationOauthClients).where(byId).limit(1);
  if (!existing) {
    throw notFound(`OAuth client '${clientId}' not found`);
  }
  // Machine-managed: a manual edit would point DCR's find-or-create at hand-entered credentials.
  if (existing.autoProvisioned) {
    throw invalidRequest(
      `OAuth client '${clientId}' is auto-provisioned (DCR) and cannot be edited manually; an org administrator deletes it to re-trigger registration.`,
    );
  }
  // An omitted secret keeps the stored pair (a redirect-URI edit must not clear it); a new secret
  // alone keeps the stored secret-based method.
  const keptMethod =
    input.clientSecret && existing.tokenEndpointAuthMethod !== "none"
      ? (existing.tokenEndpointAuthMethod ?? undefined)
      : undefined;
  const clientAuth = encodeClientAuthForStorage({
    ...input,
    tokenEndpointAuthMethod: input.tokenEndpointAuthMethod ?? keptMethod,
  });

  // An absent secret beside a secret-based method is a change: with a stored secret it switches
  // its transport; with none it is refused rather than half-applied.
  let methodOnly: string | undefined;
  if (clientAuth === null && input.tokenEndpointAuthMethod !== undefined) {
    if (existing.clientSecretEncrypted === "") {
      throw invalidRequest(
        `OAuth client '${clientId}' is registered as a public client and stores no client_secret, ` +
          `so it cannot be changed to token_endpoint_auth_method='${input.tokenEndpointAuthMethod}' ` +
          `without one. Send the client_secret together with the method.`,
        "client_secret",
      );
    }
    methodOnly = input.tokenEndpointAuthMethod;
  }

  const [row] = await db
    .update(integrationOauthClients)
    .set({
      ...(clientAuth
        ? {
            clientSecretEncrypted: clientAuth.clientSecretEncrypted,
            tokenEndpointAuthMethod: clientAuth.tokenEndpointAuthMethod,
          }
        : methodOnly !== undefined
          ? { tokenEndpointAuthMethod: methodOnly }
          : {}),
      ...(input.redirectUri !== undefined ? { redirectUri: input.redirectUri } : {}),
      updatedAt: new Date(),
    })
    .where(byId)
    .returning();
  if (!row) {
    throw notFound(`OAuth client '${clientId}' not found`);
  }
  return { previous: projectClientWithSecret(existing), client: projectClientWithSecret(row) };
}

/** A promoted client, and the connections it minted that now serve the whole org. */
interface PromotedClient {
  client: IntegrationOAuthClientWithSecret;
  widened: WidenedConnection[];
}

/** Move a space client to its org tier; same id, so pinned connections keep refreshing. */
export async function promoteIntegrationOAuthClient(
  scope: SpaceScope,
  packageId: string,
  clientId: string,
): Promise<PromotedClient> {
  await assertSpaceInScope(scope);
  try {
    return await moveClientToOrg(scope, packageId, clientId, true);
  } catch (err) {
    // A concurrent write took the org tier's first default: land as non-default.
    if (!isUniqueViolation(err)) throw err;
    return moveClientToOrg(scope, packageId, clientId, false);
  }
}

/** {@link promoteIntegrationOAuthClient}'s transaction; `mayDefault: false` lands it non-default. */
function moveClientToOrg(
  scope: SpaceScope,
  packageId: string,
  clientId: string,
  mayDefault: boolean,
): Promise<PromotedClient> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(integrationOauthClients)
      .where(clientByIdFilter(scope, packageId, clientId))
      .limit(1);
    if (!existing) {
      throw notFound(`OAuth client '${clientId}' not found`);
    }
    if (existing.spaceId) await lockSpacesForKeyShare(tx, [existing.spaceId]);
    if (
      existing.autoProvisioned &&
      (await getAutoProvisionedClient(scope, packageId, existing.authKey, existing.issuer, tx))
    ) {
      throw conflict(
        "auto_client_exists_at_org",
        `OAuth client '${clientId}' is auto-provisioned (DCR), and the organization already holds the auto-provisioned client of this auth${existing.issuer ? ` for ${existing.issuer}` : ""}. Reconnect this space's connections to move them onto it, then delete this client.`,
      );
    }
    // An auto-provisioned client is found by its issuer, never the default.
    const isDefault =
      mayDefault &&
      !existing.autoProvisioned &&
      !(await hasTierDefault({ orgId: scope.orgId }, packageId, existing.authKey, tx));
    const move = (executor: Tx, asDefault: boolean) =>
      executor
        .update(integrationOauthClients)
        .set({ spaceId: null, isDefault: asDefault, updatedAt: new Date() })
        .where(eq(integrationOauthClients.id, existing.id))
        .returning();
    // A savepoint, so a flag refused because a concurrent write took the org default since
    // `hasTierDefault` read it leaves the transaction usable for the plain move.
    const [row] = isDefault
      ? await tx
          .transaction((sp) => move(sp, true))
          .catch((err: unknown) => {
            if (!isUniqueViolation(err)) throw err;
            return move(tx, false);
          })
      : await move(tx, false);
    const widened = await widenConnectionsToOrgScope(
      tx,
      eq(integrationConnections.clientRef, existing.id),
    );
    return { client: projectClientWithSecret(row!), widened };
  });
}

/** A connect-time client (system or custom); its `clientRef` is pinned on the connection. */
export interface ResolvedConnectClient {
  clientId: string;
  /** Pre-registered redirect URI override, or null to use the platform default. */
  redirectUri: string | null;
  /** A per-server callback's tag, in the OAuth state so the callback refuses another path (mix-up). */
  redirectTag?: string;
  clientRef: string;
}

/** Project a registered system client into the connect-time resolved shape. */
function systemConnectClient(def: SystemIntegrationClientDefinition): ResolvedConnectClient {
  return {
    clientId: def.clientId,
    // System clients use the platform default redirect URI (no per-client override).
    redirectUri: null,
    clientRef: def.id,
  };
}

/**
 * Refuse, before the user consents, a client whose secret cannot be decrypted: sent on, it would
 * fail at the token exchange, or under a "none" manifest go out as public — a silent downgrade.
 */
function assertConnectClientUsable(client: IntegrationOAuthClientWithSecret): void {
  if (client.secretKeyUnavailable) {
    throw encryptionKeyUnavailable(null, {
      packageId: client.integration_package_id,
      authKey: client.auth_key,
      clientId: client.id,
    });
  }
  const where = `'${client.integration_package_id}' auth '${client.auth_key}'`;
  if (client.has_client_secret && client.clientSecret === "") {
    throw forbidden(
      `OAuth client '${client.id}' for ${where} holds a client_secret that cannot be decrypted, ` +
        `so no token request it makes can succeed and sending it as a public client would ` +
        `silently downgrade a confidential one. Restore the CONNECTION_ENCRYPTION_KEY this ` +
        `client was registered with, or re-register the client with its secret.`,
    );
  }
}

/**
 * The per-server callbacks are each trusted for one server by what the flow's state holds. A row an
 * admin registers on one would carry its tag into a state requiring nothing — a hostile server's
 * code delivered on that row's flow (mix-up). Only an auto-provisioned row carries a plain tag.
 */
function isReservedRedirectTag(tag: string, autoProvisioned: boolean): boolean {
  // Write side; the connect side is the stricter {@link assertRedirectBoundToFlow}.
  return isClientMetadataRedirectTag(tag) || !autoProvisioned;
}

/**
 * Refuse a row's per-server redirect URI unless it is this flow's server's: a plain tag on an
 * auto-provisioned row, for the issuer the flow resolved; a `cimd/` tag on no row. Anything else
 * would send another server's tag with this flow's token endpoint.
 */
function assertRedirectBoundToFlow(
  client: IntegrationOAuthClientWithSecret,
  tag: string,
  flowIssuer: string | undefined,
): void {
  const bound =
    !isClientMetadataRedirectTag(tag) &&
    client.autoProvisioned &&
    flowIssuer !== undefined &&
    tag === authorizationServerTag(flowIssuer);
  if (!bound) {
    throw new ApiError({
      status: 403,
      code: "oauth_client_redirect_mismatch",
      title: "OAuth Client Redirect Mismatch",
      detail: `OAuth client '${client.id}' for '${client.integration_package_id}' auth '${client.auth_key}' declares a redirect URI reserved for the platform's per-server callbacks (${client.redirect_uri}) that is not the one of this connection's authorization server; change or clear the client's redirect_uri, or delete the client.`,
    });
  }
}

/** A 400 at every writer for a non-provisioned client's `redirect_uri` among the per-server callbacks. */
function assertRedirectUriNotReserved(
  redirectUri: string | null | undefined,
  autoProvisioned: boolean,
): void {
  const tag = redirectUri ? redirectTagOf(redirectUri) : undefined;
  if (tag !== undefined && isReservedRedirectTag(tag, autoProvisioned)) {
    throw new ApiError({
      status: 400,
      code: "redirect_uri_reserved",
      title: "Reserved Redirect URI",
      detail: `redirect_uri ${redirectUri} is one of the platform's per-server callbacks (/api/integrations/callback/<tag> or /api/integrations/callback/cimd/<tag>), which no registered OAuth client may use; register the shared callback (/api/integrations/callback) or another URI.`,
      errors: [
        {
          field: "redirect_uri",
          code: "redirect_uri_reserved",
          title: "Reserved Redirect URI",
          message:
            "The /api/integrations/callback/<tag> and /callback/cimd/<tag> paths are reserved for the platform's per-server callbacks.",
        },
      ],
    });
  }
}

/** Project a custom (space or org) client into the resolved shape. */
function customConnectClient(
  client: IntegrationOAuthClientWithSecret,
  flowIssuer: string | undefined,
): ResolvedConnectClient {
  // Before the authorize redirect, never after the user has consented.
  assertConnectClientUsable(client);
  const redirectTag = client.redirect_uri ? redirectTagOf(client.redirect_uri) : undefined;
  if (redirectTag !== undefined) assertRedirectBoundToFlow(client, redirectTag, flowIssuer);
  return {
    clientId: client.client_id,
    redirectUri: client.redirect_uri ?? null,
    ...(redirectTag ? { redirectTag } : {}),
    clientRef: client.id,
  };
}

/**
 * The OAuth connect config of an initiate call (`ensureIntegrationOAuthClient`); for a classic auth
 * the endpoints stay `undefined` and the caller reads the manifest's.
 */
export interface ResolvedOAuthConnect {
  /** The space's custom (BYO-app) clients — none for an auto-provisioned auth. */
  spaceClients: IntegrationOAuthClientWithSecret[];
  /** The org's clients the space inherits — its one machine client for an auto-provisioned auth. */
  orgClients: IntegrationOAuthClientWithSecret[];
  /** This instance's metadata document, ahead of any DCR machine client, when the server accepts one. */
  metadataDocumentClient?: ResolvedConnectClient;
  /** The server the client was chosen for: the OAuth state holds the `iss` requirement it relied on. */
  authorizationServer?: AuthorizationServerBinding;
  /** Discovered/declared issuer (overrides the manifest when set). */
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  /** RFC 8707 resource indicator (discovered for MCP, else manifest `resource`). */
  resource?: string;
  /** A remote source's checked server metadata: the authorize request reads scopes and S256 from it. */
  serverMetadata?: { issuer?: string; scopesSupported?: string[] };
}

/**
 * Which OAuth client a connect flow uses: the default ({@link pickDefault}); for an auto-provisioned
 * auth its machine client or metadata document, never a system entry. The `clientRef` is pinned.
 */
export function resolveConnectClient(
  integrationId: string,
  authKey: string,
  manifest: IntegrationManifest,
  auth: AfpsManifestAuth,
  resolved: ResolvedOAuthConnect,
  reconnectsOrgRow = false,
): ResolvedConnectClient {
  const autoProvisioned = usesAutoProvisionedClient(manifest, auth);
  const system = autoProvisioned ? null : getDefaultSystemIntegrationClient(integrationId, authKey);
  // An org-scoped row is never narrowed onto a space client.
  const picked = pickDefault(
    reconnectsOrgRow ? [] : resolved.spaceClients,
    resolved.orgClients,
    system,
  );
  if (picked) {
    // The server a per-server redirect URI may name: this flow's, when its client is provisioned.
    const flowIssuer = autoProvisioned ? resolved.authorizationServer?.issuer : undefined;
    return "isDefault" in picked
      ? customConnectClient(picked, flowIssuer)
      : systemConnectClient(picked);
  }
  if (resolved.metadataDocumentClient) return resolved.metadataDocumentClient;
  if (reconnectsOrgRow && resolved.spaceClients.length > 0) {
    throw scopeNarrowingRefused(
      "Ask an administrator to register an organization OAuth client for it, or create a new connection here.",
    );
  }

  // `ensureIntegrationOAuthClient` throws when it provisions no client for an auto-provisioned auth.
  throw forbidden(
    `Administrator must register OAuth client credentials for '${integrationId}' auth '${authKey}' before connection`,
  );
}

/**
 * Resolve a pinned `client_ref` to the credentials that mint and refresh a connection's tokens: the
 * system registry, then this instance's metadata documents (public, bound to the server their URL
 * names), then `integration_oauth_clients` scoped to the space's tiers, integration and auth. The
 * method comes back coherent with the secret; the row's declaration wins over the manifest's.
 * `null`: no such client here, or an unreadable ciphertext; a missing key id throws the 503.
 */
export async function resolveIntegrationClientById(
  clientRef: string,
  spaceId: string,
  integrationId: string,
  authKey: string,
  manifestAuthMethod: string | undefined,
): Promise<ResolvedOAuthClient | null> {
  const resolved = (clientId: string, clientSecret: string, method: string | undefined) => {
    const tokenEndpointAuthMethod = toSupportedTokenEndpointAuthMethod(method);
    return {
      clientId,
      clientSecret,
      ...(tokenEndpointAuthMethod ? { tokenEndpointAuthMethod } : {}),
    };
  };
  // 1) System client (env), validated against this (integrationId, authKey).
  const sys = resolveSystemClientForAuth(clientRef, integrationId, authKey);
  if (sys) {
    // The entry's declaration wins, the manifest's stands in; `SYSTEM_INTEGRATIONS` refuses to
    // boot on a client omitting its secret without declaring "none".
    const method = sys.tokenEndpointAuthMethod ?? manifestAuthMethod;
    return resolved(sys.clientId, method === "none" ? "" : (sys.clientSecret ?? ""), method);
  }

  // 2) A metadata document of this instance: public by construction, whatever the manifest says.
  const documentIssuer = issuerOfClientMetadataDocumentRef(clientRef);
  if (documentIssuer !== null) {
    return { ...resolved(clientRef, "", "none"), issuer: documentIssuer };
  }

  // A custom id is the row's UUID: anything else names no row (and would fail the `uuid` cast).
  if (!isUuid(clientRef)) return null;

  // 3) Custom client of this space or its org, by id AND fully scoped.
  const spaceOrg = db.select({ orgId: spaces.orgId }).from(spaces).where(eq(spaces.id, spaceId));
  const [row] = await db
    .select({
      clientId: integrationOauthClients.clientId,
      clientSecretEncrypted: integrationOauthClients.clientSecretEncrypted,
      tokenEndpointAuthMethod: integrationOauthClients.tokenEndpointAuthMethod,
      issuer: integrationOauthClients.issuer,
    })
    .from(integrationOauthClients)
    .where(
      and(
        eq(integrationOauthClients.id, clientRef),
        or(
          eq(integrationOauthClients.spaceId, spaceId),
          and(
            isNull(integrationOauthClients.spaceId),
            inArray(integrationOauthClients.orgId, spaceOrg),
          ),
        ),
        eq(integrationOauthClients.integrationId, integrationId),
        eq(integrationOauthClients.authKey, authKey),
      ),
    )
    .limit(1);
  if (!row) return null;
  const bound = (client: ResolvedOAuthClient | null): ResolvedOAuthClient | null =>
    client && row.issuer !== null ? { ...client, issuer: row.issuer } : client;

  // The row's declaration wins; the manifest stands in when it has none.
  const method = row.tokenEndpointAuthMethod ?? manifestAuthMethod;
  // A public client stores no ciphertext (`ioc_public_iff_no_secret` makes emptiness "none").
  if (method === "none") {
    return bound(resolved(row.clientId, "", "none"));
  }

  const stored = decryptStoredCredential(
    () => decryptCredentials<{ client_secret?: string }>(row.clientSecretEncrypted),
    { integrationId, authKey, clientRef },
  );
  if (!stored) return null;
  const clientSecret = stored.client_secret ?? "";
  // An empty secret is not normalised to "none" (which would send `client_secret=`): the refresh
  // refuses the pair through `assertClientAuthCoherent` before anything reaches the wire.
  return bound(resolved(row.clientId, clientSecret, method));
}

/** A client that can connect an integration auth, as the UI lists it; never its secret. */
interface IntegrationClientDescriptor {
  /** `client_ref` to pass back at connect time. */
  client_ref: string;
  /** The owning tier: `"system"` (env system client), `"org"` (org-level) or `"space"`. */
  source: "system" | "org" | "space";
  /** The registered `client_id`; for a system client an opaque fingerprint (display only). */
  client_id: string;
  /** True for the client used when no explicit `client_ref` is given at connect. */
  is_default: boolean;
  /** True for a DCR machine client — read-only in the UI (no manual edit). */
  auto_provisioned: boolean;
  /** True when the client carries a non-empty secret (confidential client). */
  has_client_secret: boolean;
  /**
   * The declared method (`null`: the manifest's; `"none"`: public), which the UI reads — not
   * `!has_client_secret`, false too for a confidential client whose secret was not re-entered.
   */
  token_endpoint_auth_method: string | null;
  /** Pre-registered redirect URI override, or null (custom only; system → null). */
  redirect_uri: string | null;
}

/** An opaque, stable display fingerprint of a system client_id, which is a deployment secret. */
function fingerprintSystemClientId(clientId: string): string {
  const hex = new Bun.CryptoHasher("sha256").update(clientId).digest("hex");
  return `sys_${hex.slice(0, 16)}`;
}

/**
 * The OAuth clients of `owner`'s tier, secrets omitted: its {@link inheritedDefault} when not its
 * own, then its own clients oldest-first. Auto-provisioned clients are listed for deletion, never
 * as the default.
 */
export async function listIntegrationClients(
  owner: ClientOwner,
  packageId: string,
  authKey: string,
): Promise<IntegrationClientDescriptor[]> {
  await assertOwnerInScope(owner, packageId, authKey);
  const all = await loadClientTiers(owner, packageId, authKey, "all");
  const space = all.space.filter((c) => !c.autoProvisioned);
  const org = all.org.filter((c) => !c.autoProvisioned);
  const system = getDefaultSystemIntegrationClient(packageId, authKey);
  // A space also sees the org's machine clients it uses (an auto-provisioned row lives at the org).
  const own = isSpaceOwner(owner)
    ? [...all.space, ...all.org.filter((c) => c.autoProvisioned)]
    : all.org;
  const defaultRef = pickDefault(space, org, system)?.id;
  const inherited = inheritedDefault(owner, space, org, system);
  const listed: Array<IntegrationOAuthClientWithSecret | SystemIntegrationClientDefinition> =
    inherited && !own.some((c) => c.id === inherited.id) ? [inherited, ...own] : own;
  return listed.map((c) => describeClient(c, c.id === defaultRef));
}

function describeClient(
  client: IntegrationOAuthClientWithSecret | SystemIntegrationClientDefinition,
  isDefault: boolean,
): IntegrationClientDescriptor {
  if (!("isDefault" in client)) {
    return {
      client_ref: client.id,
      source: "system",
      // Never the real system client_id (a deployment secret).
      client_id: fingerprintSystemClientId(client.clientId),
      is_default: isDefault,
      auto_provisioned: false,
      has_client_secret: client.clientSecret !== undefined,
      // The entry's declaration, `null` when it defers to the manifest; never inferred.
      token_endpoint_auth_method: client.tokenEndpointAuthMethod ?? null,
      redirect_uri: null,
    };
  }
  return {
    client_ref: client.id,
    source: client.spaceId === null ? "org" : "space",
    client_id: client.client_id,
    is_default: isDefault,
    auto_provisioned: client.autoProvisioned,
    has_client_secret: client.has_client_secret,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    redirect_uri: client.redirect_uri,
  };
}

/**
 * Choose `owner`'s tier default: an own client is flagged (others cleared), its
 * {@link inheritedDefault} clears the flags, anything else is refused.
 */
export async function setDefaultIntegrationClient(
  owner: ClientOwner,
  integrationId: string,
  authKey: string,
  clientRef: string,
): Promise<void> {
  await assertOwnerInScope(owner, integrationId, authKey);
  const { space, org } = await loadClientTiers(owner, integrationId, authKey);
  const own = isSpaceOwner(owner) ? space : org;
  const target = own.find((c) => c.id === clientRef);
  const system = getDefaultSystemIntegrationClient(integrationId, authKey);
  const inherits = inheritedDefault(owner, space, org, system)?.id === clientRef;
  if (!target && !inherits) {
    throw invalidRequest(
      `OAuth client '${clientRef}' cannot be the default for '${integrationId}' auth '${authKey}' here`,
    );
  }

  if (own.length === 0) return; // inherited default with no own rows — nothing to persist.

  const authScope = tierAuthFilter(owner, integrationId, authKey);
  const now = new Date();
  await setExactlyOneDefault({
    // Clear every custom default first so the partial unique never sees two.
    clear: (tx) =>
      tx
        .update(integrationOauthClients)
        .set({ isDefault: false, updatedAt: now })
        .where(and(authScope, eq(integrationOauthClients.isDefault, true))),
    // Then flag the chosen client (an inherited selection leaves all cleared).
    set: target
      ? (tx) =>
          tx
            .update(integrationOauthClients)
            .set({ isDefault: true, updatedAt: now })
            .where(eq(integrationOauthClients.id, target.id))
      : null,
  });
}

/** Delete one custom client of `owner`'s tier; a deleted default is not replaced. */
export async function deleteIntegrationOAuthClient(
  owner: ClientOwner,
  packageId: string,
  clientId: string,
): Promise<{
  client: IntegrationOAuthClient;
  deletedConnections: number;
  disabledScheduleIds: string[];
}> {
  if (isSpaceOwner(owner)) await assertSpaceInScope(owner);
  const connectionSpaces = isSpaceOwner(owner)
    ? eq(integrationConnections.spaceId, owner.spaceId)
    : eq(integrationConnections.orgId, owner.orgId);
  const mintedBefore = await db
    .select({ id: integrationConnections.id, userId: integrationConnections.userId })
    .from(integrationConnections)
    .where(and(eq(integrationConnections.clientRef, clientId), connectionSpaces));
  return db.transaction(async (tx) => {
    const schedulesByPin = await schedulesByPinNaming(
      tx,
      mintedBefore.map((c) => c.id),
      mintedBefore.flatMap((c) => (c.userId ? [c.userId] : [])),
    );
    // The client, then its rows — the order a connect and a promote take.
    const [client] = await tx
      .select({ id: integrationOauthClients.id })
      .from(integrationOauthClients)
      .where(clientByIdFilter(owner, packageId, clientId))
      .for("update");
    if (!client) throw notFound(`OAuth client '${clientId}' not found`);
    // Locked as read, in id order: the rows checked below are exactly the rows deleted.
    const minted = await tx
      .select({ id: integrationConnections.id })
      .from(integrationConnections)
      .where(and(eq(integrationConnections.clientRef, clientId), connectionSpaces))
      .orderBy(asc(integrationConnections.id))
      .for("update");
    await assertConnectionsUnpinned(
      tx,
      minted.map((c) => c.id),
      "A connection this OAuth client minted cannot be deleted",
    );
    const [deleted] = await tx
      .delete(integrationOauthClients)
      .where(eq(integrationOauthClients.id, client.id))
      .returning();
    // Cascade: a connection whose minting client is gone can never refresh, so it is deleted in
    // the same transaction (as an IdP revokes an app's tokens). `client_ref` holds the client's
    // UUID, which no system id collides with; the DELETE trigger notifies the UI.
    const deletedConns =
      minted.length === 0
        ? []
        : await tx
            .delete(integrationConnections)
            .where(
              inArray(
                integrationConnections.id,
                minted.map((c) => c.id),
              ),
            )
            .returning(deletedConnectionOwner);
    // Every forget below locks its pins then schedules: locked here first for all of them, in the
    // plan's order, so two batches cannot each hold a row the other waits on.
    const forgotten = deletedConns.map((c) => c.id);
    const owners = [...new Set(deletedConns.flatMap((c) => (c.userId ? [c.userId] : [])))];
    if (owners.length > 0) {
      await tx
        .select({ id: integrationPins.id })
        .from(integrationPins)
        .where(
          and(
            inArray(integrationPins.userId, owners),
            arrayOverlaps(integrationPins.connectionIds, forgotten),
          ),
        )
        .orderBy(
          asc(integrationPins.packageId),
          asc(integrationPins.integrationId),
          asc(integrationPins.id),
        )
        .for("update");
    }
    if (forgotten.length > 0) {
      await tx
        .select({ id: schedules.id })
        .from(schedules)
        .where(or(schedulesNamingAny(forgotten), schedulesIn(schedulesByPin)))
        .orderBy(asc(schedules.id))
        .for("update");
    }
    const disabledScheduleIds: string[] = [];
    for (const row of deletedConns) {
      disabledScheduleIds.push(...(await forgetDeletedConnection(tx, row, schedulesByPin)));
    }
    return {
      client: toPublicClient(projectClientWithSecret(deleted!)),
      deletedConnections: deletedConns.length,
      disabledScheduleIds,
    };
  });
}

// ─────────────────────────────────────────────
// Identity extraction
// ─────────────────────────────────────────────

/**
 * Apply the AFPS `identity_claims` JSONPaths to a source (an unsupported path is `invalid_config`).
 * `accountId`: the `account_id` claim, else `email`/`account_email`/`sub`, else `"default"`.
 */
export function extractIdentity(
  manifest: IntegrationManifest,
  authKey: string,
  source: Record<string, unknown>,
): { accountId: string; identityClaims: Record<string, unknown> } {
  const auth = lookupAuth(manifest, authKey) as AfpsManifestAuth;
  const mapping = auth.identity_claims ?? {};
  const claims: Record<string, unknown> = {};
  for (const [outKey, path] of Object.entries(mapping)) {
    const value = evaluateIdentityPath(source, path, authKey, outKey);
    if (value !== undefined) claims[outKey] = value;
  }
  const accountId =
    (typeof claims.account_id === "string" && claims.account_id) ||
    (typeof source.email === "string" && source.email) ||
    (typeof source.account_email === "string" && source.account_email) ||
    (typeof source.sub === "string" && source.sub) ||
    PLACEHOLDER_ACCOUNT_ID;
  return { accountId, identityClaims: claims };
}

function evaluateIdentityPath(
  source: Record<string, unknown>,
  path: string,
  authKey: string,
  claim: string,
): unknown {
  try {
    return evaluateJsonPath(source, path);
  } catch (err) {
    if (!(err instanceof JsonPathSyntaxError)) throw err;
    throw new ApiError({
      status: 400,
      code: "invalid_config",
      title: "Invalid Integration Manifest",
      detail: `auths.${authKey}.identity_claims.${claim}: ${err.message}`,
      cause: err,
    });
  }
}

/**
 * AFPS §7.4: every `required_identity_claims` (OIDC claim names) must be non-empty in the bag keyed
 * by AFPS keys — through any AFPS key whose path names it, else the bag's own key of that name
 * (login `identity_outputs` merge verbatim). One error lists them all.
 */
export function assertRequiredIdentityClaims(
  manifest: IntegrationManifest,
  authKey: string,
  identityClaims: Record<string, unknown>,
): void {
  const auth = lookupAuth(manifest, authKey) as AfpsManifestAuth;
  const required = auth.required_identity_claims;
  if (!Array.isArray(required) || required.length === 0) return;

  const mapping = auth.identity_claims ?? {};
  // OIDC claim name → the AFPS keys whose single-member path (`"$.sub"`) names it.
  const oidcToAfpsKeys = new Map<string, string[]>();
  for (const [afpsKey, path] of Object.entries(mapping)) {
    const segments = parseJsonPath(path);
    const claim = segments[0];
    if (segments.length !== 1 || typeof claim !== "string") continue;
    const list = oidcToAfpsKeys.get(claim);
    if (list) list.push(afpsKey);
    else oidcToAfpsKeys.set(claim, [afpsKey]);
  }

  const isPresent = (value: unknown): boolean =>
    value !== undefined && value !== null && value !== "";

  const missing: string[] = [];
  for (const oidcClaim of required) {
    const afpsKeys = oidcToAfpsKeys.get(oidcClaim);
    if (afpsKeys && afpsKeys.length > 0) {
      if (afpsKeys.some((k) => isPresent(identityClaims[k]))) continue;
      missing.push(oidcClaim);
      continue;
    }
    // Unmapped: a direct hit on the bag (source-keyed claims of the login engine, or no mapping).
    if (isPresent(identityClaims[oidcClaim])) continue;
    missing.push(oidcClaim);
  }

  if (missing.length === 0) return;
  const list = missing.map((n) => `'${n}'`).join(", ");
  const plural = missing.length === 1 ? "claim" : "claims";
  throw invalidRequest(
    `Integration auth requires identity ${plural} ${list} but the IdP did not return ${missing.length === 1 ? "it" : "them"}.`,
  );
}

// ─────────────────────────────────────────────
// Connection storage
// ─────────────────────────────────────────────

interface StoreConnectionInput {
  packageId: string;
  authKey: string;
  accountId: string;
  credentials: Record<string, unknown>;
  identityClaims?: Record<string, unknown>;
  scopesGranted?: string[];
  expiresAt?: Date | null;
  actor: Actor;
  /** Update this row (reconnect, scope upgrade), owner predicate applied; omitted: insert. */
  connectionId?: string;
  /** Insert-only label seed when no identity was extracted (a masked API-key fingerprint). */
  labelHint?: string;
  /** The minting client's flat id, pinned so refresh resolves it; absent for non-oauth2. */
  clientRef?: string | null;
  /** See {@link PersistCredentialInput}. */
  variables?: Record<string, string> | null;
  oauthResource?: string;
  /** See {@link PersistTarget}. */
  delegated?: boolean;
  /** See {@link PersistTarget}; a reconnect only. */
  onScopeWidened?: (widened: WidenedConnection) => void;
}

/**
 * Where a {@link persistCredentialBundle} write lands: `insert`; `update-owned`, owner-scoped and
 * bound to (packageId, authKey); `update-by-id`, the refresh write-back, a compare-and-set on the
 * client and ciphertext it spent.
 */
export type PersistTarget =
  | {
      kind: "insert";
      scope: SpaceScope;
      actor: Actor;
      /** Written by a delegated credential (API key, third-party token): scoped to the space. */
      delegated?: boolean;
    }
  | {
      kind: "update-owned";
      scope: SpaceScope;
      actor: Actor;
      connectionId: string;
      /** Re-stamped into the WHERE: a mismatched `connectionId` matches no row. */
      packageId: string;
      authKey: string;
      /** A delegated credential's write: the row must be scoped to `scope.spaceId`, never widened. */
      delegated?: boolean;
      /** Called once the write committed, when it moved the row to org scope. */
      onScopeWidened?: (widened: WidenedConnection) => void;
    }
  | {
      kind: "update-by-id";
      connectionId: string;
      expect: { clientRef: string | null; credentialsEncrypted: string };
    };

/**
 * The credential columns of a write: `credentials` the injectable plane, `inputs` (spec §4.6) the
 * bootstrap secrets injection never reads. An UPDATE writes identity and grant only when provided:
 * the refresh write-back clobbers neither.
 */
interface PersistCredentialInput {
  credentials: Record<string, unknown>;
  /** Bootstrap secrets (login password), stored non-injectable (v2 envelope `inputs`). */
  inputs?: Record<string, unknown>;
  expiresAt?: Date | null;
  needsReconnection?: boolean;
  accountId?: string;
  identityClaims?: Record<string, unknown>;
  scopesGranted?: string[];
  /** Insert-only label seed (a masked secret fingerprint), after identity, before "Connexion N". */
  labelHint?: string;
  /** INSERT only — the `(packageId, authKey)` the new row belongs to. */
  packageId?: string;
  authKey?: string;
  /** The minting client (oauth2 only), on insert and reconnect; the refresh write-back omits it. */
  clientRef?: string | null;
  /** AFPS §7.12, written with the credential they were acquired with; the refresh omits it. */
  variables?: Record<string, string> | null;
  /** RFC 8707 `resource` of the oauth2 token: every acquisition writes it, the refresh leaves it. */
  oauthResource?: string;
}

/** `idx_integration_conn_owner_label`'s key; `spaceId` `null` is org scope. */
export interface ConnectionLabelKey {
  orgId: string;
  spaceId: string | null;
  integrationId: string;
  ownerId: string;
}

function labelLockKey(key: ConnectionLabelKey): string {
  return `ic_label:${key.orgId}:${key.spaceId ?? ""}:${key.integrationId}:${key.ownerId}`;
}

function labelKeyFilter(key: ConnectionLabelKey): SQL {
  const c = integrationConnections;
  return and(
    eq(c.orgId, key.orgId),
    key.spaceId === null ? isNull(c.spaceId) : eq(c.spaceId, key.spaceId),
    eq(c.integrationId, key.integrationId),
    sql`coalesce(${c.userId}, ${c.endUserId}) = ${key.ownerId}`,
  )!;
}

/** Serialise each key's label writes, in {@link labelLockKey} order: no pick between read and write. */
export async function lockLabelKeys(tx: Tx, keys: ConnectionLabelKey[]): Promise<void> {
  for (const lockKey of [...new Set(keys.map(labelLockKey))].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`);
  }
}

async function takenLabels(tx: Tx, key: ConnectionLabelKey): Promise<string[]> {
  const rows = await tx
    .select({ label: integrationConnections.label })
    .from(integrationConnections)
    .where(labelKeyFilter(key));
  return rows.map((row) => row.label);
}

/** Call under {@link lockLabelKeys}. */
async function firstFreeLabel(tx: Tx, key: ConnectionLabelKey, label: string): Promise<string> {
  return dedupeLabel(label, await takenLabels(tx, key), { maxLength: CONNECTION_LABEL_MAX });
}

/** Org scope: a member, not through a delegated credential, minting with no space client. */
function writesOrgScope(
  target: { actor: Actor; delegated?: boolean },
  clientSpace: string | null,
): boolean {
  return target.actor.type === "user" && !target.delegated && clientSpace === null;
}

/** A write naming a space locks it before its client, label keys and rows: a space deletion's order. */
async function lockSpacesForKeyShare(tx: Tx, spaceIds: string[]): Promise<void> {
  if (spaceIds.length === 0) return;
  await tx
    .select({ id: spaces.id })
    .from(spaces)
    .where(inArray(spaces.id, spaceIds))
    .orderBy(asc(spaces.id))
    .for("key share");
}

// The space of `clientRef`'s custom client (`null`: org, system or none), read FOR SHARE: its tier
// cannot change before the connection it mints commits.
async function mintingClientSpace(
  tx: Tx,
  clientRef: string | null | undefined,
): Promise<string | null> {
  // System ids and metadata-document URLs are never UUID-shaped: a non-UUID names no row's tier.
  if (!clientRef || !isUuid(clientRef)) return null;
  const [client] = await tx
    .select({ spaceId: integrationOauthClients.spaceId })
    .from(integrationOauthClients)
    .where(eq(integrationOauthClients.id, clientRef))
    .for("share");
  if (!client) throw notFound(`OAuth client '${clientRef}' not found`);
  return client.spaceId;
}

/** A row {@link widenConnectionsToOrgScope} moved to org scope, for its `scope_widened` audit. */
export interface WidenedConnection {
  id: string;
  label: string;
  previousLabel: string;
  /** The space it served, now its `origin_space_id`. */
  previousSpaceId: string;
}

/** `where` over the unaliased table; shares kept, `origin_space_id` the space left, a taken label ` (n)`. */
export async function widenConnectionsToOrgScope(tx: Tx, where: SQL): Promise<WidenedConnection[]> {
  const c = integrationConnections;
  const widenable = and(where, isNotNull(c.spaceId), isNotNull(c.userId));
  const keyOf = (
    row: { orgId: string; integrationId: string; userId: string | null },
    spaceId: string | null,
  ): ConnectionLabelKey => ({
    orgId: row.orgId,
    spaceId,
    integrationId: row.integrationId,
    ownerId: row.userId!,
  });
  const sources = await tx
    .selectDistinct({
      orgId: c.orgId,
      spaceId: c.spaceId,
      integrationId: c.integrationId,
      userId: c.userId,
    })
    .from(c)
    .where(widenable);
  await lockSpacesForKeyShare(tx, [...new Set(sources.map((source) => source.spaceId!))]);
  await lockLabelKeys(
    tx,
    sources.flatMap((source) => [keyOf(source, source.spaceId), keyOf(source, null)]),
  );
  const rows = await tx
    .select({
      id: c.id,
      orgId: c.orgId,
      spaceId: c.spaceId,
      integrationId: c.integrationId,
      userId: c.userId,
      label: c.label,
    })
    .from(c)
    .where(widenable)
    .orderBy(asc(c.id))
    .for("update");

  const taken = new Map<string, string[]>();
  const widened: WidenedConnection[] = [];
  for (const row of rows) {
    const key = keyOf(row, null);
    let labels = taken.get(labelLockKey(key));
    if (!labels) {
      labels = await takenLabels(tx, key);
      taken.set(labelLockKey(key), labels);
    }
    const label = dedupeLabel(row.label, labels, { maxLength: CONNECTION_LABEL_MAX });
    labels.push(label);
    await tx
      .update(c)
      .set({ spaceId: null, originSpaceId: row.spaceId, label, updatedAt: new Date() })
      .where(eq(c.id, row.id));
    widened.push({ id: row.id, label, previousLabel: row.label, previousSpaceId: row.spaceId! });
  }
  return widened;
}

/** The owner's view of a written row; a delegated write is scoped to its space. */
function writerView(target: { scope: SpaceScope; delegated?: boolean }): ConnectionView["owner"] {
  return { boundSpaceId: target.delegated ? target.scope.spaceId : null };
}

/**
 * The single writer of the credential columns of `integration_connections`: every acquisition and
 * refresh converges here. An explicit `connectionId` updates, none inserts (no upsert by account).
 * `null` only for an `update-by-id` that wrote nothing.
 */
export async function persistCredentialBundle(
  target: PersistTarget,
  input: PersistCredentialInput,
): Promise<IntegrationConnectionSummary | null> {
  const hasInputs = input.inputs && Object.keys(input.inputs).length > 0;
  const ciphertext = encryptCredentialEnvelope({
    outputs: input.credentials,
    ...(hasInputs ? { inputs: input.inputs } : {}),
  });
  const now = new Date();

  if (target.kind === "insert") {
    await assertSpaceInScope(target.scope);
    const { userId, endUserId } = actorInsert(target.actor);
    if (!input.packageId || !input.authKey || input.accountId === undefined) {
      throw new Error("persistCredentialBundle(insert): packageId, authKey, accountId required");
    }
    // Narrowed locals: the guard's narrowing does not reach the transaction closure.
    const insertPackageId = input.packageId;
    const insertAuthKey = input.authKey;
    const insertAccountId = input.accountId;
    // An actor may hold N connections across any mix of auths. Label: identity or `labelHint`
    // (" (n)"-suffixed when taken), else "Connexion N" past the owner's highest N — unique per
    // owner in the scope under the advisory lock.
    const namedLabel = [displayAccountId(input.accountId), input.labelHint]
      .map((raw) => (raw ? toMintedLabel(raw) : ""))
      .find((label) => label.length > 0);
    const row = await db.transaction(async (tx) => {
      await lockSpacesForKeyShare(tx, [target.scope.spaceId]);
      const clientSpace = await mintingClientSpace(tx, input.clientRef);
      const spaceId = writesOrgScope(target, clientSpace) ? null : target.scope.spaceId;
      const key: ConnectionLabelKey = {
        orgId: target.scope.orgId,
        spaceId,
        integrationId: insertPackageId,
        ownerId: target.actor.id,
      };
      await lockLabelKeys(tx, [key]);
      const labelValue: string | SQL = namedLabel
        ? await firstFreeLabel(tx, key, namedLabel)
        : sql<string>`'Connexion ' || (COALESCE((SELECT MAX(substring(${integrationConnections.label} from '^Connexion ([0-9]+)$')::numeric) FROM ${integrationConnections} WHERE ${labelKeyFilter(key)} AND ${integrationConnections.label} ~ '^Connexion [0-9]+$'), 0) + 1)`;
      const inserted = await tx
        .insert(integrationConnections)
        .values({
          integrationId: insertPackageId,
          authKey: insertAuthKey,
          accountId: insertAccountId,
          orgId: target.scope.orgId,
          spaceId,
          originSpaceId: spaceId === null ? target.scope.spaceId : null,
          userId,
          endUserId,
          credentialsEncrypted: ciphertext,
          identityClaims: input.identityClaims ?? {},
          scopesGranted: input.scopesGranted ?? [],
          needsReconnection: input.needsReconnection ?? false,
          clientRef: input.clientRef ?? null,
          variables: input.variables ?? null,
          oauthResource: input.oauthResource ?? null,
          expiresAt: input.expiresAt ?? null,
          label: labelValue,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return inserted[0];
    });
    if (!row) {
      throw new Error("persistCredentialBundle: insert returned no row");
    }
    return serializeIntegrationConnection(row, {
      here: target.scope.spaceId,
      shares: [],
      owner: writerView(target),
    });
  }

  // UPDATE — shared column set; WHERE differs by target.
  const clearsReconnection = !(input.needsReconnection ?? false);
  const set: Partial<typeof integrationConnections.$inferInsert> = {
    credentialsEncrypted: ciphertext,
    expiresAt: input.expiresAt ?? null,
    needsReconnection: input.needsReconnection ?? false,
    // A credential write proves the connection healthy: the escalation count restarts.
    refreshFailureCount: 0,
    updatedAt: now,
  };
  if (input.accountId !== undefined) set.accountId = input.accountId;
  if (input.identityClaims !== undefined) set.identityClaims = input.identityClaims;
  if (input.scopesGranted !== undefined) set.scopesGranted = input.scopesGranted;
  // A reconnect re-stamps the minting client; the refresh write-back omits it.
  if (input.clientRef !== undefined) set.clientRef = input.clientRef;
  if (input.variables !== undefined) set.variables = input.variables;

  if (target.kind === "update-owned") {
    set.oauthResource = input.oauthResource ?? null;
    await assertSpaceInScope(target.scope);
    // The id must also match (packageId, authKey): otherwise a caller-supplied `connectionId`
    // could overwrite another integration's connection it owns. A mismatch matches no row (404).
    const ownerScope = and(
      eq(integrationConnections.id, target.connectionId),
      eq(integrationConnections.integrationId, target.packageId),
      eq(integrationConnections.authKey, target.authKey),
      ownRowInSpace(target.scope.spaceId, target.actor),
    );
    // A reconnect stays on the same upstream account and instance (AFPS §7.12); "default" never
    // blocks. Read and write share one `FOR UPDATE` transaction, so no update slips between.
    const checksAccount =
      input.accountId !== undefined && input.accountId !== PLACEHOLDER_ACCOUNT_ID;
    const checksVariables = input.variables !== undefined && input.variables !== null;
    const row = await db.transaction(async (tx) => {
      // A re-stamped client re-decides the scope: see {@link writesOrgScope}.
      const restamped = input.clientRef !== undefined;
      if (restamped) await lockSpacesForKeyShare(tx, [target.scope.spaceId]);
      const clientSpace = restamped ? await mintingClientSpace(tx, input.clientRef) : null;
      const widens = restamped && writesOrgScope(target, clientSpace);
      if (widens) {
        // The keys a widening leaves and joins, before the row lock.
        const key = {
          orgId: target.scope.orgId,
          integrationId: target.packageId,
          ownerId: target.actor.id,
        };
        await lockLabelKeys(tx, [
          { ...key, spaceId: target.scope.spaceId },
          { ...key, spaceId: null },
        ]);
      }
      const [existing] = await tx
        .select({
          accountId: integrationConnections.accountId,
          variables: integrationConnections.variables,
          spaceId: integrationConnections.spaceId,
        })
        .from(integrationConnections)
        .where(ownerScope)
        .limit(1)
        .for("update");
      if (!existing) return undefined;
      assertDelegatedReconnect(target.delegated, existing.spaceId, target.scope.spaceId);
      if (clientSpace !== null && existing.spaceId !== clientSpace) {
        throw scopeNarrowingRefused("It was widened while this reconnect ran: reconnect it again.");
      }
      if (
        checksAccount &&
        existing.accountId !== PLACEHOLDER_ACCOUNT_ID &&
        existing.accountId !== input.accountId
      ) {
        throw conflict(
          "identity_mismatch",
          `This connection is linked to a different account (${existing.accountId}). Reconnect with the same account, or create a new connection.`,
        );
      }
      if (
        existing.variables &&
        checksVariables &&
        !sameConnectionVariables(connectionVariablesOf(existing.variables), input.variables!)
      ) {
        const instance = Object.entries(existing.variables)
          .map(([name, value]) => `${name}=${value}`)
          .join(", ");
        throw conflict(
          "identity_mismatch",
          `This connection is linked to a different instance (${instance}). Reconnect to the same instance, or create a new connection.`,
        );
      }
      const [widened] =
        widens && existing.spaceId !== null
          ? await widenConnectionsToOrgScope(tx, eq(integrationConnections.id, target.connectionId))
          : [];
      const [updated] = await tx
        .update(integrationConnections)
        .set(set)
        .where(eq(integrationConnections.id, target.connectionId))
        .returning();
      if (!updated) return undefined;
      const shares = (await loadConnectionShares(tx, [updated.id])).get(updated.id) ?? [];
      return { updated, shares, widened };
    });
    if (!row) {
      throw notFound(`Connection '${target.connectionId}' not found or not owned by caller`);
    }
    if (row.widened) target.onScopeWidened?.(row.widened);
    return serializeIntegrationConnection(row.updated, {
      here: target.scope.spaceId,
      shares: row.shares,
      owner: writerView(target),
    });
  }

  // update-by-id (system write-back), a no-op (`null`) on miss. A clearing write is gated on
  // `needs_reconnection = false`, so a `true` set concurrently by
  // `markIntegrationConnectionNeedsReconnection` survives (that row's credentials are stale anyway).
  const { clientRef, credentialsEncrypted } = target.expect;
  const byIdWhere = and(
    eq(integrationConnections.id, target.connectionId),
    clientRef === null
      ? isNull(integrationConnections.clientRef)
      : eq(integrationConnections.clientRef, clientRef),
    eq(integrationConnections.credentialsEncrypted, credentialsEncrypted),
    clearsReconnection ? eq(integrationConnections.needsReconnection, false) : undefined,
  );
  const [row] = await db.update(integrationConnections).set(set).where(byIdWhere).returning();
  return row ? serializeIntegrationConnection(row, { here: null, shares: [], owner: null }) : null;
}

/**
 * One connection's decrypted credential fields (`null`: gone or unreadable). Keyed by id alone: the
 * caller must have established that the actor owns it. `mintedBy` also requires the connection to
 * have been minted through that OAuth client.
 */
export async function getIntegrationConnectionCredentialFields(
  connectionId: string,
  filter: { mintedBy?: string } = {},
): Promise<Record<string, string> | null> {
  const [row] = await db
    .select({ credentialsEncrypted: integrationConnections.credentialsEncrypted })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.id, connectionId),
        filter.mintedBy === undefined
          ? undefined
          : eq(integrationConnections.clientRef, filter.mintedBy),
      ),
    )
    .limit(1);
  if (!row?.credentialsEncrypted) return null;
  const fields = decryptForDisplay(() => decryptCredentialsToStringMap(row.credentialsEncrypted), {
    connectionId,
  });
  return fields === KEY_UNAVAILABLE ? null : fields;
}

/** The only `needs_reconnection = true` write keeping the credentials; no-op once the row is gone. */
export async function markIntegrationConnectionNeedsReconnection(
  connectionId: string,
): Promise<void> {
  await db
    .update(integrationConnections)
    .set({ needsReconnection: true, updatedAt: new Date() })
    .where(eq(integrationConnections.id, connectionId));
}

/** How {@link recordIntegrationRefreshFailure} counts a failure toward `maxFailures`. */
type RefreshFailureGate =
  /** A transient OAuth refresh failure: escalates only once the token expired `graceSeconds` ago. */
  | { graceSeconds: number }
  /** An upstream 401 on an unrefreshable credential, counted only while `reachable` holds. */
  | { reachable: SQL };

/**
 * Record a credential failure (a transient refresh failure, or an upstream rejection of an
 * unrefreshable credential): increment and escalation in one statement, so concurrent failures lose
 * no count; `needsReconnection` is OR'd, never cleared. `null` when no row was counted.
 */
export async function recordIntegrationRefreshFailure(
  connectionId: string,
  maxFailures: number,
  gate: RefreshFailureGate,
): Promise<{ failures: number; needsReconnection: boolean } | null> {
  const failures = sql`${integrationConnections.refreshFailureCount} + 1`;
  const escalates =
    "reachable" in gate
      ? sql`${failures} >= ${maxFailures}`
      : sql`${failures} >= ${maxFailures} AND ${integrationConnections.expiresAt} IS NOT NULL AND ${integrationConnections.expiresAt} < now() - make_interval(secs => ${gate.graceSeconds})`;
  const [row] = await db
    .update(integrationConnections)
    .set({
      refreshFailureCount: failures,
      needsReconnection: sql`${integrationConnections.needsReconnection} OR (${escalates})`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(integrationConnections.id, connectionId),
        "reachable" in gate ? gate.reachable : undefined,
      ),
    )
    .returning({
      failures: integrationConnections.refreshFailureCount,
      needsReconnection: integrationConnections.needsReconnection,
    });
  return row ?? null;
}

/**
 * Count an upstream rejection of an unrefreshable credential toward the max, while `reach` reaches
 * the connection and it still holds `revision`. `null` when nothing was counted.
 */
export async function recordUnrefreshableRejection(
  connectionId: string,
  integrationId: string,
  reach: { spaceId: string; actor: Actor },
  revision: string,
): Promise<{ failures: number; maxFailures: number; needsReconnection: boolean } | null> {
  const maxFailures = getEnv().INTEGRATION_REFRESH_MAX_FAILURES;
  const counted = await recordIntegrationRefreshFailure(connectionId, maxFailures, {
    reachable: and(
      reachableConnection(connectionId, integrationId, reach),
      eq(credentialRevision, revision),
    )!,
  });
  return counted && { ...counted, maxFailures };
}

/**
 * A successful call ends the rejection streak, for a non-OAuth2 connection only (an OAuth2 count
 * tracks refreshes, which a call does not prove). A flagged connection keeps its count.
 */
async function clearRejections(connection: SQL): Promise<void> {
  await db
    .update(integrationConnections)
    .set({ refreshFailureCount: 0 })
    .where(
      and(
        connection,
        gt(integrationConnections.refreshFailureCount, 0),
        isNull(integrationConnections.clientRef),
        eq(integrationConnections.needsReconnection, false),
      ),
    );
}

/** {@link clearRejections} after a 2xx the platform relayed for a caller with `reach`. */
export function clearUpstreamRejections(
  connectionId: string,
  integrationId: string,
  reach: { spaceId: string; actor: Actor },
): Promise<void> {
  return clearRejections(reachableConnection(connectionId, integrationId, reach));
}

/** {@link clearRejections} on a run's report of a 2xx with credential `revision`, while in reach. */
export function clearReachableUpstreamRejections(
  connectionId: string,
  integrationId: string,
  context: { spaceId: string; actor: Actor },
  revision: string,
): Promise<void> {
  return clearRejections(
    and(
      reachableConnection(connectionId, integrationId, context),
      eq(credentialRevision, revision),
    )!,
  );
}

/** The rejection streak a connection carries into a call: its count, for a non-OAuth2 auth only. */
export function upstreamRejectionStreak(connection: {
  clientRef: string | null;
  refreshFailureCount: number;
}): number {
  return connection.clientRef === null ? connection.refreshFailureCount : 0;
}

/** Persist from an acquisition path: unlike the refresh write-back, it always sets identity and grant. */
export async function saveIntegrationConnection(
  scope: SpaceScope,
  input: StoreConnectionInput,
): Promise<IntegrationConnectionSummary> {
  const persistInput: PersistCredentialInput = {
    credentials: input.credentials,
    accountId: input.accountId,
    identityClaims: input.identityClaims ?? {},
    scopesGranted: input.scopesGranted ?? [],
    needsReconnection: false,
    expiresAt: input.expiresAt ?? null,
    ...(input.labelHint ? { labelHint: input.labelHint } : {}),
    ...(input.clientRef !== undefined ? { clientRef: input.clientRef } : {}),
    variables: input.variables ?? null,
    ...(input.oauthResource !== undefined ? { oauthResource: input.oauthResource } : {}),
  };
  const summary = input.connectionId
    ? await persistCredentialBundle(
        {
          kind: "update-owned",
          scope,
          actor: input.actor,
          connectionId: input.connectionId,
          packageId: input.packageId,
          authKey: input.authKey,
          ...(input.delegated ? { delegated: true } : {}),
          ...(input.onScopeWidened ? { onScopeWidened: input.onScopeWidened } : {}),
        },
        persistInput,
      )
    : await persistCredentialBundle(
        {
          kind: "insert",
          scope,
          actor: input.actor,
          ...(input.delegated ? { delegated: true } : {}),
        },
        { ...persistInput, packageId: input.packageId, authKey: input.authKey },
      );
  return summary!;
}

/**
 * The resolver's `usable` set, each row projected for `caller` with the actions it holds and, for
 * its owner, the spaces it may share it into (`orgRole` `null`: none). `locked_by`: what a 409 would
 * refuse — an own row's delete, another's withdrawal from this space.
 */
export async function listIntegrationConnections(
  scope: SpaceScope,
  packageId: string,
  caller: ConnectionCaller,
  orgRole: OrgRole | null,
): Promise<IntegrationConnectionSummary[]> {
  await assertSpaceInScope(scope);
  const actor = caller.principal.actor;
  const rows = await listReachableConnections({ spaceId: scope.spaceId, actor }, "usable", [
    packageId,
  ]);
  const ownerName = await resolveConnectionOwnerNames(rows);
  const own = rows.filter((row) => actorOwns(actor, row)).map((row) => row.id);
  const others = rows.filter((row) => !actorOwns(actor, row)).map((row) => row.id);
  const locks = new Map([
    ...(await connectionLocks(db, own)),
    ...(await connectionLocks(db, others, scope.spaceId)),
  ]);
  const shares = await loadConnectionShares(
    db,
    rows.map((row) => row.id),
  );
  const shareable = await shareableSpaces(
    caller,
    rows,
    new Map(orgRole ? [[scope.orgId, orgRole]] : []),
  );
  return rows.map((row) => {
    const rowShares = shares.get(row.id) ?? [];
    const view = connectionViewOf(caller.principal, row, scope.spaceId, rowShares);
    return {
      ...serializeIntegrationConnection(row, view),
      owner_name: ownerName(row),
      locked_by: locks.get(row.id) ?? null,
      allowed_actions: connectionActions(row, caller, rowShares.includes(scope.spaceId), orgRole),
      ...(view.owner && row.userId !== null
        ? { shareable_spaces: shareable.get(row.id) ?? [] }
        : {}),
    };
  });
}

/** One integration the actor could attach to an agent (own and/or shared into the space). */
interface UsableIntegration {
  integration_package_id: string;
  name: string;
  source: "own" | "shared" | "both";
  /** The integration's own manifest version, so a caller pins a satisfiable range. */
  version?: string;
  /** AFPS §4.4 `default_tools`: what an agent inherits without a `tools` selection. */
  default_tools?: readonly string[] | "*";
}

/**
 * The integrations the actor could attach to an agent here, one per integration with a connection
 * it may bind ({@link usableInSpace}); `source`: own, shared, or both.
 */
export async function listUsableIntegrationsForActor(
  scope: SpaceScope,
  actor: Actor,
): Promise<UsableIntegration[]> {
  await assertSpaceInScope(scope);
  const rows = await db
    .select({
      integrationId: integrationConnections.integrationId,
      userId: integrationConnections.userId,
      endUserId: integrationConnections.endUserId,
      shared: sql<boolean>`${sharedInto(scope.spaceId)}`,
    })
    .from(integrationConnections)
    .where(usableInSpace(scope.spaceId, actor));
  if (rows.length === 0) return [];

  const acc = new Map<string, { own: boolean; shared: boolean }>();
  for (const row of rows) {
    const entry = acc.get(row.integrationId) ?? { own: false, shared: false };
    entry.own ||= actorOwns(actor, row);
    entry.shared ||= row.shared;
    acc.set(row.integrationId, entry);
  }

  // Sorted on purpose: the chat renders this list into its system prompt, one cache block, and an
  // unordered SELECT may permute it between identical calls, invalidating the cached prefix.
  const ids = [...acc.keys()].sort();
  const pkgRows = await db
    .select({ id: packages.id, draftManifest: packages.draftManifest })
    .from(packages)
    .where(inArray(packages.id, ids));
  const nameMap = new Map(pkgRows.map((p) => [p.id, getPackageDisplayName(p)]));
  // The integration's own version, off the selected draft manifest: a caller pinning a
  // `dependencies.integrations` range needs no guess.
  const versionMap = new Map(
    pkgRows.map((p) => {
      const m = p.draftManifest as { version?: unknown } | null;
      return [p.id, typeof m?.version === "string" ? m.version : undefined] as const;
    }),
  );
  // AFPS §4.4 `default_tools`, off the same manifest: what an agent-builder inherits.
  const defaultToolsMap = new Map(
    pkgRows.map((p) => [p.id, readDefaultTools(p.draftManifest as IntegrationManifest)] as const),
  );

  return ids.map((integrationId) => {
    const { own, shared } = acc.get(integrationId)!;
    const source: UsableIntegration["source"] = own && shared ? "both" : own ? "own" : "shared";
    return {
      integration_package_id: integrationId,
      name: nameMap.get(integrationId) ?? integrationId,
      source,
      version: versionMap.get(integrationId),
      default_tools: defaultToolsMap.get(integrationId),
    };
  });
}

type ConnectionLock = NonNullable<IntegrationConnectionSummary["locked_by"]>;

/**
 * Which of `ids` an admin pin or an org default names (the pin wins): each binds whole, so neither
 * may lose a member. A member pin never locks — its owner's next run reports the loss.
 */
export async function connectionLocks(
  executor: DbOrTx,
  ids: readonly string[],
  spaceId?: string,
): Promise<Map<string, ConnectionLock>> {
  const locks = new Map<string, ConnectionLock>();
  if (ids.length === 0) return locks;
  const pins = await executor
    .select({ connectionIds: integrationPins.connectionIds })
    .from(integrationPins)
    .where(
      and(
        isNull(integrationPins.userId),
        spaceId === undefined ? undefined : eq(integrationPins.spaceId, spaceId),
        arrayOverlaps(integrationPins.connectionIds, [...ids]),
      ),
    );
  const orgDefaults = await executor
    .select({ connectionIds: integrationOrgDefaults.connectionIds })
    .from(integrationOrgDefaults)
    .where(
      and(
        spaceId === undefined ? undefined : eq(integrationOrgDefaults.spaceId, spaceId),
        arrayOverlaps(integrationOrgDefaults.connectionIds, [...ids]),
      ),
    );
  const wanted = new Set(ids);
  // Pins last, so they overwrite a default naming the same id.
  for (const row of orgDefaults) {
    for (const id of row.connectionIds) if (wanted.has(id)) locks.set(id, "org_default");
  }
  for (const row of pins) {
    for (const id of row.connectionIds) if (wanted.has(id)) locks.set(id, "admin_pin");
  }
  return locks;
}

/** 409 `connection_pinned` while {@link connectionLocks} locks one of `ids`. */
export async function assertConnectionsUnpinned(
  tx: Tx,
  ids: readonly string[],
  refused: string,
  spaceId?: string,
): Promise<void> {
  const locks = new Set((await connectionLocks(tx, ids, spaceId)).values());
  if (locks.has("admin_pin")) {
    throw conflict(
      "connection_pinned",
      `${refused} while an admin has pinned it to one or more agents. Remove it from the pin(s) first.`,
    );
  }
  if (locks.has("org_default")) {
    throw conflict(
      "connection_pinned",
      `${refused} while an org default names it. Remove it from the default first.`,
    );
  }
}

/** Delete one own row `principal` reaches ({@link forgetDeletedConnection}); `null` when none. */
export async function deleteOwnConnection(
  principal: ConnectionPrincipal,
  connectionId: string,
): Promise<{ orgId: string; disabledScheduleIds: string[] } | null> {
  const { actor } = principal;
  return db.transaction(async (tx) => {
    const schedulesByPin = await schedulesByPinNaming(
      tx,
      [connectionId],
      actor.type === "user" ? [actor.id] : [],
    );
    const [row] = await tx
      .select({
        ...deletedConnectionOwner,
        orgId: integrationConnections.orgId,
        spaceId: integrationConnections.spaceId,
      })
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.id, connectionId),
          actorFilter(principal.actor, integrationConnections),
          meConnectionAuthorityFilter(principal),
        ),
      )
      .for("update");
    if (!row) return null;
    if (principal.kind === "delegated" && principal.spaceId && row.spaceId === null) {
      throw forbidden(
        "A credential bound to a space cannot delete a connection serving the whole organization",
      );
    }
    await assertConnectionsUnpinned(tx, [connectionId], "Connection cannot be deleted");
    await tx.delete(integrationConnections).where(eq(integrationConnections.id, row.id));
    return {
      orgId: row.orgId,
      disabledScheduleIds: await forgetDeletedConnection(tx, row, schedulesByPin),
    };
  });
}

const deletedConnectionOwner = {
  id: integrationConnections.id,
  userId: integrationConnections.userId,
  endUserId: integrationConnections.endUserId,
};

/** A member pin a connection delete may drop, and its schedules to lock in id order. */
interface PinNaming {
  spaceId: string;
  integrationId: string;
  /** Every schedule in its scope, before resolving which ones use its integration. */
  scheduleIds: string[];
}

/** The member pins naming the connections, governance-locked, with the schedules to lock together. */
async function schedulesByPinNaming(
  tx: Tx,
  connectionIds: string[],
  ownerIds: string[],
): Promise<Map<string, PinNaming>> {
  const schedulesByPin = new Map<string, PinNaming>();
  if (connectionIds.length === 0 || ownerIds.length === 0) return schedulesByPin;
  const pins = await tx
    .select({ ...pinForgetColumns, userId: integrationPins.userId })
    .from(integrationPins)
    .where(
      and(
        inArray(integrationPins.userId, ownerIds),
        arrayOverlaps(integrationPins.connectionIds, connectionIds),
      ),
    );
  for (const pin of pins) {
    const { spaceId, integrationId } = pin;
    schedulesByPin.set(pin.id, { spaceId, integrationId, scheduleIds: [] });
  }
  await lockPinsGovernance(tx, schedulesByPin);
  for (const pin of pins) {
    const rows = await tx
      .select({ id: schedules.id })
      .from(schedules)
      .where(
        and(
          eq(schedules.spaceId, pin.spaceId),
          eq(schedules.packageId, pin.agentPackageId),
          eq(schedules.userId, pin.userId!),
        ),
      );
    schedulesByPin.get(pin.id)!.scheduleIds = rows.map((row) => row.id);
  }
  return schedulesByPin;
}

/** The schedules `schedulesByPin` holds, as a lock filter; `undefined` for none. */
function schedulesIn(schedulesByPin: ReadonlyMap<string, PinNaming>): SQL | undefined {
  const ids = [...schedulesByPin.values()].flatMap((pin) => pin.scheduleIds);
  return ids.length > 0 ? inArray(schedules.id, ids) : undefined;
}

/**
 * `lockIntegrationGovernance` for each (space, integration), sorted, before any row lock: an armed
 * schedule write takes it before its row, so taken after, it would deadlock.
 */
async function lockPinsGovernance(
  tx: Tx,
  schedulesByPin: ReadonlyMap<string, PinNaming>,
): Promise<void> {
  const pairs = new Map(
    [...schedulesByPin.values()].map((pin) => [`${pin.spaceId}:${pin.integrationId}`, pin]),
  );
  const sorted = [...pairs.values()].sort(
    (a, b) =>
      compareBinary(a.spaceId, b.spaceId) || compareBinary(a.integrationId, b.integrationId),
  );
  for (const pin of sorted) await lockIntegrationGovernance(tx, pin.spaceId, pin.integrationId);
}

/**
 * Drop a deleted connection from its owner's member pins and schedule overrides, and disable the
 * schedules {@link planConnectionForget} and an emptied pin leave unnamed. Returns those schedules:
 * the caller removes their jobs once committed (importing the scheduler would close a cycle).
 */
async function forgetDeletedConnection(
  tx: Tx,
  row: { id: string; userId: string | null; endUserId: string | null },
  schedulesByPin: ReadonlyMap<string, PinNaming>,
): Promise<string[]> {
  // `integration_connections` holds exactly one owner id.
  const owner = actorFromIds(row.userId, row.endUserId)!;
  const plan = await planConnectionForget(
    tx,
    { id: row.id, owner },
    { lock: true, alsoLock: schedulesIn(schedulesByPin) },
  );
  const unnamed: string[] = [];
  for (const pin of plan.pins) {
    // An emptied set drops the pin: only an explicit write pins to none.
    if (pin.nextConnectionIds.length === 0) {
      const naming = schedulesByPin.get(pin.id);
      // A pin created since the read holds no lock yet: taken after the row locks, a deadlock with
      // a schedule write holding it is detected by Postgres and fails the delete, never a race.
      if (!naming) await lockIntegrationGovernance(tx, pin.spaceId, pin.integrationId);
      await tx.delete(integrationPins).where(eq(integrationPins.id, pin.id));
      const layer = pinLayer(pin, owner.id);
      const judged = await schedulesLayerMayName(layer, tx);
      unnamed.push(...(await disableSchedulesLeftUnnamed(tx, layer, judged, "connection_deleted")));
    } else {
      await tx
        .update(integrationPins)
        .set({ connectionIds: pin.nextConnectionIds, updatedAt: new Date() })
        .where(eq(integrationPins.id, pin.id));
    }
  }
  for (const schedule of plan.schedules) {
    await tx
      .update(schedules)
      .set({
        connectionOverrides: schedule.nextOverrides,
        ...(schedule.disables
          ? { enabled: false, disabledReason: "connection_deleted" as const, nextRunAt: null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schedules.id, schedule.id));
  }
  await disableSchedules(tx, plan.foreignScheduleIds, "connection_deleted");
  return [
    ...plan.schedules.flatMap((s) => (s.disables ? [s.id] : [])),
    ...plan.foreignScheduleIds,
    ...unnamed,
  ];
}

/** One of the owner's member pins naming the connection. */
interface PinForget {
  id: string;
  spaceId: string;
  agentPackageId: string;
  integrationId: string;
  connectionIds: string[];
  /** `connectionIds` without the connection; empty drops the pin. */
  nextConnectionIds: string[];
}

/** One of the owner's schedules whose `connection_overrides` name the connection. */
interface ScheduleForget {
  id: string;
  name: string | null;
  agentPackageId: string;
  /** The integrations whose set names the connection, by id, with that set's size today. */
  entries: { integrationId: string; connectionCount: number }[];
  /** Without the connection: an emptied set drops its integration, an emptied map is `null`. */
  nextOverrides: ConnectionOverrides | null;
  /** Enabled and a set empties: an unattended run must never fall back to another account. */
  disables: boolean;
}

/** What forgetting a connection rewrites: the delete applies it, the delete-impact preview shows it. */
interface ConnectionForgetPlan {
  pins: PinForget[];
  schedules: ScheduleForget[];
  /** Other actors' enabled schedules naming the connection: disabled, their overrides kept. */
  foreignScheduleIds: string[];
}

const pinForgetColumns = {
  id: integrationPins.id,
  spaceId: integrationPins.spaceId,
  agentPackageId: integrationPins.packageId,
  integrationId: integrationPins.integrationId,
  connectionIds: integrationPins.connectionIds,
};

/**
 * The rewrites forgetting connection `id` makes to its `owner`'s member pins and schedule overrides,
 * and the other actors' schedules it disables (their member pins keep the id and fail loudly).
 * `lock` takes the rows `FOR UPDATE`, pins then schedules in id order; `alsoLock` joins schedules to
 * that statement outside the plan; the filters narrow the pins and schedules.
 */
export async function planConnectionForget(
  executor: DbOrTx,
  connection: { id: string; owner: Actor },
  {
    lock = false,
    alsoLock,
    scheduleFilter,
    pinFilter,
  }: { lock?: boolean; alsoLock?: SQL; scheduleFilter?: SQL; pinFilter?: SQL } = {},
): Promise<ConnectionForgetPlan> {
  const { id, owner } = connection;
  const pinQuery = executor
    .select(pinForgetColumns)
    .from(integrationPins)
    .where(
      and(
        eq(integrationPins.userId, owner.id),
        arrayContains(integrationPins.connectionIds, [id]),
        pinFilter,
      ),
    )
    .orderBy(
      asc(integrationPins.packageId),
      asc(integrationPins.integrationId),
      asc(integrationPins.id),
    );
  // Every actor's schedules in one id-ordered statement (`schedules-naming-connection.ts`), split
  // below: the owner's are rewritten, the others' disabled.
  const inPlan = and(scheduleOverridesName(id), scheduleFilter);
  const scheduleQuery = executor
    .select({
      id: schedules.id,
      name: schedules.name,
      agentPackageId: schedules.packageId,
      createdAt: schedules.createdAt,
      userId: schedules.userId,
      endUserId: schedules.endUserId,
      enabled: schedules.enabled,
      connectionOverrides: schedules.connectionOverrides,
      inPlan: sql<boolean>`${inPlan}`,
    })
    .from(schedules)
    .where(or(inPlan, alsoLock))
    .orderBy(asc(schedules.id));
  const pinRows = await (lock ? pinQuery.for("update") : pinQuery);
  const lockedRows = await (lock ? scheduleQuery.for("update") : scheduleQuery);
  const scheduleRows = lockedRows.filter((row) => row.inPlan);
  const ownRows = scheduleRows
    .filter((row) => scheduleActorIs(row, owner))
    .sort(
      (a, b) =>
        compareBinary(a.agentPackageId, b.agentPackageId) ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        compareBinary(a.id, b.id),
    );
  return {
    pins: pinRows.map((pin) => ({
      ...pin,
      nextConnectionIds: pin.connectionIds.filter((c) => c !== id),
    })),
    schedules: ownRows.map((row) => {
      const overrides = row.connectionOverrides ?? {};
      const kept = Object.entries(overrides).flatMap(([integrationId, ids]) => {
        if (!ids.includes(id)) return [[integrationId, ids] as const]; // `[]` (none) included
        const rest = ids.filter((c) => c !== id);
        return rest.length > 0 ? [[integrationId, rest] as const] : [];
      });
      return {
        id: row.id,
        name: row.name,
        agentPackageId: row.agentPackageId,
        entries: Object.entries(overrides)
          .filter(([, ids]) => ids.includes(id))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([integrationId, ids]) => ({ integrationId, connectionCount: ids.length })),
        nextOverrides: kept.length > 0 ? Object.fromEntries(kept) : null,
        disables: row.enabled && kept.length < Object.keys(overrides).length,
      };
    }),
    foreignScheduleIds: scheduleRows
      .filter((row) => isForeignNaming(row, connection))
      .map((row) => row.id),
  };
}

/** Code-unit order: the same on every host, where `localeCompare` follows a locale. */
function compareBinary(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Each connection's shares, in `(connection_id, space_id)` order; an id with none is absent. */
export async function loadConnectionShares(
  executor: DbOrTx,
  ids: readonly string[],
): Promise<Map<string, string[]>> {
  const shares = new Map<string, string[]>();
  if (ids.length === 0) return shares;
  const rows = await executor
    .select({
      connectionId: integrationConnectionShares.connectionId,
      spaceId: integrationConnectionShares.spaceId,
    })
    .from(integrationConnectionShares)
    .where(inArray(integrationConnectionShares.connectionId, [...ids]))
    .orderBy(
      asc(integrationConnectionShares.connectionId),
      asc(integrationConnectionShares.spaceId),
    );
  for (const row of rows) {
    const list = shares.get(row.connectionId);
    if (list) list.push(row.spaceId);
    else shares.set(row.connectionId, [row.spaceId]);
  }
  return shares;
}

/** One reader's view of a row: the request space, the row's shares, and, for its owner, its bound space. */
interface ConnectionView {
  here: string | null;
  shares: readonly string[];
  /** Set for the row's owner only; `boundSpaceId` `null`: a credential bound to no space. */
  owner: { boundSpaceId: string | null } | null;
}

/** `principal`'s {@link ConnectionView} of `row`. */
export function connectionViewOf(
  principal: ConnectionPrincipal,
  row: { userId: string | null; endUserId: string | null },
  here: string | null,
  shares: readonly string[],
): ConnectionView {
  return {
    here,
    shares,
    owner: actorOwns(principal.actor, row) ? { boundSpaceId: boundSpaceOf(principal) } : null,
  };
}

/** Where a row reaches for one reader: `shared_here`; for its owner, its shares and origin. */
export function connectionReach(
  row: Pick<
    typeof integrationConnections.$inferSelect,
    "spaceId" | "originSpaceId" | "shareAllSpaces"
  >,
  view: ConnectionView,
): ConnectionReach {
  const bound = view.owner?.boundSpaceId ?? null;
  const seen = (ids: readonly (string | null)[]) =>
    ids.filter((id): id is string => id !== null && (bound === null || id === bound));
  return {
    scope: row.spaceId === null ? "org" : "space",
    spaceId: row.spaceId,
    shared_here: view.here !== null && view.shares.includes(view.here),
    ...(view.owner
      ? {
          shared_space_ids: seen(view.shares),
          ...(bound === null ? { share_all_spaces: row.shareAllSpaces } : {}),
          origin_space_id: seen([row.originSpaceId])[0] ?? null,
        }
      : {}),
  };
}

/** The one wire serializer of an `integration_connections` row; only the owner sees identity claims. */
export function serializeIntegrationConnection(
  row: typeof integrationConnections.$inferSelect,
  view: ConnectionView,
): IntegrationConnectionSummary {
  if (row.userId && row.endUserId) {
    // DB check constraint rules this out; guard against drift.
    throw new Error("integration_connections row has both userId and endUserId set");
  }
  return {
    id: row.id,
    integration_package_id: row.integrationId,
    auth_key: row.authKey,
    account_id: row.accountId,
    identity_claims: view.owner
      ? ((row.identityClaims as Record<string, unknown> | null) ?? null)
      : null,
    scopes_granted: row.scopesGranted,
    needs_reconnection: row.needsReconnection,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    owner_type: row.userId ? "user" : "end_user",
    owner_id: (row.userId ?? row.endUserId)!,
    label: row.label,
    ...connectionReach(row, view),
    // The minting client (system id or `integration_oauth_clients.id`); null for non-oauth2.
    client_ref: row.clientRef,
    variables: row.variables ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** One connection's variables (AFPS §7.12); keyed by id alone — the caller checked ownership. */
export async function getIntegrationConnectionVariables(
  connectionId: string,
): Promise<Record<string, string> | null> {
  const [row] = await db
    .select({ variables: integrationConnections.variables })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
    .limit(1);
  return row?.variables ?? null;
}

// ─────────────────────────────────────────────
// Aggregate views for the marketplace UI
// ─────────────────────────────────────────────

/** Marketplace detail view: the manifest and the per-auth status for the calling actor. */
export async function getIntegrationAuthStatuses(
  scope: SpaceScope,
  packageId: string,
  caller: ConnectionCaller,
  orgRole: OrgRole | null,
  /** Outside-run proxy reach (`reachOutsideRunIfPermitted`); `null` without either permission. */
  reach: ProxyReach | null,
): Promise<{
  manifest: IntegrationManifest;
  auths: IntegrationAuthStatus[];
  /** The agent-facing tool catalog ({@link resolveIntegrationToolCatalog}). */
  tool_catalog: IntegrationToolCatalogEntry[];
  /** AFPS §4.4: the tools an agent inherits without a `tools` selection; `undefined` when none. */
  default_tools: readonly string[] | "*" | undefined;
  /** AFPS §7.8, verbatim: gates the editor's "include all upstream tools" toggle. */
  allow_undeclared_tools: boolean;
  /** Whether the integration is active in this space (the list endpoint's `active`). */
  active: boolean;
  /** Only org admins may create personal connections here (`false` when not active). */
  block_user_connections: boolean;
  /**
   * The platform's own OAuth callback, from the helper connect uses. Not always the effective
   * redirect: a registered client's `redirect_uri` wins, so a consumer naming the URI to register
   * resolves the default client's first (a mismatch is the most common connect failure).
   */
  platform_redirect_uri: string;
  /** What an unnamed proxy call outside a run gets for this caller ({@link proxyConnectionVerdict}). */
  proxy_connection: { status: ProxyConnectionStatus; imposed: boolean };
}> {
  await assertSpaceInScope(scope);
  const manifest = await loadManifestOrThrow(scope, packageId);
  const authsMap = manifest.auths ?? {};

  // Local source: the referenced mcp-server's tools, best-effort (the resolver falls back).
  const localRef = getLocalServerRef(manifest);
  const mcpServer = localRef ? await fetchMcpServerManifest(localRef.name) : null;
  const mcpServerTools = mcpServer ? readMcpServerTools(mcpServer) : undefined;
  const toolCatalog: IntegrationToolCatalogEntry[] = resolveIntegrationToolCatalog({
    integration: manifest,
    mcpServerTools,
  });

  const allConnections = await listIntegrationConnections(scope, packageId, caller, orgRole);
  // The settings list's precedence: env-backed system integrations stay active.
  const activation = (await resolveIntegrationActivations([packageId], scope.spaceId)).get(
    packageId,
  )!;
  const oauthClients = await db
    .select({
      authKey: integrationOauthClients.authKey,
      autoProvisioned: integrationOauthClients.autoProvisioned,
    })
    .from(integrationOauthClients)
    .where(and(spaceVisibleFilter(scope), eq(integrationOauthClients.integrationId, packageId)));
  // The clients a connect of the auth can use: a classic auth chooses among the manual rows only
  // (`loadClientTiers`), so a leftover auto-provisioned row does not make it connectable.
  const hasUsableOAuthClient = (key: string, autoProvisioned: boolean) =>
    oauthClients.some((r) => r.authKey === key && (autoProvisioned || !r.autoProvisioned));

  const auths: IntegrationAuthStatus[] = Object.entries(authsMap).map(([key, rawAuth]) => {
    // The run-policy `required` flag lives under `_meta["dev.appstrate/auth"]` (absent = false).
    const auth = rawAuth as AfpsManifestAuth;
    const authMeta = (auth._meta?.["dev.appstrate/auth"] ?? undefined) as
      { required?: boolean } | undefined;
    const resource = auth.resource ?? null;
    const keyConnections = allConnections.filter((c) => c.auth_key === key);
    return {
      auth_key: key,
      type: auth.type,
      required: authMeta?.required === true,
      scopes: auth.default_scopes ?? [],
      resource,
      connections: keyConnections,
      // Usable connections, shared ones included (`listIntegrationConnections`): under
      // `block_user_connections` a shared connection is a member's only path to a run.
      // Agent-agnostic: a run's readiness is `validateInlineRun`'s.
      ready: keyConnections.some((c) => !c.needs_reconnection),
      has_oauth_client: hasUsableOAuthClient(key, usesAutoProvisionedClient(manifest, auth)),
      // A shared platform client (SYSTEM_INTEGRATIONS) also serves connect.
      has_system_client: listSystemIntegrationClientsFor(packageId, key).length > 0,
      // Provisioned at connect time (CIMD or DCR): connectable without a registered client.
      client_auto_provisioned: usesAutoProvisionedClient(manifest, auth),
    };
  });

  return {
    manifest,
    auths,
    tool_catalog: toolCatalog,
    default_tools: readDefaultTools(manifest),
    allow_undeclared_tools:
      (manifest as { allow_undeclared_tools?: boolean }).allow_undeclared_tools === true,
    active: activation.active,
    block_user_connections: activation.blockUserConnections,
    platform_redirect_uri: integrationCallbackUrl(),
    proxy_connection: await proxyConnectionVerdict(packageId, manifest, {
      spaceId: scope.spaceId,
      actor: caller.principal.actor,
      reach,
    }),
  };
}

/** The auth every connect flow acts on, with its published manifest ({@link readIntegrationManifestForConnect}). */
export async function readIntegrationAuth(
  scope: SpaceScope,
  packageId: string,
  authKey: string,
): Promise<{
  manifest: IntegrationManifest;
  auth: NonNullable<IntegrationManifest["auths"]>[string];
}> {
  const manifest = await loadManifestOrThrow(scope, packageId);
  return { manifest, auth: lookupAuth(manifest, authKey) };
}

// ─────────────────────────────────────────────
// Type guard for the integration-scoped routes
// ─────────────────────────────────────────────

/**
 * Refuse a package that is not an integration placed here (the catalogue rule, placement included):
 * an id this space cannot reach is the 404 of a missing id, never a type refusal revealing a
 * package homed elsewhere (RBAC spec §3.6).
 */
export async function assertIsIntegration(scope: SpaceScope, packageId: string): Promise<void> {
  const [row] = await db
    .select({ type: packages.type })
    .from(packages)
    .leftJoin(spacePackages, placementRowJoin(packages.id, scope.spaceId))
    .where(
      and(
        eq(packages.id, packageId),
        orgOrSystemFilter(scope.orgId),
        notEphemeralFilter(),
        placementReadFilter(scope.spaceId),
      ),
    )
    .limit(1);
  if (!row) {
    throw notFound(`Package '${packageId}' not found in this organization`);
  }
  if (row.type !== "integration") {
    throw conflict(
      "wrong_package_type",
      `Package '${packageId}' is type '${row.type}', not 'integration'`,
    );
  }
}
