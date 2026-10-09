// SPDX-License-Identifier: Apache-2.0

/**
 * Integration connection layer — the write side of `/api/integrations/*`.
 *
 * Covers:
 *
 *   - Space- and org-level OAuth2 client registration (admin) backing the
 *     "Configure OAuth" admin form. Stored in `integration_oauth_clients`
 *     with the client_secret v1-envelope encrypted (empty string for
 *     public clients).
 *   - Connection writers (`persistCredentialBundle`, `saveIntegrationConnection`)
 *     that store per-(integration, auth, account) rows in
 *     `integration_connections` with v2-envelope encrypted credentials.
 *     The acquisition flows themselves live in `services/connect/*-strategy.ts`.
 *   - Lookup helpers consumed by the UI (per-auth status, scopes granted,
 *     expiry, multi-account list) and by the runtime resolver cascade.
 *
 * The runtime spawn path reads `integration_connections` directly; this
 * module is the write side that populates it.
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
  lt,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  spacePackages,
  packageShares,
  integrationConnections,
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
  resolveOAuthEndpoints,
  discoverProtectedResourceMetadata,
  registerDynamicClient,
  DynamicClientRegistrationError,
  OAUTH_STATE_TTL_SECONDS,
  sameUrlIdentifier,
} from "@appstrate/connect";
import { getEnv } from "@appstrate/env";
import {
  isVariableTemplate,
  renderUrlTemplate,
  variableRefs,
} from "@appstrate/afps-shared/connection-variables";
import { egressGuardedFetch, isBlockedEgressUrl } from "../lib/egress-host-guard.ts";
import {
  resolveSystemClientForAuth,
  getDefaultSystemIntegrationClient,
  listSystemIntegrationClientsFor,
  type SystemIntegrationClientDefinition,
} from "./integration-client-registry.ts";
import { isActiveHere } from "./package-activation.ts";
import { placementReadFilter, placementShareJoin } from "./package-placement.ts";
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
import {
  ApiError,
  notFound,
  conflict,
  invalidRequest,
  forbidden,
  validationFailed,
} from "../lib/errors.ts";
import {
  evaluateJsonPath,
  JsonPathSyntaxError,
  parseJsonPath,
} from "@appstrate/afps-shared/jsonpath";
import type { OrgScope, SpaceScope } from "../lib/scope.ts";
import { actorFromIds, actorInsert, actorFilter, actorOwns } from "../lib/actor.ts";
import {
  meConnectionAuthorityFilter,
  ownRowInSpace,
  usableInSpace,
  type MeConnectionAuthority,
} from "./connection-reach.ts";
import {
  getPackageDisplayName,
  notEphemeralFilter,
  orgOrSystemFilter,
} from "../lib/package-helpers.ts";
import {
  integrationCallbackUrl,
  integrationCallbackUrlFor,
} from "../lib/integration-callback-url.ts";
import { CONNECTION_LABEL_MAX, toMintedLabel } from "../lib/connection-label.ts";
import { dedupeLabel } from "@appstrate/core/dedupe-label";
import { normalizeOAuthErrorCode, oauthDiagnosticSuffix } from "../lib/oauth-error-diagnostic.ts";
import type { Actor, ResolvedOAuthClient } from "@appstrate/connect";
import {
  resolveIntegrationToolCatalog,
  readDefaultTools,
  type ConnectionCandidate,
  type ConnectionOverrides,
  type ConnectionResolutionError,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import type { IntegrationToolCatalogEntry } from "@appstrate/shared-types";
import { isUserUrlReachable, type ConnectionVariables } from "./connect/connection-variables.ts";
import {
  getLocalServerRef,
  getRemoteSource,
  hasPerConnectionAuthServer,
  renderRemoteSource,
  toSupportedTokenEndpointAuthMethod,
} from "./integration-manifest-helpers.ts";
import { fetchMcpServerManifest } from "./integration-service.ts";
import { resolveConnectionOwnerNames } from "./integration-connection-owner-names.ts";
import {
  disableSchedules,
  isForeignNaming,
  scheduleActorIs,
  scheduleOverridesName,
  schedulesNamingAny,
} from "./schedules-naming-connection.ts";
import {
  actorIdentityOf,
  candidateOf,
  resolveConnections,
  toLaunchOverrides,
  translateResolutionError,
} from "./integration-connection-resolver.ts";
import { listOrgDefaultsForResolver } from "./integration-org-defaults-service.ts";
import { requireRunBoundMember } from "../lib/run-bound-connection.ts";
import type { AfpsManifestAuth } from "./integration-manifest-helpers.ts";
import type { IntegrationAuthStatus } from "@appstrate/shared-types";
import { getIntegration, getOrgWideIntegrationManifest } from "./integration-service.ts";
import { assertSpaceInScope } from "./spaces.ts";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type { IntegrationConnection as IntegrationConnectionSummary } from "@appstrate/shared-types";

import type {
  IntegrationConnection as IntegrationConnectionSummary,
  IntegrationOAuthClient,
} from "@appstrate/shared-types";

/**
 * Internal — full record incl. decrypted `clientSecret`. Used by the
 * OAuth initiate handler. Route handlers MUST project to
 * {@link IntegrationOAuthClient} (omit `clientSecret`) before responding.
 */
interface IntegrationOAuthClientWithSecret extends IntegrationOAuthClient {
  /** Row PK — the connection's `client_ref` when this custom client mints it. */
  id: string;
  clientSecret: string;
  /** Whether this custom client is the default for new connections (else system). */
  isDefault: boolean;
  /** `true` for a DCR/CIMD-minted machine client (remote MCP public client). */
  autoProvisioned: boolean;
  /** Server chosen per connection the client is bound to (AFPS §7.3); null = the manifest's. */
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

async function loadManifestOrThrow(
  scope: SpaceScope | OrgScope,
  packageId: string,
): Promise<IntegrationManifest> {
  const manifest = isSpaceOwner(scope)
    ? (await getIntegration(scope, packageId))?.manifest
    : await getOrgWideIntegrationManifest(scope.orgId, packageId);
  if (!manifest) {
    throw notFound(`Integration '${packageId}' not found in this organization`);
  }
  return manifest;
}

// ─────────────────────────────────────────────
// Cross-service helpers (shared with the credentials + spawn resolvers)
// ─────────────────────────────────────────────

/**
 * The shape every credential/spawn resolver needs out of a connection
 * row. `id` is included so the credentials resolver can write back to the
 * row when refreshing tokens.
 */
interface ActorConnectionRow {
  id: string;
  credentialsEncrypted: string;
  expiresAt: Date | null;
  scopesGranted: string[];
  /**
   * Which registered client minted the connection — a flat client id (system
   * env id or custom `integration_oauth_clients.id`) for oauth2; `null` only for
   * non-oauth2 auths (no OAuth client). Threaded into the token-refresh client
   * resolution so refresh uses the SAME credentials that minted the tokens.
   */
  clientRef: string | null;
  refreshFailureCount: number;
  /** Read with `credentialsEncrypted`: the upstream that credential is for. */
  variables: ConnectionVariables;
  oauthResource: string | null;
}

/** Whether two connections name the same upstream: the same variables, the same values. */
function sameConnectionVariables(a: ConnectionVariables, b: ConnectionVariables): boolean {
  const entries = Object.entries(a);
  return entries.length === Object.keys(b).length && entries.every(([k, v]) => b[k] === v);
}

/** Own string values only: the column is jsonb, and a renderer substitutes what it is given. */
function connectionVariablesOf(value: unknown): ConnectionVariables {
  const out: Record<string, string> = {};
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [name, v] of Object.entries(value)) if (typeof v === "string") out[name] = v;
  }
  return Object.freeze(out);
}

/**
 * Spawn-side connection row — carries the `authKey` so the spawn
 * resolver can pick the right `manifest.auths[authKey].delivery`
 * declaration without iterating every declared auth on the integration.
 */
export interface ResolvedConnectionRow extends ActorConnectionRow {
  authKey: string;
  /** {@link credentialRevision} of `credentialsEncrypted`, read in the same statement. */
  credentialRevision: string;
}

/** `account_id` of an identity-less connection ({@link extractIdentity} found no claim). */
const PLACEHOLDER_ACCOUNT_ID = "default";

export function displayAccountId(accountId: string | null | undefined): string | null {
  return accountId && accountId !== PLACEHOLDER_ACCOUNT_ID ? accountId : null;
}

/**
 * IDOR guard on a client-supplied reconnect target: 404 unless it is the actor's own row reaching
 * the space (ownership, not usability: `block_user_connections` never stops a renewal).
 */
export async function assertConnectionBelongsToActor(
  connectionId: string,
  spaceId: string,
  actor: Actor,
): Promise<void> {
  const [owned] = await db
    .select({ id: integrationConnections.id })
    .from(integrationConnections)
    .where(and(eq(integrationConnections.id, connectionId), ownRowInSpace(spaceId, actor)))
    .limit(1);
  if (!owned) throw notFound("Connection not found");
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
 * Load a specific connection row by its id, scoped to the space
 * and protected by the actor's access predicate (own OR shared). Used
 * by the spawn and live-credentials resolvers to load a run-bound connection.
 *
 * SECURITY — `integrationId` is a REQUIRED filter: a connection id is
 * caller-supplied on some paths (`connection_id` on the internal
 * credentials routes), so without the integration binding a caller could pin
 * integration B's connection while requesting integration A and have
 * B's credentials injected under A's manifest + `authorized_uris`
 * allowlist. The id must resolve to a row of the REQUESTED integration
 * or not resolve at all. `expectedAuthKey` narrows further when the
 * caller has pinned a specific auth (AFPS §4.1 `auth_key`); pass `null`
 * when the connection's own authKey is authoritative.
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

  // Defence in depth: re-assert the binding on the loaded row before any
  // caller decrypts it. The WHERE clause above already guarantees this —
  // a mismatch here means the query drifted, so fail closed rather than
  // hand integration B's credentials to integration A's delivery plan.
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

interface ConnectionSelectionContext {
  spaceId: string;
  actor: Actor;
  run?: RunBoundSelection;
}

/**
 * The credential proxy's connection of `packageId`: under a run, a member of its bound set; else
 * the resolver's cascade without pins, `namedConnectionId` as the launch override. Either way the
 * pick passes the resolver's health checks.
 */
export async function selectAccessibleConnection(
  packageId: string,
  manifest: IntegrationManifest,
  namedConnectionId: string | null,
  context: ConnectionSelectionContext,
): Promise<ResolvedConnectionRow | null> {
  let named = namedConnectionId?.toLowerCase() ?? null;
  const identity = actorIdentityOf(context.actor);
  const candidatesOf = (rows: readonly SelectableRow[]) =>
    rows.map((r) => candidateOf(identity, r));
  const { run } = context;
  let bound: readonly { connectionId: string }[] = [];
  if (run) {
    bound = await run.boundSet();
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
  }

  // Under a run the bound set already passed governance at kickoff: no org default re-applies.
  const [rows, orgDefaults] = await Promise.all([
    loadSelectableRows(packageId, context),
    run ? null : listOrgDefaultsForResolver(context.spaceId),
  ]);
  if (run && !named) {
    const ids = new Set(bound.map((m) => m.connectionId));
    throw mustChoose(
      packageId,
      candidatesOf(rows.filter((r) => ids.has(r.id))),
      `Run '${run.id}' bound several connections`,
    );
  }
  const { resolved, errors } = resolveConnections({
    // No agent selection: every declared auth serves, no scope is required. `required`: a proxy
    // call cannot proceed without a connection, so nothing usable is an error (→ null below).
    requirements: [
      {
        integrationId: packageId,
        manifest,
        hasSelectedTools: true,
        agentTools: [],
        agentScopes: [],
        required: true,
      },
    ],
    accessibleConnections: rows,
    pins: [],
    orgDefaults,
    launchOverrides: toLaunchOverrides(named ? { [packageId]: [named] } : null, "run_override"),
    spaceId: context.spaceId,
    ...identity,
  });
  const error = errors[0];
  if (error?.code === "not_connected" || error?.code === "override_connection_unavailable") {
    return null;
  }
  if (error?.code === "must_choose_connection") {
    const candidates = error.candidateConnections ?? [];
    throw mustChoose(packageId, candidates, "No single own connection applies");
  }
  if (error?.code === "override_outranked") {
    throw new ApiError({
      status: 400,
      code: "connection_not_in_org_default",
      title: "Connection Not In The Enforced Org Default",
      detail:
        `Connection '${namedConnectionId}' is not in the enforced org default of ` +
        `'${packageId}' (members: ${orgDefaults?.[packageId]?.connectionIds.join(", ")}), ` +
        `which binds every call in this space.`,
      param: "X-Connection-Id",
    });
  }
  if (error) throw resolutionConflict(error);

  // A named connection binds alone; otherwise an org default may bind several.
  const set = (resolved[packageId] ?? []).map((m) => rows.find((r) => r.id === m.connectionId)!);
  if (set.length === 1) return toResolvedRow(set[0]!);
  throw mustChoose(packageId, candidatesOf(set), "The org default holds several connections");
}

/** The actor's accessible rows (own + shared) of `packageId` in the space, in a stable order. */
function loadSelectableRows(packageId: string, context: { spaceId: string; actor: Actor }) {
  return db
    .select({ ...getTableColumns(integrationConnections), credentialRevision })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.integrationId, packageId),
        usableInSpace(context.spaceId, context.actor),
      ),
    )
    .orderBy(asc(integrationConnections.createdAt), asc(integrationConnections.id));
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

/**
 * Per-space activation state for an integration: the `active` flag plus the admin
 * `block_user_connections` gate. `blockUserConnections` defaults to `false` when
 * no per-space row exists.
 */
interface IntegrationActivation {
  active: boolean;
  blockUserConnections: boolean;
}

/**
 * The integration reading of the activation rule — the entry point every
 * integration call site (spawn resolver, agent readiness, sidecar guards,
 * settings list, agent-editor detail) consults, directly or via the
 * {@link isIntegrationActive} / {@link listActiveIntegrationIds} wrappers
 * below. One SELECT over `space_packages` for the whole set, and the verdict
 * itself comes from {@link isActiveHere} (`services/package-activation.ts`),
 * which states the rule for all four package types:
 *
 *   1. An `space_packages` row EXISTS → its `enabled` flag wins. This is
 *      the explicit, sticky operator decision: an enabled row is
 *      active; a disabled row (`enabled = false`) is inactive and STAYS inactive
 *      across runs (never silently re-enabled).
 *   2. NO row → auto-active iff the integration is a SYSTEM integration (offered
 *      by the deployment via `SYSTEM_INTEGRATIONS`, with or without a shared
 *      OAuth client, via `isSystemIntegration`). System integrations work
 *      out of the box without an explicit activation; everything else stays
 *      inactive until somebody switches it on — the deployment ships far more
 *      integration packages than it offers.
 *
 * Rule 1 is conditioned on PLACEMENT, which is why this reads the catalogue
 * row and the offer as well as `space_packages`: a row with neither a home nor
 * a share behind it is a decision about an integration this space has lost,
 * and honouring it would resolve that integration's credentials for a run the
 * placement rule refuses to show the package to.
 *
 * Deactivating a system integration that has no row materializes one with
 * `enabled = false` (see the enable/disable upsert), which then wins via rule 1
 * — that is what makes the opt-out sticky.
 *
 * Returns a map keyed by package id; every requested id is present (rows absent
 * from the table resolve via the system-integration fallback).
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
      placed: sql<boolean>`${placementReadFilter(spaceId)}`,
    })
    .from(spacePackages)
    .innerJoin(packages, eq(packages.id, spacePackages.packageId))
    .leftJoin(packageShares, placementShareJoin(spacePackages.packageId, spaceId))
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
      // One rule, one implementation: the row wins where the package is
      // placed, the deployment's default decides when there is none. `source`
      // is not read for an integration — `SYSTEM_INTEGRATIONS` is the offer,
      // not the package's provenance — so the catalogue join above serves the
      // placement question alone.
      active: isActiveHere({ id, type: "integration", source: null }, row, row?.placed ?? false),
      // PLACEMENT gates the lock exactly as it gates `active` above, and it
      // must: `isUserConnectionCreationBlocked`
      // (`services/integration-connection-resolver.ts`) is the reader that
      // ENFORCES this flag, and it conjoins the same rule — so an orphan row
      // reported here as `true` would draw a padlock on the Integrations list
      // and the detail page while `POST …/connect` let every member through.
      blockUserConnections: (row?.placed ?? false) && row?.blockUserConnections === true,
    });
  }
  return result;
}

/**
 * `true` when the integration is active in the space — thin wrapper over
 * {@link resolveIntegrationActivations}. Use {@link assertIntegrationActive}
 * when the caller needs a structured 404 instead of a boolean.
 */
export async function isIntegrationActive(packageId: string, spaceId: string): Promise<boolean> {
  const map = await resolveIntegrationActivations([packageId], spaceId);
  return map.get(packageId)!.active;
}

/**
 * Active subset of `packageIds` — thin wrapper over
 * {@link resolveIntegrationActivations}. Used on the run-kickoff hot path
 * (agent readiness) where an agent may declare several integrations.
 */
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
 * Project a stored client row into the internal `…WithSecret` shape, decrypting
 * `client_secret`.
 *
 * A decrypt failure does NOT throw here, and that is deliberate rather than
 * lenient: this projection also feeds the ADMIN client list, and an admin who
 * cannot load the list cannot fix the row the list is complaining about. It
 * degrades to an empty `clientSecret` while still reporting
 * `has_client_secret: true` from the column — the persisted, machine-readable
 * marker that says "this row holds a secret nobody can read".
 *
 * The path that would ACT on that client refuses it: `assertConnectClientUsable`,
 * before the connect redirect — the 503 for a key id missing from the keyring
 * (`secretKeyUnavailable`), else a 403 naming the key and the re-registration.
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
    // Presence comes from the COLUMN, never from what we managed to decrypt. A
    // row whose ciphertext no longer opens (key rotated without re-encrypt,
    // corruption) has a secret we cannot see — which is not the same thing as
    // having none, and reporting it as none would hand the connect flow an
    // empty credential for a confidential client: the exact substitution this
    // column exists to prevent. The column is also the only reading that stays
    // safe for a ciphertext that opens to an EMPTY secret —
    // `encodeClientAuthForStorage` refuses to write one, but a row that
    // predates that refusal reports `true` here and is stopped by
    // `assertConnectClientUsable` instead of going out as public.
    has_client_secret: row.clientSecretEncrypted.length > 0,
    // `null` = the row declares nothing, so the manifest's method applies. That
    // is the ONLY reading; the method is never re-derived from the secret.
    // Inferring `"none"` from an empty decrypt is exactly the inference that
    // put `client_secret=` (present but empty) on the wire.
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

function tierAuthFilter(owner: ClientOwner, packageId: string, authKey: string): SQL {
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

/** oauth2 auths only; a manual client on a DCR/CIMD auth would shadow auto-registration. */
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
      `Integration '${manifest.name}' auth '${authKey}' chooses its authorization server per connection, so its OAuth client is registered automatically with each server (DCR); a manual client, bound to one server, must not be registered.`,
    );
  }
  if (!autoProvisioned && usesAutoProvisionedClient(manifest, auth)) {
    throw invalidRequest(
      `Integration '${manifest.name}' auth '${authKey}' provisions its OAuth client automatically at connect time (DCR/CIMD); a manual client must not be registered. Connect without supplying credentials, or delete the existing client to restore auto-registration.`,
    );
  }
}

/** `owner`'s custom clients for the auth, decrypted, oldest-first; a space also sees its org's. */
async function loadClientTiers(
  owner: ClientOwner,
  packageId: string,
  authKey: string,
): Promise<{ space: IntegrationOAuthClientWithSecret[]; org: IntegrationOAuthClientWithSecret[] }> {
  const rows = await db
    .select()
    .from(integrationOauthClients)
    .where(
      and(
        isSpaceOwner(owner) ? spaceVisibleFilter(owner) : tierFilter(owner),
        eq(integrationOauthClients.integrationId, packageId),
        eq(integrationOauthClients.authKey, authKey),
      ),
    )
    .orderBy(integrationOauthClients.createdAt);
  const clients = rows.map(projectClientWithSecret);
  return {
    space: clients.filter((c) => c.spaceId !== null),
    org: clients.filter((c) => c.spaceId === null),
  };
}

/**
 * The effective default (connect, lists, set-default): flagged space client ?? flagged
 * org client ?? system client ?? first space client ?? first org client.
 */
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

/**
 * The {@link pickDefault} of `owner`'s tier when none of its own clients is flagged
 * (an org owner sees no space tier). Compare by `.id`: own clients come back as copies.
 */
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

/**
 * Load the auto-provisioned (DCR/CIMD) client for `(packageId, authKey, issuer)`, if any (`null`
 * issuer = the manifest's server). `idx_ioc_one_auto` guarantees at most one — the find half of
 * the DCR find-or-create.
 */
async function getAutoProvisionedClient(
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
 * Encode the (auth method, ciphertext) pair a client row will carry, writing
 * both halves together so the row can never claim to be public while holding a
 * secret, or claim a secret-based method while holding none.
 *
 * Three inputs, three meanings — and the distinction between the last two is
 * the point:
 *
 *   - `tokenEndpointAuthMethod: "none"` → PUBLIC. No ciphertext is stored.
 *   - `clientSecret: ""` with NO method declared → REFUSED. An empty secret is
 *     accepted only next to an explicit `"none"`, so the stored row always
 *     records a declaration somebody made rather than one this function
 *     inferred. Every production path now declares it: the admin routes refuse
 *     a missing secret unless `"none"` is sent, and auto-DCR declares `"none"`
 *     itself after reading the authorization server's own
 *     `token_endpoint_auth_method`. The throw is therefore unreachable in
 *     production and exists as a chokepoint for any future direct caller.
 *   - `clientSecret: undefined` (the field was not submitted at all) → PRESERVE.
 *     Returns `null` so the caller leaves the stored pair untouched. Rotation
 *     submits an empty secret input when the admin only meant to change the
 *     redirect URI; without this distinction that keystroke-free edit silently
 *     destroyed the secret AND flipped a confidential client to public.
 *
 * An empty secret next to an explicitly declared secret-based method throws for
 * the same reason. It used to win over the declaration and write
 * `token_endpoint_auth_method = 'none'`: a caller that declared
 * `client_secret_basic` and supplied no secret got a public client and a 201,
 * and the contradiction only surfaced as an HTTP 400 from the provider's token
 * endpoint months later.
 *
 * Note that DELETING these guards rather than throwing would be worse than the
 * inference they replace: falling through to the final return writes a NULL
 * method beside a ciphertext over an EMPTY secret — a row
 * `ioc_public_iff_no_secret` accepts, because the CHECK reads the ciphertext's
 * length and cannot see through it. Nothing reads such a row as a public
 * client, so the only place it surfaces is the provider's token endpoint,
 * long after the `201`. This is the one write path that can still tell the
 * difference; it refuses here rather than deferring the answer.
 */
export function encodeClientAuthForStorage(input: {
  clientSecret?: string | undefined;
  tokenEndpointAuthMethod?: string | undefined;
}): { tokenEndpointAuthMethod: string | null; clientSecretEncrypted: string } | null {
  if (input.clientSecret === undefined) {
    // Declaring a client public is a deliberate act and does not need a secret
    // field; anything else with no secret submitted is a preserve.
    if (input.tokenEndpointAuthMethod === "none") {
      return { tokenEndpointAuthMethod: "none", clientSecretEncrypted: "" };
    }
    return null;
  }
  const secret = input.clientSecret;
  if (input.tokenEndpointAuthMethod === "none") {
    // A non-empty secret alongside an explicit `"none"` is refused by
    // `oauthClientCreateSchema` / `oauthClientUpdateSchema`, and auto-DCR only
    // declares `"none"` once it has confirmed the authorization server
    // registered a public client. Dropping the secret here is therefore not a
    // downgrade of anything a caller asked to keep.
    return { tokenEndpointAuthMethod: "none", clientSecretEncrypted: "" };
  }
  if (secret.length === 0) {
    // Defence in depth for the callers that bypass the route schema — auto-DCR
    // calls `createIntegrationOAuthClient` directly, so "the route already
    // refused this" is not a premise this function may rely on. An empty
    // secret is stored only next to an explicit `"none"`; anything else is a
    // declaration this function would have to invent, and inventing it is what
    // produced a public client from a confidential registration.
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
 * Register a NEW space or org OAuth2 client for an integration auth — one of
 * the N custom (BYO-app) clients (model-provider pattern). Always an INSERT (no
 * upsert): a fresh client id is minted each time so multiple clients coexist.
 *
 * `is_default` is set to `true` only when no client of its tier is already the
 * default (mirrors `org-models` first-credential-wins); the loser of a race on
 * `idx_ioc_one_default` (space) / `idx_ioc_one_org_default` (org) is stored non-default.
 *
 * Creation always supplies `clientSecret` (blank means "register a public
 * client"), so `encodeClientAuthForStorage` never returns the preserve
 * sentinel here. A public client is stored as
 * `token_endpoint_auth_method = 'none'` with an EMPTY `client_secret_encrypted`
 * — no ciphertext at all, so "has a secret" is a column read rather than a
 * decryption. The `ioc_public_iff_no_secret` CHECK enforces that biconditional.
 *
 * `opts.autoProvisioned` marks a DCR/CIMD machine client (internal — the admin
 * route never sets it; a remote-MCP auth keeps exactly one, enforced by
 * `idx_ioc_one_auto`).
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
  const issuer = opts.issuer ?? null;
  assertClientAuth(await loadManifestOrThrow(owner, packageId), authKey, autoProvisioned);

  // An auto-provisioned client of the manifest's server is the default; one per issuer is selected
  // by its issuer (several coexist). A classic client wins the default only when none holds it.
  const isDefault = autoProvisioned
    ? issuer === null
    : !(await hasTierDefault(owner, packageId, authKey));

  // Creation always supplies the field (blank means "register a public
  // client"), so the encoder never returns the preserve sentinel here.
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
    // A concurrent write took the tier's first default: land as non-default.
    if (!isDefault || autoProvisioned || !isUniqueViolation(err)) throw err;
    return insert(false);
  });

  if (!row) {
    throw new Error("createIntegrationOAuthClient: insert returned no row");
  }
  return projectClientWithSecret(row);
}

/**
 * Update an existing custom client in place, by its id; an absent field is unchanged. Scoped to
 * `owner`'s tier and `packageId` (escalation guard) — any other client id is a 404.
 * `is_default` / `auto_provisioned` are not touched here
 * (default selection is `setDefaultIntegrationClient`'s job).
 *
 * An omitted `clientSecret` PRESERVES the stored pair — except when the caller
 * also declares a secret-based `tokenEndpointAuthMethod`, which is a change
 * request rather than a preserve: it is applied against the stored secret, or
 * refused when there is none. See the `methodOnly` block.
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
  const byId = clientByIdFilter(owner, packageId, clientId);
  const [existing] = await db.select().from(integrationOauthClients).where(byId).limit(1);
  if (!existing) {
    throw notFound(`OAuth client '${clientId}' not found`);
  }
  // Auto-provisioned (DCR) clients are machine-managed — refuse manual rotation
  // (it would point the DCR find-or-create at hand-entered credentials).
  if (existing.autoProvisioned) {
    throw invalidRequest(
      `OAuth client '${clientId}' is auto-provisioned (DCR/CIMD) and cannot be edited manually; an org administrator deletes it to re-trigger registration.`,
    );
  }
  // `null` = the secret field was not submitted → keep the stored credential
  // and its declared method exactly as they are. Rotating only the redirect URI
  // must not silently clear the secret (nor flip a confidential client public).
  // A new secret alone keeps the stored secret-based method (not a public client's `"none"`).
  const keptMethod =
    input.clientSecret && existing.tokenEndpointAuthMethod !== "none"
      ? (existing.tokenEndpointAuthMethod ?? undefined)
      : undefined;
  const clientAuth = encodeClientAuthForStorage({
    ...input,
    tokenEndpointAuthMethod: input.tokenEndpointAuthMethod ?? keptMethod,
  });

  // …with one exception, which the preserve sentinel alone gets wrong. An
  // ABSENT secret alongside an EXPLICITLY declared secret-based method is not
  // a preserve: the caller asked for a change. Skipping both columns dropped
  // that declaration and answered 200 — the admin saw success on a row that
  // never moved. (`"none"` never lands here: the encoder returns a value for
  // it, so `clientAuth === null` with a declared method means a secret-based
  // one.) Not reachable from the web form, which sends no method unless it is
  // declaring the client public — but reachable from the API.
  //
  // Honour it when there is a stored secret to attach the method to: choosing
  // between `client_secret_post` and `client_secret_basic` is a change of
  // TRANSPORT for the same credential, and demanding the admin re-type a
  // secret they are not changing is how secrets get pasted from the wrong
  // place. With NO stored secret there is nothing to authenticate with, so the
  // request is refused rather than half-applied — the biconditional CHECK
  // would reject the write anyway, as an opaque 500 instead of this.
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

/** Move a space client to its org tier; same id, so pinned connections keep refreshing. */
export async function promoteIntegrationOAuthClient(
  scope: SpaceScope,
  packageId: string,
  clientId: string,
): Promise<IntegrationOAuthClientWithSecret> {
  await assertSpaceInScope(scope);
  try {
    return await moveClientToOrg(scope, packageId, clientId, true);
  } catch (err) {
    // A concurrent write took the org tier's first default: land as non-default.
    if (!isUniqueViolation(err)) throw err;
    return moveClientToOrg(scope, packageId, clientId, false);
  }
}

function moveClientToOrg(
  scope: SpaceScope,
  packageId: string,
  clientId: string,
  mayDefault: boolean,
): Promise<IntegrationOAuthClientWithSecret> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(integrationOauthClients)
      .where(clientByIdFilter(scope, packageId, clientId))
      .limit(1);
    if (!existing) {
      throw notFound(`OAuth client '${clientId}' not found`);
    }
    if (
      existing.autoProvisioned &&
      (await getAutoProvisionedClient(scope, packageId, existing.authKey, existing.issuer, tx))
    ) {
      throw conflict(
        "auto_client_exists_at_org",
        `OAuth client '${clientId}' is auto-provisioned (DCR/CIMD), and the organization already holds the auto-provisioned client of this auth${existing.issuer ? ` for ${existing.issuer}` : ""}. Reconnect this space's connections to move them onto it, then delete this client.`,
      );
    }
    // An auto client of a server chosen per connection is picked by its issuer, never the default.
    const isDefault =
      mayDefault &&
      !(existing.autoProvisioned && existing.issuer !== null) &&
      !(await hasTierDefault({ orgId: scope.orgId }, packageId, existing.authKey, tx));
    const [row] = await tx
      .update(integrationOauthClients)
      .set({ spaceId: null, isDefault, updatedAt: new Date() })
      .where(eq(integrationOauthClients.id, existing.id))
      .returning();
    await widenConnectionsToOrgScope(tx, eq(integrationConnections.clientRef, existing.id));
    return projectClientWithSecret(row!);
  });
}

/**
 * A connect-time client resolved from a credential source — either an
 * env-provided system client or a custom (space or org) client. The
 * `clientRef` is what gets pinned on the connection so refresh resolves the
 * same credentials.
 */
interface ResolvedConnectClient {
  clientId: string;
  /** Pre-registered redirect URI override, or null to use the platform default. */
  redirectUri: string | null;
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
 * Refuse a stored client whose ciphertext cannot be read — at RESOLUTION time,
 * which is the earliest moment the answer is knowable.
 *
 * Timing is the whole point. The state used to travel all the way through
 * `OAuth2Strategy.begin`: the user was redirected, consented at the provider,
 * came back, and only then did the token exchange fail — with a message about
 * an incoherent pair that named neither the row nor a remedy. And in one case
 * it did not fail at all: a manifest declaring
 * `token_endpoint_auth_method: "none"` made `assertClientAuthCoherent` return
 * early, so a confidential client whose secret could not be read went out on
 * the wire as a PUBLIC one — the silent substitution this column exists to
 * prevent.
 *
 * The state is a property of the row rather than of the caller:
 * `has_client_secret` WITH an empty `clientSecret` means the ciphertext did not
 * open (key rotated without re-encrypt, corruption). Only a failed decrypt can
 * produce that pair — `ioc_public_iff_no_secret` makes "declares a
 * secret-based method while storing none" unrepresentable, so no write path
 * reaches it.
 *
 * The admin client list deliberately keeps rendering the row (see
 * `projectClientWithSecret`): the admin has to see the broken row to fix it.
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

/** Project a custom (space or org) client into the resolved shape. */
function customConnectClient(client: IntegrationOAuthClientWithSecret): ResolvedConnectClient {
  // Before the authorize redirect, never after the user has consented.
  assertConnectClientUsable(client);
  return {
    clientId: client.client_id,
    redirectUri: client.redirect_uri ?? null,
    clientRef: client.id,
  };
}

/**
 * Resolve WHICH OAuth client a connect flow uses, and its credentials — the
 * single home for the client-selection precedence (previously inlined in
 * `OAuth2Strategy.begin`). New connections always use the **default**
 * ({@link pickDefault}) — there is no per-connect picker.
 * Auto-provisioned remote-MCP auths (DCR/CIMD) use the org's machine client
 * and are never served by a system entry. Throws the operator-facing error when
 * no client can be resolved. The returned `clientRef` is pinned on the
 * connection so token refresh resolves the same credentials. The choice of
 * which client is the default is an admin action (`setDefaultIntegrationClient`,
 * the model-provider `setDefaultModel` analogue), not a connect-time argument.
 */
export function resolveConnectClient(
  integrationId: string,
  authKey: string,
  manifest: IntegrationManifest,
  auth: AfpsManifestAuth,
  resolved: ResolvedOAuthConnect,
): ResolvedConnectClient {
  const autoProvisioned = usesAutoProvisionedClient(manifest, auth);
  const system = autoProvisioned ? null : getDefaultSystemIntegrationClient(integrationId, authKey);
  const picked = pickDefault(resolved.spaceClients, resolved.orgClients, system);
  if (picked) {
    return "isDefault" in picked ? customConnectClient(picked) : systemConnectClient(picked);
  }

  if (autoProvisioned) {
    // Auto-provisioning auth (public client on a remote MCP integration): client
    // acquisition failed. `resolved.provisioningFailure` carries the complete
    // reason + remedy, authored by whichever step failed. Render it verbatim.
    const failure = resolved.provisioningFailure;
    const detail = failure?.message ?? "discovery or client registration failed";
    const statusPart = failure?.status ? ` (HTTP ${failure.status})` : "";
    throw forbidden(
      `Could not automatically provision an OAuth client for '${integrationId}' auth '${authKey}'${statusPart}: ${detail}`,
    );
  }
  // Confidential/classic auth: an admin must pre-register a client, or the
  // platform must provide a system client via SYSTEM_INTEGRATIONS.
  throw forbidden(
    `Administrator must register OAuth client credentials for '${integrationId}' auth '${authKey}' before connection`,
  );
}

/**
 * Resolve a pinned `client_ref` (flat client id) to the OAuth client
 * credentials that mint/refresh a connection's tokens. The token-refresh
 * counterpart of `resolveConnectClient` — and the direct analogue of the
 * model-provider `loadInferenceCredentials`: try the system registry by id
 * first, then the `integration_oauth_clients` table by id.
 *
 * SECURITY: the custom lookup is scoped to `(spaceId or its org, integrationId,
 * authKey)` so a custom id belonging to another space/org/integration/auth never
 * resolves — the same re-validation the system branch applies. Returns `null`
 * when the id resolves to neither (since-removed client, remapped system entry,
 * cross-scope id) → the caller skips refresh (surfaces needs_reconnection).
 *
 * Returns the client-authentication method ALONGSIDE the credentials, and the
 * two are coherent for every representable row: `ioc_public_iff_no_secret`
 * makes "public with a ciphertext" and "secret-based method with none"
 * unrepresentable, so a public client comes back as `"none"` with an empty
 * secret and a confidential one as its declared method with a non-empty
 * secret. Callers post what they are given — nothing downstream re-derives the
 * method, which is how `client_secret=` (present but empty) used to reach
 * providers that reject it. An incoherent pair that somehow got past the CHECK
 * is refused downstream by `assertClientAuthCoherent`, never smoothed over.
 *
 * Precedence: the client row's own `token_endpoint_auth_method` (the admin's
 * explicit declaration) wins over `manifestAuthMethod`, which is the
 * manifest's `auths.{key}.token_endpoint_auth_method` and stands in when the
 * row does not declare one; `toSupportedTokenEndpointAuthMethod` narrows it as on the callback.
 *
 * `null` is reserved for "no such client here" (since-removed, remapped,
 * cross-scope) and for an unreadable ciphertext — the caller skips the
 * refresh, which surfaces as `needs_reconnection` at expiry. A ciphertext under
 * a key id the keyring lacks throws the 503 instead.
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
    // The entry's own declaration wins; the manifest stands in when it has
    // none — the same precedence as the custom branch below. Never re-derived
    // from an empty secret: `SYSTEM_INTEGRATIONS` refuses to boot on a client
    // that omits its secret without declaring `"none"`, so emptiness here is
    // always a declaration, never a gap.
    const method = sys.tokenEndpointAuthMethod ?? manifestAuthMethod;
    return resolved(sys.clientId, method === "none" ? "" : (sys.clientSecret ?? ""), method);
  }

  // A custom client id is the row's UUID PK. Anything else — a since-removed
  // system id, a remapped id, garbage — cannot be a custom row, so skip the
  // typed lookup (and avoid a `uuid` cast error on a non-UUID literal).
  if (!isUuid(clientRef)) return null;

  // 2) Custom client of this space or its org, by id AND fully scoped.
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
  // A public client stores no ciphertext, so there is nothing to decrypt. The
  // converse needs no test: `ioc_public_iff_no_secret` (migration 0038, added
  // VALIDATING after backfilling the legacy rows) makes an empty ciphertext
  // with any other declared method unrepresentable, so emptiness here always
  // arrives as `"none"`.
  if (method === "none") {
    return bound(resolved(row.clientId, "", "none"));
  }

  const stored = decryptStoredCredential(
    () => decryptCredentials<{ client_secret?: string }>(row.clientSecretEncrypted),
    { integrationId, authKey, clientRef },
  );
  if (!stored) return null;
  const clientSecret = stored.client_secret ?? "";
  // A ciphertext that opens to an EMPTY secret is not normalised to `"none"`
  // here — that inference is what sent `client_secret=` (present but empty) to
  // providers that reject it. The pair travels on as it was stored, and the
  // refresh path refuses it: `performRefreshTokenExchange` resolves an absent
  // method to `client_secret_basic` before calling `assertClientAuthCoherent`,
  // so a secret-based (or unstated) method with no secret throws
  // `ClientAuthInvariantError` before anything reaches the wire.
  return bound(resolved(row.clientId, clientSecret, method));
}

/**
 * A client available to connect an integration auth — surfaced in the UI so a
 * user can see the shared system client and/or the org's own (BYO) client and
 * which one is the default. Secrets are never included.
 */
interface IntegrationClientDescriptor {
  /** `client_ref` to pass back at connect time. */
  client_ref: string;
  /** The owning tier: `"system"` (env system client), `"org"` (org-level) or `"space"`. */
  source: "system" | "org" | "space";
  /**
   * For `"space"` / `"org"` clients, the OAuth `client_id` the admin registered.
   * For `"system"` clients, a stable opaque FINGERPRINT (truncated
   * SHA-256) — never the real `SYSTEM_INTEGRATIONS` client_id, which is a
   * deployment secret and must not leak to the front. It is display-only; the
   * connect/refresh keyspace is `client_ref`, not this field.
   */
  client_id: string;
  /** True for the client used when no explicit `client_ref` is given at connect. */
  is_default: boolean;
  /** True for a DCR/CIMD machine client — read-only in the UI (no manual edit). */
  auto_provisioned: boolean;
  /** True when the client carries a non-empty secret (confidential client). */
  has_client_secret: boolean;
  /**
   * `token_endpoint_auth_method` declared for this client, or `null` when
   * undeclared (the manifest's value applies). `"none"` = PUBLIC client.
   *
   * The UI's "public client" checkbox reads THIS rather than
   * `!has_client_secret`: the two differ for a confidential client whose
   * secret has simply not been re-entered, and conflating them left the secret
   * field permanently disabled on such a row.
   */
  token_endpoint_auth_method: string | null;
  /** Pre-registered redirect URI override, or null (custom only; system → null). */
  redirect_uri: string | null;
}

/**
 * Stable, non-reversible fingerprint of a system client_id for display. The real
 * `SYSTEM_INTEGRATIONS` client_id is a deployment secret that must not leak to
 * the front; the UI only needs an opaque, stable identifier to render and diff,
 * which a truncated SHA-256 provides. `sys_`-prefixed so it never reads as a
 * real OAuth client_id.
 */
function fingerprintSystemClientId(clientId: string): string {
  const hex = new Bun.CryptoHasher("sha256").update(clientId).digest("hex");
  return `sys_${hex.slice(0, 16)}`;
}

/**
 * List the OAuth clients `owner` may make its default for `(packageId, authKey)`,
 * secrets omitted: its {@link inheritedDefault} (when not its own) then its own
 * clients, oldest-first. `is_default` marks the effective default.
 */
export async function listIntegrationClients(
  owner: ClientOwner,
  packageId: string,
  authKey: string,
): Promise<IntegrationClientDescriptor[]> {
  await assertOwnerInScope(owner, packageId, authKey);
  const { space, org } = await loadClientTiers(owner, packageId, authKey);
  const system = getDefaultSystemIntegrationClient(packageId, authKey);
  const own = isSpaceOwner(owner) ? space : org;
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
      // Never expose the real system client_id (deployment secret) — only an
      // opaque, stable fingerprint for the UI to show/diff.
      client_id: fingerprintSystemClientId(client.clientId),
      is_default: isDefault,
      auto_provisioned: false,
      has_client_secret: client.clientSecret !== undefined,
      // The entry's own declaration, `null` when it defers to the manifest —
      // mirroring the custom row's nullable column below. Same rule as every
      // other consumer: read the declaration, never infer it from the secret.
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
 * Choose the default OAuth client of `owner`'s tier for new connections — the
 * model-provider `setDefaultModel` analogue: an own client is flagged (the others
 * cleared), the tier's {@link inheritedDefault} clears its flags, anything else is
 * rejected, never silently stored. Clear-then-set runs in one transaction so the
 * partial unique never sees two defaults mid-flight.
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

// ─────────────────────────────────────────────
// Auto-DCR (MCP-spec dynamic client registration)
// ─────────────────────────────────────────────

/**
 * The OAuth connect config resolved for the initiate call, plus the client
 * to authenticate as. For dynamic-registration integrations the endpoints +
 * resource are discovered (RFC 9728 → RFC 8414) and threaded back so the
 * initiate call uses them; for classic integrations they stay `undefined` and
 * the caller falls back to the manifest's declared values.
 */
export interface ResolvedOAuthConnect {
  /** The space's custom (BYO-app) clients — none for an auto-provisioned auth. */
  spaceClients: IntegrationOAuthClientWithSecret[];
  /** The org's clients the space inherits — its one machine client for an auto-provisioned auth. */
  orgClients: IntegrationOAuthClientWithSecret[];
  /** Discovered/declared issuer (overrides the manifest when set). */
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  /** RFC 8707 resource indicator (discovered for MCP, else manifest `resource`). */
  resource?: string;
  /**
   * Set when auto-provisioning a client failed and `client` is null. The
   * failing step authors the complete, operator-facing reason — *including the
   * remedy* — so the caller renders it verbatim and never decides what to
   * advise. Adding a failure point (no registration endpoint, blocked endpoint,
   * AS rejection, network failure, future CIMD) is "set the field with its own
   * message"; no new branch and no remedy heuristic in the caller. `status` is
   * the authorization server's HTTP status when the failure came from a
   * response, surfaced alongside the message.
   */
  provisioningFailure?: { message: string; status?: number };
}

/**
 * Whether an auth's OAuth client is provisioned automatically at connect time
 * (the MCP-spec onboarding path) rather than pre-registered. Per the MCP
 * Authorization spec a remote MCP server is an OAuth protected resource whose
 * client is obtained at connect time — discovery (RFC 9728 → RFC 8414) plus
 * client acquisition without manual pre-registration (CIMD when advertised,
 * else RFC 7591 dynamic registration) — so no hand-registered client is needed.
 *
 * Derived from the manifest shape rather than an opt-in flag, but it is NOT
 * enough to be `oauth2` + `source.kind: "remote"`: the auto-provisioned client
 * is a **public client** (`token_endpoint_auth_method: "none"` + PKCE — the
 * MCP-spec norm for both CIMD and DCR). A remote integration that declares a
 * confidential method (`client_secret_*`) is a classic *pre-registered*
 * client that happens to be remote (e.g. the GitHub/Gmail MCP connectors,
 * which ship explicit endpoints + expect an admin-registered secret) — it must
 * keep requiring a manually-registered client. The AS advertising (or not) a
 * `registration_endpoint` / CIMD support is the additional runtime gate.
 */
export function usesAutoProvisionedClient(
  manifest: IntegrationManifest,
  auth: AfpsManifestAuth,
): boolean {
  return (
    auth.type === "oauth2" &&
    auth.token_endpoint_auth_method === "none" &&
    (getRemoteSource(manifest) !== null || hasPerConnectionAuthServer(manifest, auth))
  );
}

/** Discovery and DCR URLs are manifest-, user- (AFPS §8.7) and server-derived: every hop guarded. */
const egressFetch = (opts?: { maxRedirects: number }) =>
  ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    egressGuardedFetch(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      init,
      opts,
    )) as typeof fetch;
const ssrfGuardedFetch = egressFetch();
/** The DCR POST is never redirected (a 3xx bounces the registration). */
const dcrGuardedFetch = egressFetch({ maxRedirects: 0 });

/** Drop a URL that targets a blocked (loopback/RFC1918/link-local/metadata) host. */
function safeUrl(url: string | undefined): string | undefined {
  return url && !isBlockedEgressUrl(url) ? url : undefined;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * AFPS §7.3 *Client binding*: refuse a manifest-declared endpoint that the validated metadata of
 * the auth's authorization server contradicts — its client is presented to that server only.
 */
export function assertEndpointsMatchMetadata(
  packageId: string,
  authKey: string,
  auth: Pick<AfpsManifestAuth, "authorization_endpoint" | "token_endpoint">,
  metadata: { issuer?: string; authorizationEndpoint?: string; tokenEndpoint?: string },
): void {
  if (metadata.issuer === undefined) return;
  const contradicted = (
    [
      ["authorization_endpoint", auth.authorization_endpoint, metadata.authorizationEndpoint],
      ["token_endpoint", auth.token_endpoint, metadata.tokenEndpoint],
    ] as const
  ).find(
    ([, declared, validated]) =>
      declared !== undefined && validated !== undefined && declared !== validated,
  )?.[0];
  if (contradicted) {
    throw invalidRequest(
      `Integration '${packageId}' auth '${authKey}' declares a ${contradicted} that the metadata of its authorization server (${metadata.issuer}) contradicts; its OAuth client is presented only to that server's own endpoints.`,
    );
  }
}

/**
 * Resolve the OAuth connect config for an auth, auto-registering a client via
 * RFC 7591 Dynamic Client Registration for remote MCP integrations when none is
 * pre-registered. This is the MCP-spec onboarding path: an operator installs
 * the connector, the first actor clicks Connect, and Appstrate self-registers
 * — no hand-created OAuth app, no client secret.
 *
 * Discovery chain:
 *   `source.remote.url` → RFC 9728 protected-resource metadata
 *   (`resource` + `authorization_servers`) → RFC 8414 AS metadata
 *   (`authorization_endpoint` / `token_endpoint` / `registration_endpoint`).
 *
 * A server chosen per connection (AFPS §7.3) goes to {@link ensurePerConnectionOAuthClient}.
 * Otherwise best-effort: a discovery/registration failure comes back as `provisioningFailure`.
 * Classic (non-auto) auths early-return with the existing lookup.
 */
export async function ensureIntegrationOAuthClient(
  scope: SpaceScope,
  packageId: string,
  authKey: string,
  manifest: IntegrationManifest,
  auth: AfpsManifestAuth,
  redirectUri: string,
  variables: ConnectionVariables = {},
): Promise<ResolvedOAuthConnect> {
  if (hasPerConnectionAuthServer(manifest, auth)) {
    return ensurePerConnectionOAuthClient(scope, packageId, authKey, manifest, auth, variables);
  }
  // Classic path: not a remote MCP oauth2 auth — load ALL space and org clients (the
  // connect resolver picks the default among the N); endpoints come from the
  // manifest in the caller.
  if (!usesAutoProvisionedClient(manifest, auth)) {
    const { space, org } = await loadClientTiers(scope, packageId, authKey);
    return { spaceClients: space, orgClients: org };
  }

  // Auto-provisioned path: there is exactly one machine client (DCR/CIMD).
  const existing = await getAutoProvisionedClient(scope, packageId, authKey, null);

  // Resolve the AS issuer + RFC 8707 resource. The protected-resource metadata
  // (RFC 9728) is authoritative for the canonical `resource` (the token's
  // audience — a mismatch makes the access token unusable against the MCP
  // server) and advertises the AS issuer. Discover it whenever the integration
  // exposes a remote MCP URL; the manifest is a fallback (the author may pin the
  // issuer, but the discovered resource wins). Best-effort — discovery failure
  // falls back to the manifest values.
  let issuer = auth.issuer;
  let resource = auth.resource;
  const remote = getRemoteSource(manifest);
  if (remote?.url) {
    // SSRF: the well-known + 401-challenge probes (and the server-advertised
    // metadata URL) are guarded per-request by `ssrfGuardedFetch`.
    const md = await discoverProtectedResourceMetadata({
      resourceServerUrl: remote.url,
      fetchImpl: ssrfGuardedFetch,
    });
    if (md) {
      issuer = issuer ?? md.authorizationServers[0];
      resource = md.resource ?? resource;
    }
  }

  // SSRF: the issuer may be server-advertised (from protected-resource
  // metadata), so a hostile MCP server could otherwise steer RFC 8414 discovery
  // at internal infra. `resolveOAuthEndpoints` fetches the well-known on the
  // issuer host, so guarding the issuer host guards those probes; a blocked
  // issuer degrades to "no discovery".
  if (issuer && isBlockedEgressUrl(issuer)) {
    logger.warn("auto-DCR: discovered issuer blocked by SSRF guard", {
      packageId,
      authKey,
      issuer,
    });
    issuer = undefined;
  }

  // AFPS §7.3: the issuer's validated metadata wins; a manifest endpoint stands in only without it.
  const discovered = issuer ? await resolveOAuthEndpoints({ issuer }) : {};
  assertEndpointsMatchMetadata(packageId, authKey, auth, discovered);
  const endpoints = {
    ...discovered,
    authorizationEndpoint: discovered.authorizationEndpoint ?? auth.authorization_endpoint,
    tokenEndpoint: discovered.tokenEndpoint ?? auth.token_endpoint,
  };

  // SSRF: a discovery document is server-controlled and can advertise endpoints
  // on internal hosts. The token endpoint is fetched server-side at exchange,
  // so drop any blocked endpoint before threading it into the connect state.
  const resolved: ResolvedOAuthConnect = {
    spaceClients: [],
    orgClients: existing ? [existing] : [],
    ...(issuer ? { issuer } : {}),
    ...(safeUrl(endpoints.authorizationEndpoint)
      ? { authorizationEndpoint: endpoints.authorizationEndpoint }
      : {}),
    ...(safeUrl(endpoints.tokenEndpoint) ? { tokenEndpoint: endpoints.tokenEndpoint } : {}),
    ...(resource ? { resource } : {}),
  };

  // Client already registered — nothing to mint; just return discovered config.
  if (existing) return resolved;

  return registerAutoProvisionedClient({ orgId: scope.orgId }, packageId, authKey, auth, {
    registrationEndpoint: endpoints.registrationEndpoint,
    grantTypesSupported: endpoints.grantTypesSupported,
    redirectUri,
    issuer: null,
    resolved,
  });
}

/**
 * The OAuth connect config of an auth whose authorization server is chosen per connection (AFPS
 * §7.3). Every URL here is rendered from the user's variables or learned from a response to one,
 * so it is egress-checked, never trusted as author-declared (§8.6, §8.7):
 *
 *   - remote source: RFC 9728 metadata of the rendered URL; the advertised server must equal the
 *     rendered `issuer`, else share the URL's origin — never another provider's server. Its
 *     `resource` is sent (RFC 8707).
 *   - otherwise the rendered `issuer`, no resource.
 *   - endpoints from that server's RFC 8414 metadata only; a public DCR client per issuer with a
 *     redirect URI of its own (`<callback>/<tag>`).
 *
 * A failure the user's choice explains is a 400 on the variable that chose it.
 */
async function ensurePerConnectionOAuthClient(
  scope: SpaceScope,
  packageId: string,
  authKey: string,
  manifest: IntegrationManifest,
  auth: AfpsManifestAuth,
  variables: ConnectionVariables,
): Promise<ResolvedOAuthConnect> {
  if (auth.token_endpoint_auth_method !== "none") {
    throw invalidRequest(
      `Integration '${packageId}' auth '${authKey}' chooses its authorization server per connection, so its OAuth client is registered automatically as a public client (RFC 7591): the auth must declare token_endpoint_auth_method 'none'.`,
    );
  }
  const remoteTemplate = getRemoteSource(manifest)?.url;
  // The template the user's server is chosen by: the remote URL when it is one, else the issuer.
  const chooser = isVariableTemplate(remoteTemplate) ? remoteTemplate : auth.issuer!;
  const refuse = (code: string, message: string): ApiError => {
    const [name] = variableRefs(chooser);
    return validationFailed([
      { field: `variables.${name}`, code, title: "Invalid Connection Variable", message },
    ]);
  };
  // Both render: the caller's `resolveConnectionVariables` refused any value that would not.
  const remote = renderRemoteSource(manifest, variables);
  const declaredIssuer =
    auth.issuer === undefined ? undefined : renderUrlTemplate(auth.issuer, variables)!;

  let candidate: string;
  let resource: string | undefined;
  if (remote) {
    const md = await discoverProtectedResourceMetadata({
      resourceServerUrl: remote.url,
      fetchImpl: ssrfGuardedFetch,
    });
    if (!md) {
      throw refuse(
        "authorization_server_unavailable",
        `the server at ${remote.url} publishes no OAuth protected-resource metadata for it (RFC 9728)`,
      );
    }
    const named = md.authorizationServers.find((advertised) =>
      declaredIssuer === undefined
        ? sameOrigin(advertised, remote.url)
        : sameUrlIdentifier(advertised, declaredIssuer),
    );
    if (named === undefined) {
      throw refuse(
        "authorization_server_mismatch",
        `the server at ${remote.url} names no authorization server ${
          declaredIssuer === undefined
            ? `on ${new URL(remote.url).origin}`
            : `equal to ${declaredIssuer}`
        } (it names ${md.authorizationServers.join(", ")})`,
      );
    }
    candidate = named;
    resource = md.resource;
  } else {
    candidate = declaredIssuer!;
  }

  if (!(await isUserUrlReachable(candidate))) {
    throw refuse(
      "egress_blocked",
      `names the authorization server ${candidate}, which this platform does not reach`,
    );
  }
  const endpoints = await resolveOAuthEndpoints({ issuer: candidate });
  if (!endpoints.issuer || !endpoints.authorizationEndpoint || !endpoints.tokenEndpoint) {
    throw refuse(
      "authorization_server_unavailable",
      `the authorization server ${candidate} publishes no valid metadata (RFC 8414)`,
    );
  }
  for (const url of [
    endpoints.authorizationEndpoint,
    endpoints.tokenEndpoint,
    ...(endpoints.registrationEndpoint ? [endpoints.registrationEndpoint] : []),
  ]) {
    if (!(await isUserUrlReachable(url))) {
      throw refuse(
        "egress_blocked",
        `the authorization server ${candidate} advertises the endpoint ${url}, which this platform does not reach`,
      );
    }
  }

  const issuer = endpoints.issuer;
  const existing = await getAutoProvisionedClient(scope, packageId, authKey, issuer);
  const resolved: ResolvedOAuthConnect = {
    spaceClients: [],
    orgClients: existing ? [existing] : [],
    issuer,
    authorizationEndpoint: endpoints.authorizationEndpoint,
    tokenEndpoint: endpoints.tokenEndpoint,
    ...(resource ? { resource } : {}),
  };
  if (existing) {
    // A reuse renews the client's lease against {@link pruneUnusedPerConnectionClients}.
    await db
      .update(integrationOauthClients)
      .set({ updatedAt: new Date() })
      .where(eq(integrationOauthClients.id, existing.id));
    return resolved;
  }
  await pruneUnusedPerConnectionClients(scope, packageId, authKey);
  return registerAutoProvisionedClient({ orgId: scope.orgId }, packageId, authKey, auth, {
    registrationEndpoint: endpoints.registrationEndpoint,
    grantTypesSupported: endpoints.grantTypesSupported,
    redirectUri: integrationCallbackUrlFor(issuer),
    issuer,
    resolved,
  });
}

/**
 * Delete the org's per-connection-server clients of this auth that minted no connection: whoever
 * opens a connect flow chooses the server. One used within an OAuth state's lifetime may await it.
 */
async function pruneUnusedPerConnectionClients(
  org: OrgScope,
  packageId: string,
  authKey: string,
): Promise<void> {
  await db.delete(integrationOauthClients).where(
    and(
      tierAuthFilter({ orgId: org.orgId }, packageId, authKey),
      eq(integrationOauthClients.autoProvisioned, true),
      isNotNull(integrationOauthClients.issuer),
      lt(integrationOauthClients.updatedAt, new Date(Date.now() - OAUTH_STATE_TTL_SECONDS * 1000)),
      notExists(
        db
          .select({ id: integrationConnections.id })
          .from(integrationConnections)
          .where(eq(integrationConnections.clientRef, sql`${integrationOauthClients.id}::text`)),
      ),
    ),
  );
}

/**
 * Register a public client (RFC 7591) as the auth's auto-provisioned client of `issuer` (`null` =
 * the manifest's server). Every failure comes back as `resolved.provisioningFailure`.
 */
async function registerAutoProvisionedClient(
  org: OrgScope,
  packageId: string,
  authKey: string,
  auth: AfpsManifestAuth,
  input: {
    registrationEndpoint: string | undefined;
    grantTypesSupported: string[] | undefined;
    redirectUri: string;
    issuer: string | null;
    resolved: ResolvedOAuthConnect;
  },
): Promise<ResolvedOAuthConnect> {
  const { registrationEndpoint, redirectUri, issuer, resolved } = input;
  // A server chosen per connection takes no manual client: the remedy is on its side.
  const manualRemedy =
    issuer === null
      ? "register an OAuth client manually for this integration"
      : "a server chosen per connection must support it";

  // No registration endpoint discovered — can't auto-register; let the caller
  // surface the existing "register a client" error.
  if (!registrationEndpoint) {
    logger.warn("auto-DCR: no registration_endpoint discovered", {
      packageId,
      authKey,
      issuer: resolved.issuer,
    });
    return {
      ...resolved,
      provisioningFailure: {
        message:
          issuer === null
            ? "the authorization server did not advertise dynamic client registration; register an OAuth client manually, or retry once the server advertises it"
            : `the authorization server ${issuer} does not advertise dynamic client registration (RFC 7591), which a server chosen per connection requires`,
      },
    };
  }

  // SSRF pre-check — the endpoint is manifest/discovery-derived and we POST to
  // it. This LITERAL check (no DNS) exists to surface the friendly
  // provisioningFailure below for obviously-internal targets; the authoritative
  // guard is the DCR transport itself, `dcrGuardedFetch` (per-hop DNS, no redirect).
  if (isBlockedEgressUrl(registrationEndpoint)) {
    logger.warn("auto-DCR: registration_endpoint blocked by SSRF guard", {
      packageId,
      authKey,
      registrationEndpoint,
    });
    return {
      ...resolved,
      provisioningFailure: {
        message: `the discovered registration endpoint was refused as an unsafe (loopback/internal) target; ${manualRemedy}`,
      },
    };
  }

  // Narrow the concurrency window: re-check in case a parallel Connect just
  // registered a client for the same (org, package, authKey, issuer).
  const racedClient = await getAutoProvisionedClient(org, packageId, authKey, issuer);
  if (racedClient) return { ...resolved, orgClients: [racedClient] };

  const host = (() => {
    try {
      return new URL(getEnv().APP_URL).host;
    } catch {
      return "appstrate";
    }
  })();

  // Limitation: the registered client is persisted once and reused for every
  // subsequent connect. If the authorization server later revokes or expires it
  // (RFC 7591 §3.2 `client_secret_expires_at`, or operator-side deletion),
  // connect/refresh will fail with an `invalid_client` error and an admin must
  // delete the stored client (DELETE /oauth-clients/:clientId) to trigger
  // re-registration. There is no automatic re-registration on `invalid_client`.
  try {
    const dcrAuthMethod = toSupportedTokenEndpointAuthMethod(auth.token_endpoint_auth_method);
    // MCP-spec refresh: register for the `refresh_token` grant only when the AS
    // advertises it (RFC 8414 `grant_types_supported`). Without it the client is
    // registered for authorization_code alone, so the AS never issues a refresh
    // token (Claude Code #7744) and the connection can't self-renew. Conditional,
    // not unconditional: a server that lacks the grant (e.g. ClickUp MCP) may
    // reject a registration that requests it.
    const grantTypes = input.grantTypesSupported?.includes("refresh_token")
      ? ["authorization_code", "refresh_token"]
      : ["authorization_code"];
    const registration = await registerDynamicClient({
      registrationEndpoint,
      redirectUri,
      clientName: `Appstrate (${host})`,
      grantTypes,
      ...(auth.default_scopes && auth.default_scopes.length > 0
        ? { scopes: auth.default_scopes }
        : {}),
      ...(dcrAuthMethod ? { tokenEndpointAuthMethod: dcrAuthMethod } : {}),
      fetchImpl: dcrGuardedFetch,
    });
    // RFC 7591 §3.2.1: the RESPONSE, not the request, states what the server
    // registered — an AS "MAY replace any invalid values with suitable default
    // values" and reports what it settled on. This path only ever ASKS for a
    // public client (`usesAutoProvisionedClient` gates on
    // `token_endpoint_auth_method: "none"`, so `dcrAuthMethod` is provably
    // `"none"`), so an answer declaring a secret-based method — or carrying a
    // `client_secret` at all — is the server registering something the connect
    // flow cannot drive.
    //
    // Refuse it HERE, where the contradiction is first visible and nothing has
    // been stored. Persisted, it satisfies the `ioc_public_iff_no_secret` CHECK
    // (a declared method of NULL next to a real ciphertext) and detonates far
    // away instead: `assertClientAuthCoherent` throws at the OAuth CALLBACK,
    // reading the manifest's `"none"` against a stored secret — after the user
    // has already granted consent at the provider, identically on every retry,
    // on a row no admin can repair through the API (`updateIntegrationOAuthClient`
    // refuses auto-provisioned clients). The upstream registration is abandoned
    // unused, exactly as when this call loses the insert race below.
    const registeredMethod = registration.tokenEndpointAuthMethod;
    const declaresSecretMethod = registeredMethod !== undefined && registeredMethod !== "none";
    if (declaresSecretMethod || registration.clientSecret !== undefined) {
      logger.warn("auto-DCR: authorization server registered a confidential client", {
        packageId,
        authKey,
        registrationEndpoint,
        clientId: registration.clientId,
        tokenEndpointAuthMethod: registeredMethod,
        returnedClientSecret: registration.clientSecret !== undefined,
      });
      // The method comes from the same server-controlled JSON body as an OAuth
      // error code and has the same shape (a short registry token), so it goes
      // through the same shape guard before being named in an operator-facing
      // message — one guard rather than a second regex. A non-token-shaped
      // answer is described by what it produced; the raw value stays on the
      // warn line above.
      const method = normalizeOAuthErrorCode(registeredMethod);
      const did = declaresSecretMethod
        ? `registered a confidential client${method ? ` (token_endpoint_auth_method='${method}')` : ""}`
        : "returned a client_secret";
      return {
        ...resolved,
        provisioningFailure: {
          message:
            `the authorization server ${did} although Appstrate requested a public client ` +
            `(token_endpoint_auth_method='none' + PKCE — the only shape automatic registration drives); ` +
            manualRemedy,
        },
      };
    }
    let client: IntegrationOAuthClientWithSecret;
    try {
      client = await createIntegrationOAuthClient(
        org,
        packageId,
        authKey,
        {
          clientId: registration.clientId,
          // Public client, now DECLARED rather than inferred from emptiness.
          // The guard above proved the AS returned neither a secret nor a
          // secret-based method, so this pair restates the server's own answer;
          // it is not the `?? ""` coercion it replaces, which silently dropped
          // any secret the AS did return and left the method unstated.
          clientSecret: "",
          tokenEndpointAuthMethod: "none",
          redirectUri,
        },
        { autoProvisioned: true, issuer },
      );
    } catch (insertErr) {
      // Concurrent auto-DCR: a parallel Connect for the same (org, package,
      // authKey, issuer) registered its client between our `racedClient` re-check above
      // and this insert. The partial unique `idx_ioc_one_auto` rejects the
      // second auto-provisioned row (Postgres 23505) — catch it and re-select
      // the winner instead of surfacing a 500. Our own upstream registration is
      // abandoned (harmless: an unused DCR client), the connection proceeds on
      // the winning client.
      if (isUniqueViolation(insertErr)) {
        const winner = await getAutoProvisionedClient(org, packageId, authKey, issuer);
        if (winner) {
          logger.info("auto-DCR: lost registration race, reusing concurrently-registered client", {
            packageId,
            authKey,
            clientId: winner.client_id,
          });
          return { ...resolved, orgClients: [winner] };
        }
      }
      throw insertErr;
    }
    logger.info("auto-DCR: registered OAuth client", {
      packageId,
      authKey,
      clientId: registration.clientId,
      ...(issuer ? { issuer } : {}),
    });
    return { ...resolved, orgClients: [client] };
  } catch (err) {
    if (err instanceof DynamicClientRegistrationError) {
      logger.warn("auto-DCR: dynamic client registration failed", {
        packageId,
        authKey,
        registrationEndpoint,
        status: err.status,
        oauthError: err.errorCode,
        err: err.message,
      });
      // Two distinct DCR failures, authored explicitly (not inferred
      // downstream): a server response (HTTP status present) is a deliberate
      // refusal — surface the AS `error_description`, which carries its own
      // remedy (e.g. an allowlist form). Fall back to a generic line rather
      // than `err.message` so the raw (possibly non-JSON) response body is not
      // echoed into the operator-facing 403 — it stays in the warn log above.
      // No status means a network/timeout/malformed-body failure, where a retry
      // is the remedy.
      //
      // On the refusal branch the RFC 6749 §5.2 `error` CODE is appended too,
      // because the description is OPTIONAL in the RFC and plenty of servers
      // send only the code: `{"error":"invalid_redirect_uri"}` used to arrive
      // as the generic sentence plus a bare HTTP status, hiding the one failure
      // an operator fixes in a minute. Rendered through `oauthDiagnosticSuffix`
      // — the same shape-guarded, code-only rendering the OAuth callback path
      // uses, so both paths name the provider's code identically — passing no
      // status of its own, since `resolveConnectClient` already renders
      // `status` as its own `(HTTP n)` part.
      const reachedServer = err.status !== undefined;
      const codeSuffix = oauthDiagnosticSuffix(err.errorCode, undefined);
      return {
        ...resolved,
        provisioningFailure: reachedServer
          ? {
              message: `${
                err.errorDescription ??
                "the authorization server rejected dynamic client registration"
              }${codeSuffix}`,
              status: err.status,
            }
          : {
              // No `codeSuffix` here: with no response there is no body, so the
              // AS named no code — the branch is defined by that absence.
              message:
                "could not reach the authorization server to register a client; retry once it is reachable",
            },
      };
    }
    throw err;
  }
}

/**
 * Delete one custom client by its id, scoped to `owner`'s tier and `packageId`
 * (escalation guard). If it was the default, no auto-promotion — the resolution
 * cascade simply falls to the next tier (or the admin re-picks a default);
 * this matches the model-provider behaviour and keeps the operation predictable.
 */
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
  return db.transaction(async (tx) => {
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
    // Cascade: every connection pinned to this client is now dead — the
    // client_id/secret that minted its tokens is gone, so it can never refresh
    // again (resolveIntegrationClientById → null → needs_reconnection forever).
    // Industry standard mirrors this: deleting an OAuth app at the IdP
    // (GitHub/Google) revokes all tokens it issued. We delete the orphaned
    // connections in the SAME transaction rather than leave un-refreshable
    // zombies. `client_ref` holds this client's UUID PK — globally unique and
    // never collides with a non-UUID system id — so the tier-scoped
    // match is exact. The pg_notify DELETE trigger fires `connection_update`
    // so live UI badges clear without a manual publish.
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
    // Each forget below locks its connection's rows: the owner's member pins naming it, then every
    // schedule naming it. Locked here first for all of them, in the plan's order, so two batches
    // cannot each hold a row the other waits on.
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
        .where(schedulesNamingAny(forgotten))
        .orderBy(asc(schedules.id))
        .for("update");
    }
    const disabledScheduleIds: string[] = [];
    for (const row of deletedConns) {
      disabledScheduleIds.push(...(await forgetDeletedConnection(tx, row)));
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
 * Apply the AFPS `identity_claims` JSONPaths to a token response (or a
 * credentials bag). A path selecting nothing is omitted; an unsupported path
 * fails the connect with `invalid_config`.
 *
 * `accountId` is the declared `account_id` claim, else the source's `email` /
 * `account_email` / `sub`, else `"default"` (single-account).
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
 * AFPS §7.4 — enforce `auth.required_identity_claims`.
 *
 * Per spec §7.4 line 931, `required_identity_claims` enumerates **OIDC
 * source-side claim names** that MUST be present on the resolved identity
 * (e.g. `["sub"]`). The resolved `identityClaims` bag passed in here is keyed
 * by **AFPS internal keys** (the keys of `auth.identity_claims`), because
 * `extractIdentity` walks `identity_claims: { <afps_key>: "<source_path>" }`
 * and writes the extracted value under `<afps_key>`. The two keyspaces differ,
 * so we resolve OIDC → AFPS via reverse-lookup on the mapping before checking
 * the bag.
 *
 * Resolution rules:
 *   1. If `auth.identity_claims` declares a mapping whose value (after
 *      stripping the `$.` JSONPath prefix) equals the required OIDC claim
 *      name, the claim is satisfied iff the bag carries a non-empty value
 *      under any AFPS key that maps to it. Multiple AFPS keys MAY reference
 *      the same OIDC claim — any one of them satisfying is enough.
 *   2. If no mapping references the required OIDC claim (or
 *      `identity_claims` is undefined entirely — typically a login strategy
 *      promoting engine-output names directly), fall back to a direct lookup
 *      on the bag by the OIDC claim name. This preserves the legacy
 *      semantics for strategies whose claim bag is already keyed by the
 *      source-side name (login engine `identity_outputs` are merged into
 *      the bag verbatim — see `login-strategy.ts`).
 *
 * Throws `invalidRequest` listing every missing claim in a single error so
 * the connect UX surfaces the full gap (not just the first one).
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
  // Build a reverse index OIDC-claim-name → AFPS keys that reference it.
  // Only a single-member path (`"$.sub"`) names an OIDC claim.
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
      // Mapped: any AFPS key referencing this OIDC claim being non-empty
      // satisfies the requirement (multi-mapping → first-non-empty wins).
      if (afpsKeys.some((k) => isPresent(identityClaims[k]))) continue;
      missing.push(oidcClaim);
      continue;
    }
    // Unmapped: fall back to a direct hit on the bag. Covers (a) strategies
    // that promote source-keyed claims into the bag (login engine), and (b)
    // manifests that omit `identity_claims` entirely yet still require a
    // standard claim be present.
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
  /**
   * When provided, UPDATE this specific row (reconnect / upgrade-scopes
   * paths). Owner predicate is still applied as defence in depth — a
   * stale id from another actor can never land on someone else's row.
   * When omitted, always INSERT a new row — the user explicitly asked
   * for a new connection and we let them own duplicates if they want.
   */
  connectionId?: string;
  /**
   * Optional display-name seed used ONLY on INSERT when no upstream identity
   * was extracted (e.g. a masked API-key fingerprint from FieldsStrategy).
   * Identity still wins; ignored on reconnect (label is never re-derived).
   */
  labelHint?: string;
  /**
   * Which registered client minted this connection — a flat client id (system
   * env id or custom `integration_oauth_clients.id`). Pinned on the row so token
   * refresh resolves the same credentials. Set by OAuth2Strategy on every oauth2
   * connect; absent for non-oauth2 auths (persists NULL — no OAuth client).
   */
  clientRef?: string | null;
  /** See {@link PersistCredentialInput}. */
  variables?: Record<string, string> | null;
  oauthResource?: string;
}

/**
 * Where a {@link persistCredentialBundle} write lands. Matches the three
 * converged write sites:
 *
 *   - `insert`       — first acquisition (OAuth2 callback / fields submit).
 *   - `update-owned` — user-initiated reconnect / scope upgrade. Owner-scoped
 *                      WHERE (id + the actor's own row reaching the space + the
 *                      (packageId, authKey) the credentials belong to); throws
 *                      `notFound` when the row isn't the caller's OR belongs to
 *                      a different integration/auth (a caller-supplied id can
 *                      never overwrite an unrelated connection of theirs).
 *   - `update-by-id` — system write-back (token refresh). Keyed by id — the id
 *                      came from an already-authorized resolution — and a
 *                      compare-and-set on `expect`, the client and ciphertext
 *                      the refresh spent: it writes nothing when the row is
 *                      gone or was reconnected meanwhile.
 */
export type PersistTarget =
  | { kind: "insert"; scope: SpaceScope; actor: Actor }
  | {
      kind: "update-owned";
      scope: SpaceScope;
      actor: Actor;
      connectionId: string;
      /** The (packageId, authKey) the credentials belong to — re-stamped into
       * the WHERE so a mismatched `connectionId` matches zero rows. */
      packageId: string;
      authKey: string;
    }
  | {
      kind: "update-by-id";
      connectionId: string;
      expect: { clientRef: string | null; credentialsEncrypted: string };
    };

/**
 * Persist input for the credential columns.
 *
 * `credentials` is the injectable **outputs** plane. `inputs` (spec §4.6) is
 * the bootstrap-secret plane, persisted ONLY when an OrchestratedStrategy
 * declares `persistLoginSecret`. The writer always emits the structured v2
 * envelope `{ v:2, outputs, inputs? }`; the injection path can never read
 * `inputs` (it only ever projects `outputs`).
 *
 * UPDATE column semantics (preserving today's behaviour exactly):
 *   - `credentials`, `expiresAt`, `needsReconnection` are ALWAYS written.
 *   - `accountId`, `identityClaims`, `scopesGranted` are written ONLY when
 *     provided (`undefined` = leave untouched). The refresh write-back relies
 *     on this: it must not clobber the identity, nor — when the IdP omits
 *     `scope` — the stored grant.
 */
interface PersistCredentialInput {
  credentials: Record<string, unknown>;
  /**
   * Bootstrap secrets (login password) — persisted NON-injectable (v2). JSON-typed
   * per JSON Schema 2020-12 §7.5 (string/number/boolean/object/array).
   */
  inputs?: Record<string, unknown>;
  expiresAt?: Date | null;
  needsReconnection?: boolean;
  accountId?: string;
  identityClaims?: Record<string, unknown>;
  scopesGranted?: string[];
  /**
   * INSERT-only label seed (masked secret fingerprint). Used after identity
   * but before the "Connexion N" counter. Never applied on UPDATE paths.
   */
  labelHint?: string;
  /** INSERT only — the `(packageId, authKey)` the new row belongs to. */
  packageId?: string;
  authKey?: string;
  /**
   * Which registered client minted this connection — a flat client id (oauth2
   * only). Stamped on INSERT and on the acquisition UPDATE (reconnect may switch
   * clients) so token refresh resolves the same credentials. Omitted by the
   * refresh write-back (`update-by-id`) → never clobbered on refresh. Absent for
   * non-oauth2 writes → persists NULL.
   */
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

/**
 * Serialise the label writes (insert, rename, widening) of each key, in {@link labelLockKey} order,
 * so a pick cannot be taken between its read and its write.
 */
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

/**
 * The space of the custom client `clientRef` names — `null` for an org client, a system client or
 * none. Read `FOR SHARE`: the client cannot change tier before the connection it mints commits.
 */
async function mintingClientSpace(
  tx: Tx,
  clientRef: string | null | undefined,
): Promise<string | null> {
  // System ids are never UUID-shaped (the registry refuses them): a non-UUID names the system tier.
  if (!clientRef || !isUuid(clientRef)) return null;
  const [client] = await tx
    .select({ spaceId: integrationOauthClients.spaceId })
    .from(integrationOauthClients)
    .where(eq(integrationOauthClients.id, clientRef))
    .for("share");
  if (!client) throw notFound(`OAuth client '${clientRef}' not found`);
  return client.spaceId;
}

/**
 * Widen the user-owned, space-scoped rows matching `where` (over the unaliased table) to org
 * scope: `space_id` NULL, `origin_space_id` the space they leave, shares kept. A label the owner
 * already holds at org scope takes its first free ` (n)` form.
 */
export async function widenConnectionsToOrgScope(
  tx: Tx,
  where: SQL,
): Promise<{ id: string; label: string; previousLabel: string }[]> {
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
  const widened: { id: string; label: string; previousLabel: string }[] = [];
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
    widened.push({ id: row.id, label, previousLabel: row.label });
  }
  return widened;
}

/**
 * The single low-level writer of the credential columns
 * (`credentials_encrypted`, `expires_at`, `scopes_granted`, `identity_claims`,
 * `needs_reconnection`) on `integration_connections`. Every acquisition and
 * refresh path converges here (spec §4.1 — "1 writer"). Returns the persisted
 * summary; `null` only for an `update-by-id` that wrote nothing.
 *
 * Why no upsert-by-accountId: the previous model collapsed every connection on
 * the same `(packageId, authKey, accountId, space, owner)` tuple and silently
 * overwrote rows when `accountId` defaulted to "default". The current model
 * trusts the caller's intent — explicit connectionId = update; no id = insert.
 *
 * Callers that pass explicit `connectionId` for UPDATE: token refresh paths,
 * dashboard renew CTAs (agent-page MemberConnectionPicker per-row Renew,
 * integration-detail ConnectionRow reconnect), and the run-kickoff
 * MissingConnectionsModal reconnect button. The latter two consume the
 * `connection_id` field smuggled on `needs_reconnection` / `insufficient_scopes`
 * ProblemDetails by `integration-connection-resolver.ts:translateResolutionError`
 * and forward it through the OAuth state record so the callback lands here on
 * the `update-owned` path.
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
    // Capture the narrowed (non-undefined) values in locals: TypeScript does
    // not carry the guard's narrowing into the transaction closure below, so
    // `input.packageId` etc. would widen back to `string | undefined` there.
    const insertPackageId = input.packageId;
    const insertAuthKey = input.authKey;
    const insertAccountId = input.accountId;
    // No mono-auth-per-actor gate: an actor may hold N connections across any
    // mix of declared auths (OAuth + PAT + custom).
    //
    // Label: identity or `labelHint` (" (n)"-suffixed when taken), else "Connexion N" past the
    // owner's highest N — unique per owner in the scope under the advisory lock.
    const namedLabel = [displayAccountId(input.accountId), input.labelHint]
      .map((raw) => (raw ? toMintedLabel(raw) : ""))
      .find((label) => label.length > 0);
    const row = await db.transaction(async (tx) => {
      // The scope is the minting client's tier; an end user's connection serves its space only.
      const clientSpace = await mintingClientSpace(tx, input.clientRef);
      const spaceId =
        target.actor.type === "end_user" || clientSpace !== null ? target.scope.spaceId : null;
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
    return serializeIntegrationConnection(row, { owner: true, within: target.scope.spaceId });
  }

  // UPDATE — shared column set; WHERE differs by target.
  const clearsReconnection = !(input.needsReconnection ?? false);
  const set: Partial<typeof integrationConnections.$inferInsert> = {
    credentialsEncrypted: ciphertext,
    expiresAt: input.expiresAt ?? null,
    needsReconnection: input.needsReconnection ?? false,
    // Any successful credential write clears the failure count — a working
    // refresh (or a user reconnect) proves the connection is healthy
    // again, so the escalation counter must not carry over. See
    // `recordIntegrationRefreshFailure`.
    refreshFailureCount: 0,
    updatedAt: now,
  };
  if (input.accountId !== undefined) set.accountId = input.accountId;
  if (input.identityClaims !== undefined) set.identityClaims = input.identityClaims;
  if (input.scopesGranted !== undefined) set.scopesGranted = input.scopesGranted;
  // Re-stamp the minting client on reconnect (acquisition UPDATE passes it);
  // the refresh write-back omits it so the high-water client_ref is preserved.
  if (input.clientRef !== undefined) set.clientRef = input.clientRef;
  if (input.variables !== undefined) set.variables = input.variables;

  if (target.kind === "update-owned") {
    set.oauthResource = input.oauthResource ?? null;
    await assertSpaceInScope(target.scope);
    // Owner-scoped reconnect: id + the actor's own row reaching the space, PLUS the
    // (packageId, authKey) the new credentials belong to. Without the latter
    // two, a caller-supplied `connectionId` could overwrite ANY connection they
    // own — including one for a different integration — with this integration's
    // credentials. Re-stamping them in the WHERE makes a mismatched id match
    // zero rows → the caller gets `notFound`, never a cross-integration clobber.
    const ownerScope = and(
      eq(integrationConnections.id, target.connectionId),
      eq(integrationConnections.integrationId, target.packageId),
      eq(integrationConnections.authKey, target.authKey),
      ownRowInSpace(target.scope.spaceId, target.actor),
    );
    // Identity guard: a reconnect / scope-upgrade must stay on the SAME
    // upstream account. If the re-consent authenticated a different identity
    // (e.g. the user picked another Google account on the consent screen),
    // refuse — silently rebinding a connection (possibly shared or pinned to
    // agents under the assumption it's account A) to a different account is a
    // data-integrity and access surprise. Only enforced between two real
    // identities; "default" (identity-less) never blocks an upgrade.
    //
    // The variables (AFPS §7.12) name the instance the account lives on: same rule.
    //
    // The read (identity check) and the write must be atomic: performed as two
    // separate statements, a concurrent update could change `accountId` between
    // them and slip a different-account clobber past the guard. Do both in one
    // transaction and take a row lock (`FOR UPDATE`) on the SELECT so the row
    // is pinned for the duration.
    const checksAccount =
      input.accountId !== undefined && input.accountId !== PLACEHOLDER_ACCOUNT_ID;
    const checksVariables = input.variables !== undefined && input.variables !== null;
    const row = await db.transaction(async (tx) => {
      // A re-stamped client re-decides the scope: any but a space client widens a member's row.
      const restamped = input.clientRef !== undefined;
      const clientSpace = restamped ? await mintingClientSpace(tx, input.clientRef) : null;
      const widens = restamped && clientSpace === null && target.actor.type === "user";
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
      if (clientSpace !== null && existing.spaceId !== clientSpace) {
        throw conflict(
          "connection_scope_narrowing",
          "This connection serves the whole organization, and the OAuth client that would reconnect it belongs to one space only. Reconnect it from a space without its own OAuth client, or create a new connection here.",
        );
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
      if (widens && existing.spaceId !== null) {
        await widenConnectionsToOrgScope(tx, eq(integrationConnections.id, target.connectionId));
      }
      const updated = await tx
        .update(integrationConnections)
        .set(set)
        .where(eq(integrationConnections.id, target.connectionId))
        .returning();
      return updated[0];
    });
    if (!row) {
      throw notFound(`Connection '${target.connectionId}' not found or not owned by caller`);
    }
    return serializeIntegrationConnection(row, { owner: true, within: target.scope.spaceId });
  }

  // update-by-id (system write-back) — keyed by id, a no-op (`null`) on miss.
  // Monotonic clear: the proactive refresh write-back always passes
  // `needsReconnection: false`, which would race-clobber a `true` set
  // concurrently by `markIntegrationConnectionNeedsReconnection` (revoked grant,
  // missing refresh token, unreadable credential). When this write CLEARS the flag, gate the row on
  // `needs_reconnection = false` so a concurrently-set `true` is preserved — the
  // refresh simply no-ops on that row (a flagged connection's cached credentials
  // are stale anyway, so skipping the write-back is harmless). An explicit
  // `true` write (or any non-clearing write) stays unconditional.
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
  return row ? serializeIntegrationConnection(row, { owner: true, within: null }) : null;
}

/**
 * Read and decrypt the stored credential fields for one connection by id.
 * Returns `null` when the row is gone or its blob cannot be read (logged): every
 * caller only enriches a reconnect or a deletion with them.
 *
 * Keyed by id alone — it carries NO ownership, org or space predicate, so it
 * hands back plaintext for any connection in the deployment. Every caller must
 * therefore have established that the actor owns this connection BEFORE
 * calling it.
 */
export async function getIntegrationConnectionCredentialFields(
  connectionId: string,
): Promise<Record<string, string> | null> {
  const [row] = await db
    .select({ credentialsEncrypted: integrationConnections.credentialsEncrypted })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
    .limit(1);
  if (!row?.credentialsEncrypted) return null;
  const fields = decryptForDisplay(() => decryptCredentialsToStringMap(row.credentialsEncrypted), {
    connectionId,
  });
  return fields === KEY_UNAVAILABLE ? null : fields;
}

/**
 * The single writer of `needs_reconnection = true` that does NOT touch the stored credentials
 * (a refresh path, an unreadable credential). Keyed by id; a no-op once the row is gone.
 */
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
 * Record a failure on a connection's credential: a transient OAuth refresh
 * failure (`invalid_grant` goes through
 * {@link markIntegrationConnectionNeedsReconnection}) or an upstream rejection
 * of an unrefreshable credential. Increment and escalation are one statement,
 * so concurrent failures cannot lose a count; `needsReconnection` is OR'd,
 * never cleared, and a credential write resets the count. `null` when no row
 * was counted (gone, or outside `reachable`).
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
 * Count an upstream rejection of a credential nothing can refresh toward
 * `INTEGRATION_REFRESH_MAX_FAILURES`, while `reach` still reaches the connection and it still holds
 * the rejected credential `revision`. `null` when nothing was counted.
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
 * A successful upstream call ends the rejection streak of the connection `connection` selects.
 * Only a non-OAuth2 connection (`client_ref IS NULL`): an OAuth2 count tracks refreshes, which a
 * call does not prove. A flagged connection keeps its count.
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

/**
 * {@link clearRejections} on a run's report of a 2xx with credential `revision`, while the run's
 * actor can still reach the connection ({@link loadAccessibleConnectionById}'s reach).
 */
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

/**
 * Persist a new connection (INSERT) or refresh an existing one (UPDATE —
 * caller passes `connectionId`) from the user-facing acquisition paths.
 * Thin adapter over {@link persistCredentialBundle}: it passes explicit
 * `?? {}` / `?? []` defaults so the acquisition write always sets
 * `identityClaims`/`scopesGranted` (matching the pre-convergence behaviour),
 * unlike the refresh write-back which leaves them untouched.
 */
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
        },
        persistInput,
      )
    : await persistCredentialBundle(
        { kind: "insert", scope, actor: input.actor },
        { ...persistInput, packageId: input.packageId, authKey: input.authKey },
      );
  // INSERT and update-owned always return a summary (or throw).
  return summary!;
}

/**
 * List the connections the actor can *use* for an integration in this space
 * ({@link usableInSpace}) — the set the runtime resolver picks from. Projected for
 * this space unless the actor owns the row and reads with `wholeReach` (their own
 * session). `locked_by` is what a 409 would refuse: for an own row its delete (a
 * lock in any space), for another's its withdrawal from this space.
 */
export async function listIntegrationConnections(
  scope: SpaceScope,
  packageId: string,
  actor: Actor,
  wholeReach = false,
): Promise<IntegrationConnectionSummary[]> {
  await assertSpaceInScope(scope);
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(
      and(eq(integrationConnections.integrationId, packageId), usableInSpace(scope.spaceId, actor)),
    );
  const ownerName = await resolveConnectionOwnerNames(rows);
  const own = rows.filter((row) => actorOwns(actor, row)).map((row) => row.id);
  const others = rows.filter((row) => !actorOwns(actor, row)).map((row) => row.id);
  const locks = new Map([
    ...(await connectionLocks(db, own)),
    ...(await connectionLocks(db, others, scope.spaceId)),
  ]);
  return rows.map((row) => {
    const owner = actorOwns(actor, row);
    return {
      ...serializeIntegrationConnection(row, {
        owner,
        within: owner && wholeReach ? null : scope.spaceId,
      }),
      owner_name: ownerName(row),
      locked_by: locks.get(row.id) ?? null,
    };
  });
}

/** One integration the actor could attach to an agent (own and/or shared into the space). */
interface UsableIntegration {
  integration_package_id: string;
  name: string;
  source: "own" | "shared" | "both";
  /**
   * The integration package's own manifest version (e.g. "1.1.0"), when known.
   * Lets a caller building an agent (or an inline run) pin a satisfiable
   * `dependencies.integrations` range without guessing.
   */
  version?: string;
  /**
   * The integration's declared `default_tools` (AFPS §4.4) — the tool(s) an
   * agent inherits when it declares the integration without an
   * `integrations_configuration.<id>.tools` selection. Read straight off the
   * manifest (no mcp-server resolution). Lets an agent-builder see what it
   * gets for free and whether it must select tools explicitly for anything
   * else. `undefined` when the integration declares no default.
   */
  default_tools?: readonly string[] | "*";
}

/**
 * Integrations the actor could use when building an agent manually in the
 * current space: any integration with a connection the actor may bind there —
 * {@link usableInSpace}, the resolver's access predicate.
 *
 * Deduped to the integration level (the agent picks an integration; the
 * connection itself is resolved at run time by `resolveAgentIntegrationPick`).
 * `source` reflects whether the actor owns a connection, only inherits a
 * shared one, or both.
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
      sharedSpaceIds: integrationConnections.sharedSpaceIds,
    })
    .from(integrationConnections)
    .where(usableInSpace(scope.spaceId, actor));
  if (rows.length === 0) return [];

  // own = row owned by this actor; shared = row shared into this space.
  // A single integration can have both kinds across multiple connection rows.
  const acc = new Map<string, { own: boolean; shared: boolean }>();
  for (const row of rows) {
    const entry = acc.get(row.integrationId) ?? { own: false, shared: false };
    entry.own ||= actorOwns(actor, row);
    entry.shared ||= row.sharedSpaceIds.includes(scope.spaceId);
    acc.set(row.integrationId, entry);
  }

  // Sorted, and that is load-bearing rather than cosmetic. The chat renders this
  // list into its system prompt, which pi-ai emits as ONE cache block with ONE
  // breakpoint: a reshuffle rewrites the prompt and invalidates the cached
  // prefix — and the conversation history behind it — for no reason. Map
  // insertion order follows the row order of an unordered SELECT, so Postgres is
  // free to hand back a different permutation between two identical calls.
  const ids = [...acc.keys()].sort();
  const pkgRows = await db
    .select({ id: packages.id, draftManifest: packages.draftManifest })
    .from(packages)
    .where(inArray(packages.id, ids));
  const nameMap = new Map(pkgRows.map((p) => [p.id, getPackageDisplayName(p)]));
  // The integration package's own version, read straight off the draft manifest
  // (already selected — no extra query). Surfaced so a caller pinning a
  // `dependencies.integrations` range doesn't have to guess it.
  const versionMap = new Map(
    pkgRows.map((p) => {
      const m = p.draftManifest as { version?: unknown } | null;
      return [p.id, typeof m?.version === "string" ? m.version : undefined] as const;
    }),
  );
  // The integration's declared `default_tools` (AFPS §4.4), read straight off
  // the same already-selected draft manifest — no extra query, no mcp-server
  // resolution. Surfaced so an agent-builder sees what tools it inherits for
  // free and whether it must select tools explicitly for anything else.
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
 * Which of `ids` an admin pin or an org default names — the pin wins when both do. Each binds
 * whole for every member of the space, so neither may lose a member. A member pin never locks —
 * its owner's next run reports `pinned_connection_unavailable`.
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

/**
 * Delete one connection row the actor owns within `authority` ({@link forgetDeletedConnection}),
 * `null` when none; a credential bound to a space deletes only a row scoped to it (403).
 */
export async function deleteOwnConnection(
  actor: Actor,
  connectionId: string,
  authority: MeConnectionAuthority,
): Promise<{ orgId: string; disabledScheduleIds: string[] } | null> {
  return db.transaction(async (tx) => {
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
          actorFilter(actor, integrationConnections),
          meConnectionAuthorityFilter(authority),
        ),
      )
      .for("update");
    if (!row) return null;
    if (authority.kind === "bound" && authority.spaceId && row.spaceId === null) {
      throw forbidden(
        "A credential bound to a space cannot delete a connection serving the whole organization",
      );
    }
    await assertConnectionsUnpinned(tx, [connectionId], "Connection cannot be deleted");
    await tx.delete(integrationConnections).where(eq(integrationConnections.id, row.id));
    return { orgId: row.orgId, disabledScheduleIds: await forgetDeletedConnection(tx, row) };
  });
}

const deletedConnectionOwner = {
  id: integrationConnections.id,
  userId: integrationConnections.userId,
  endUserId: integrationConnections.endUserId,
};

/**
 * Drop a deleted connection from its OWNER's member pins and schedule overrides, and disable other
 * actors' schedules naming it ({@link planConnectionForget}). Returns the schedules it disabled,
 * whose jobs the caller removes once committed (importing the scheduler here would close a cycle).
 */
async function forgetDeletedConnection(
  tx: Tx,
  row: { id: string; userId: string | null; endUserId: string | null },
): Promise<string[]> {
  // `integration_connections` holds exactly one owner id.
  const owner = actorFromIds(row.userId, row.endUserId)!;
  const plan = await planConnectionForget(tx, { id: row.id, owner }, { lock: true });
  for (const pin of plan.pins) {
    // An emptied set drops the pin: only an explicit write pins to none.
    if (pin.nextConnectionIds.length === 0) {
      await tx.delete(integrationPins).where(eq(integrationPins.id, pin.id));
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
  return [...plan.schedules.flatMap((s) => (s.disables ? [s.id] : [])), ...plan.foreignScheduleIds];
}

/** One of the owner's member pins naming the connection. */
interface PinForget {
  id: string;
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

/**
 * The rewrites forgetting connection `id` makes to its `owner`'s member pins and schedule
 * overrides, and the other actors' schedules it disables; their member pins keep the id and fail
 * loudly. `lock` takes the rows `FOR UPDATE`, pins then schedules (every actor's, in id order), for
 * a caller that applies the plan in the same transaction. `scheduleFilter` narrows both schedule
 * lists (a schedule may name a connection of another space), `pinFilter` the pins.
 */
export async function planConnectionForget(
  executor: DbOrTx,
  connection: { id: string; owner: Actor },
  {
    lock = false,
    scheduleFilter,
    pinFilter,
  }: { lock?: boolean; scheduleFilter?: SQL; pinFilter?: SQL } = {},
): Promise<ConnectionForgetPlan> {
  const { id, owner } = connection;
  const pinQuery = executor
    .select({
      id: integrationPins.id,
      agentPackageId: integrationPins.packageId,
      integrationId: integrationPins.integrationId,
      connectionIds: integrationPins.connectionIds,
    })
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
    })
    .from(schedules)
    .where(and(scheduleOverridesName(id), scheduleFilter))
    .orderBy(asc(schedules.id));
  const pinRows = await (lock ? pinQuery.for("update") : pinQuery);
  const scheduleRows = await (lock ? scheduleQuery.for("update") : scheduleQuery);
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

/** A row's scope, and its shares and origin `within` one space (`null`: all — the owner's session). */
export function connectionReachView(
  row: Pick<
    typeof integrationConnections.$inferSelect,
    "spaceId" | "sharedSpaceIds" | "originSpaceId"
  >,
  within: string | null,
): { scope: "org" | "space"; shared_space_ids: string[]; origin_space_id: string | null } {
  const seen = (id: string | null) => id !== null && (within === null || id === within);
  return {
    scope: row.spaceId === null ? "org" : "space",
    shared_space_ids: row.sharedSpaceIds.filter(seen),
    origin_space_id: seen(row.originSpaceId) ? row.originSpaceId : null,
  };
}

/**
 * Single wire serializer for an `integration_connections` row — every route
 * that returns a connection (list, connect flows, metadata PATCH) goes
 * through this so the DTO shape never forks. Only the `owner` sees the identity claims.
 */
export function serializeIntegrationConnection(
  row: typeof integrationConnections.$inferSelect,
  view: { owner: boolean; within: string | null },
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
    ...connectionReachView(row, view.within),
    // Which registered client minted this connection (system env id or custom
    // `integration_oauth_clients.id`); null for non-oauth2 auths. Surfaced so the
    // UI can show, per connection, exactly which client is in use.
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
// Non-OAuth connect flows
// ─────────────────────────────────────────────

// The api_key/basic/custom paste-the-bag connect flow now lives in
// `services/connect/fields-strategy.ts` (FieldsStrategy) — selected via
// `resolveStrategy`, reached through the programmatic import-connection route
// (`POST .../connect/fields`) and the hosted Connect portal submit.

// ─────────────────────────────────────────────
// Aggregate views for the marketplace UI
// ─────────────────────────────────────────────

/**
 * Marketplace "detail" view — manifest + per-auth status for the calling
 * actor. Drives the connect buttons + "configure OAuth client" admin
 * panel.
 */
export async function getIntegrationAuthStatuses(
  scope: SpaceScope,
  packageId: string,
  actor: Actor,
  wholeReach = false,
): Promise<{
  manifest: IntegrationManifest;
  auths: IntegrationAuthStatus[];
  /**
   * Effective agent-facing tool catalog — what the agent editor's picker
   * should display. Resolved server-side via
   * {@link resolveIntegrationToolCatalog} so the UI doesn't need a second
   * fetch for the referenced mcp-server's MCPB tool advertisement.
   */
  tool_catalog: IntegrationToolCatalogEntry[];
  /**
   * AFPS §4.4 — the tool(s) an agent inherits when it declares the
   * integration without an `integrations_configuration.<id>.tools`
   * selection. Read straight off the manifest (no mcp-server resolution).
   * Pairs with `tool_catalog`: it tells an agent-builder which catalog
   * entries are on by default vs which must be selected explicitly.
   * `undefined` when the integration declares no default.
   */
  default_tools: readonly string[] | "*" | undefined;
  /**
   * AFPS §7.8 — surfaced verbatim from the manifest so the agent editor
   * can gate its "Include all upstream tools" advanced toggle. `false`
   * (default) keeps the picker in per-tool mode; `true` lets the agent
   * set `integrations_configuration.<id>.tools = "*"`.
   */
  allow_undeclared_tools: boolean;
  /**
   * Whether the integration is activated in the current space — an
   * enabled `space_packages` row exists. Part of the resource state
   * (mirrors the list endpoint's `active` flag), not an operation scrap.
   */
  active: boolean;
  /**
   * Admin gate: when `true`, only org admins may create personal
   * connections in this space. Defaults to `false` when the
   * integration is not activated. Same source as the list endpoint.
   */
  block_user_connections: boolean;
  /**
   * The platform's own OAuth callback — what connect sends when the resolved
   * client declares no `redirect_uri` of its own. Served from the same helper
   * the connect strategy uses, so this value cannot drift from the sent one.
   *
   * NOT unconditionally the effective redirect: `OAuth2Strategy.begin` prefers
   * a registered client's stored override (`clientRedirectUri ?? redirectUri`).
   * A consumer telling an admin which string to register at the provider must
   * resolve the override of the client that will actually be used — the
   * default one, for new connections — and fall back to this. A `redirect_uri`
   * mismatch is the most common connect failure and providers reject it with
   * an opaque error, so showing the wrong one is worse than showing none.
   */
  platform_redirect_uri: string;
}> {
  await assertSpaceInScope(scope);
  const manifest = await loadManifestOrThrow(scope, packageId);
  const authsMap = manifest.auths ?? {};

  // For local-source integrations the catalog comes from the referenced
  // mcp-server's MCPB `tools[]`. Fetch it best-effort: if the mcp-server
  // package is missing the resolver still falls back to the integration's
  // sparse `tools{}` keys (legacy behaviour, no regression for the picker).
  const localRef = getLocalServerRef(manifest);
  let mcpServerTools: ReadonlyArray<{ name: string; description?: string }> | undefined;
  if (localRef) {
    const mcpServer = await fetchMcpServerManifest(localRef.name);
    if (mcpServer) {
      const t = (mcpServer as { tools?: Array<{ name?: unknown; description?: unknown }> }).tools;
      if (Array.isArray(t)) {
        mcpServerTools = t
          .filter((e): e is { name: string; description?: string } => typeof e?.name === "string")
          .map((e) => ({
            name: e.name,
            description: typeof e.description === "string" ? e.description : undefined,
          }));
      }
    }
  }
  // The resolver already emits the snake_case wire shape
  // (`policy.required_scopes`), so the catalog passes through verbatim.
  const toolCatalog: IntegrationToolCatalogEntry[] = resolveIntegrationToolCatalog({
    integration: manifest,
    mcpServerTools,
  });

  const allConnections = await listIntegrationConnections(scope, packageId, actor, wholeReach);
  // Same precedence rule as the settings list endpoint, via the shared
  // resolver — env-backed SYSTEM integrations stay `active` here too.
  const activation = (await resolveIntegrationActivations([packageId], scope.spaceId)).get(
    packageId,
  )!;
  const oauthClients = await db
    .select({ authKey: integrationOauthClients.authKey })
    .from(integrationOauthClients)
    .where(and(spaceVisibleFilter(scope), eq(integrationOauthClients.integrationId, packageId)));
  const oauthClientKeys = new Set(oauthClients.map((r) => r.authKey));

  const auths: IntegrationAuthStatus[] = Object.entries(authsMap).map(([key, rawAuth]) => {
    // AFPS: default scopes are `default_scopes`, the OAuth resource is
    // `resource` (RFC 8707); the Appstrate run-policy `required` flag lives
    // under `_meta["dev.appstrate/auth"].required` (absent = false).
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
      // AFPS §7.3 (RFC 8707) names this field `resource`.
      resource,
      connections: keyConnections,
      // Server-authoritative usability for this auth: at least one connection
      // that isn't flagged for reconnection. The single per-connection validity
      // signal (`needs_reconnection`, set by the resolver/refresh path) — so
      // consumers (chat connect card, …) never re-derive connection state and
      // stay correct as that logic evolves. Agent-agnostic (no scope/pin gate);
      // a run's authoritative readiness still comes from `validateInlineRun`.
      //
      // Reads the usable set (see `listIntegrationConnections`),
      // so an actor who owns nothing but inherits a shared connection is
      // `ready: true` — deliberately, because their run resolves that
      // connection. This is what makes the state correct under
      // `block_user_connections`, where a member cannot create a connection at
      // all and a shared one is the only path to a successful run.
      ready: keyConnections.some((c) => !c.needs_reconnection),
      has_oauth_client: oauthClientKeys.has(key),
      // Shared platform client (SYSTEM_INTEGRATIONS): when one serves this
      // (integration, auth), connect falls back to it, so the UI is connectable
      // even without an org-registered client. Registry is in-memory — no DB cost.
      has_system_client: listSystemIntegrationClientsFor(packageId, key).length > 0,
      // MCP-spec onboarding: an oauth2 auth on a remote MCP integration provisions
      // its client at connect time (CIMD/DCR), so the UI enables Connect even
      // when no client is pre-registered. Derived from the manifest shape.
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
  };
}

/**
 * Surfaces the manifest's `auth` declaration verbatim — used by the
 * OAuth initiate handler to read endpoints + resource + scopes without
 * a second DB round-trip. Returns the full manifest too so callers that
 * need the wider catalog don't re-fetch.
 */
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
 * Verify the package exists and is actually an integration before the
 * integration-scoped routes act on it, so the "wrong type" error surface is
 * uniform across them.
 *
 * The catalogue rule is the one its two peers read — `listIntegrations` and
 * `getIntegration` (`services/integration-service.ts`) — not a third wording of
 * it: org-or-system, not ephemeral, and PLACED in the calling space. It runs
 * BEFORE the placement-aware reader, so anything it accepts that the reader
 * would hide leaks through the type refusal: without `placementReadFilter` a
 * member could learn, by naming ids, that `@org/secret` exists and is an
 * `agent` — a package homed in somebody else's PERSONAL space (RBAC spec §3.6).
 * An id this space cannot reach now falls on the `!row` branch, i.e. the 404 of
 * an id that does not exist, and `wrong_package_type` survives only for a
 * package actually placed here.
 */
export async function assertIsIntegration(scope: SpaceScope, packageId: string): Promise<void> {
  const [row] = await db
    .select({ type: packages.type })
    .from(packages)
    .leftJoin(packageShares, placementShareJoin(packages.id, scope.spaceId))
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
