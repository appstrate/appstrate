// SPDX-License-Identifier: Apache-2.0

/**
 * Integration connection layer — the write side of `/api/integrations/*`.
 *
 * Covers:
 *
 *   - Per-application OAuth2 client registration (admin) backing the
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

import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  applicationPackages,
  integrationConnections,
  integrationOauthClients,
  packages,
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
} from "@appstrate/connect";
import { getEnv } from "@appstrate/env";
import { guardedFetch, isBlockedUrl } from "@appstrate/core/ssrf";
import {
  resolveSystemClientForAuth,
  getDefaultSystemIntegrationClient,
  listSystemIntegrationClientsFor,
  isSystemIntegration,
  type SystemIntegrationClientDefinition,
} from "./integration-client-registry.ts";
import { mergeSystemAndDb, setExactlyOneDefault, isUuid } from "../lib/db-helpers.ts";
import { logger } from "../lib/logger.ts";
import { notFound, conflict, invalidRequest, forbidden } from "../lib/errors.ts";
import type { ActorScope, AppScope } from "../lib/scope.ts";
import { actorInsert, actorFilter } from "../lib/actor.ts";
import { getPackageDisplayName } from "../lib/package-helpers.ts";
import type { Actor } from "@appstrate/connect";
import {
  resolveIntegrationToolCatalog,
  readDefaultTools,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import type { IntegrationToolCatalogEntry } from "@appstrate/shared-types";
import {
  getLocalServerRef,
  getRemoteSource,
  toSupportedTokenEndpointAuthMethod,
} from "./integration-manifest-helpers.ts";
import { fetchMcpServerManifest } from "./integration-service.ts";
import type { AfpsManifestAuth } from "./integration-manifest-helpers.ts";
import type { IntegrationAuthStatus } from "@appstrate/shared-types";
import { getIntegration } from "./integration-service.ts";
import { assertApplicationInScope } from "./applications.ts";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type {
  IntegrationAuthStatus,
  IntegrationAuthType,
  IntegrationConnection as IntegrationConnectionSummary,
  IntegrationOAuthClient,
} from "@appstrate/shared-types";

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
  scope: AppScope,
  packageId: string,
): Promise<IntegrationManifest> {
  const summary = await getIntegration(scope.orgId, packageId);
  if (!summary) {
    throw notFound(`Integration '${packageId}' not found in this organization`);
  }
  return summary.manifest;
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
}

/**
 * Spawn-side connection row — carries the `authKey` so the spawn
 * resolver can pick the right `manifest.auths[authKey].delivery`
 * declaration without iterating every declared auth on the integration.
 *
 * Used after the connection resolver has chosen one connection per
 * integration (flat model — no per-authKey iteration at runtime).
 */
export interface ResolvedConnectionRow extends ActorConnectionRow {
  authKey: string;
}

/**
 * Lookup the actor's `integration_connections` row for `(packageId, authKey)`
 * scoped to `applicationId`. Returns `null` when no accessible connection
 * exists — callers decide whether that is a 404, a silent skip, or a 412
 * envelope.
 *
 * "Accessible" = own connection first, then any `shared_with_org=true`
 * connection in the same application + integration + authKey. The fallback
 * unlocks the admin-shared workflow: when `block_user_connections` is on
 * and the admin has marked their connection `shared_with_org`, members
 * who run agents on this integration land on the admin's row instead of
 * 412-ing with "not connected".
 *
 * Ordering rationale (own first): a user with their own connection
 * deliberately prefers their identity over the org pool — sharing is a
 * fallback for members who haven't connected, not a silent override.
 *
 * Single-row return — when multiple shared connections exist, the DB
 * order picks. Disambiguation across an accessible candidate set is the
 * member picker's job on the agent surface; this shared-pool fallback
 * stays single-source.
 *
 * `connectionId` override (#199 snapshot path): when set, the SELECT
 * additionally filters by id. The (own OR shared) predicate is kept as
 * defence-in-depth — pinned connections must be `sharedWithOrg=true`
 * (enforced at pin upsert) and override ids must come from accessible
 * candidates (enforced at kickoff by `resolveConnectionsForRun`). So
 * a snapshot-derived id always satisfies the access predicate; the AND
 * is a safety net against rogue callers, not a behavioural filter.
 */
async function loadActorConnection(
  packageId: string,
  authKey: string,
  context: { applicationId: string; actor: Actor; connectionId?: string },
): Promise<ActorConnectionRow | null> {
  const ownerPredicate = actorFilter(context.actor, integrationConnections);
  const rows = await db
    .select({
      id: integrationConnections.id,
      credentialsEncrypted: integrationConnections.credentialsEncrypted,
      expiresAt: integrationConnections.expiresAt,
      scopesGranted: integrationConnections.scopesGranted,
      clientRef: integrationConnections.clientRef,
      userId: integrationConnections.userId,
      endUserId: integrationConnections.endUserId,
    })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.integrationId, packageId),
        eq(integrationConnections.authKey, authKey),
        eq(integrationConnections.applicationId, context.applicationId),
        or(ownerPredicate, eq(integrationConnections.sharedWithOrg, true)),
        ...(context.connectionId ? [eq(integrationConnections.id, context.connectionId)] : []),
      ),
    )
    // Stable order so the fetch (GET) and the forced refresh (POST) on a
    // multi-connection actor always resolve — and flag — the SAME sibling row.
    .orderBy(asc(integrationConnections.createdAt), asc(integrationConnections.id));
  if (rows.length === 0) return null;

  // When a connectionId override is set, the WHERE clause already narrowed
  // to that row — skip the own-vs-shared tiebreaker.
  if (context.connectionId) {
    const picked = rows[0]!;
    return {
      id: picked.id,
      credentialsEncrypted: picked.credentialsEncrypted,
      expiresAt: picked.expiresAt,
      scopesGranted: picked.scopesGranted,
      clientRef: picked.clientRef,
    };
  }

  // Prefer the actor's own row (any) over shared rows. The OR predicate
  // above admits both — we discriminate here so the result honours user
  // identity when both are present.
  const ownsRow = (r: (typeof rows)[number]): boolean =>
    context.actor.type === "user"
      ? r.userId === context.actor.id
      : r.endUserId === context.actor.id;
  const picked = rows.find(ownsRow) ?? rows[0]!;
  return {
    id: picked.id,
    credentialsEncrypted: picked.credentialsEncrypted,
    expiresAt: picked.expiresAt,
    scopesGranted: picked.scopesGranted,
    clientRef: picked.clientRef,
  };
}

/**
 * Load a specific connection row by its id, scoped to the application
 * and protected by the actor's access predicate (own OR shared). Used
 * by the spawn resolver to decrypt the connection chosen by the cascade
 * (admin pin / overrides / member pin / auto fallback) and return its
 * authKey for downstream delivery selection.
 *
 * SECURITY — `integrationId` is a REQUIRED filter: a connection id is
 * caller-supplied on some paths (`X-Connection-Id` on the credential
 * proxy), so without the integration binding a caller could pin
 * integration B's connection while requesting integration A and have
 * B's credentials injected under A's manifest + `authorized_uris`
 * allowlist. The id must resolve to a row of the REQUESTED integration
 * or not resolve at all. `expectedAuthKey` narrows further when the
 * caller has pinned a specific auth (AFPS §4.1 `auth_key`); pass `null`
 * when the connection's own authKey is authoritative.
 */
async function loadAccessibleConnectionById(
  connectionId: string,
  integrationId: string,
  expectedAuthKey: string | null,
  context: { applicationId: string; actor: Actor },
): Promise<ResolvedConnectionRow | null> {
  const ownerPredicate = actorFilter(context.actor, integrationConnections);
  const [row] = await db
    .select({
      id: integrationConnections.id,
      integrationId: integrationConnections.integrationId,
      authKey: integrationConnections.authKey,
      credentialsEncrypted: integrationConnections.credentialsEncrypted,
      expiresAt: integrationConnections.expiresAt,
      scopesGranted: integrationConnections.scopesGranted,
      clientRef: integrationConnections.clientRef,
    })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.id, connectionId),
        eq(integrationConnections.integrationId, integrationId),
        ...(expectedAuthKey !== null ? [eq(integrationConnections.authKey, expectedAuthKey)] : []),
        eq(integrationConnections.applicationId, context.applicationId),
        or(ownerPredicate, eq(integrationConnections.sharedWithOrg, true)),
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
  const { integrationId: _integrationId, ...resolved } = row;
  return resolved;
}

/**
 * Fallback connection pick used when no resolver snapshot is available
 * (the live credentials path). Walks the declared
 * auth keys and returns the first accessible connection found — same
 * auto-pick semantics as the runtime resolver's single-candidate fallback.
 * Multi-candidate ambiguity is resolved by iteration order (declared-auth
 * precedence); call sites needing deterministic disambiguation go through
 * `resolveConnectionsForRun`.
 *
 * `requiredAuthKey` (AFPS §4.1) — when set, narrows iteration to that
 * single auth key. The dep's `auth_key` pin must beat the manifest's
 * declared-auth precedence on the live-credentials path; this is the
 * non-snapshot mirror of the resolver's pre-cascade filter.
 */
async function pickAnyAccessibleConnection(
  packageId: string,
  declaredAuthKeys: string[],
  context: { applicationId: string; actor: Actor; requiredAuthKey?: string },
): Promise<ResolvedConnectionRow | null> {
  const keys = context.requiredAuthKey
    ? declaredAuthKeys.filter((k) => k === context.requiredAuthKey)
    : declaredAuthKeys;
  for (const authKey of keys) {
    const row = await loadActorConnection(packageId, authKey, context);
    if (row) return { ...row, authKey };
  }
  return null;
}

/**
 * Single source of truth for "which connection does this integration use":
 * load the resolver-pinned row when a snapshot is present, otherwise fall
 * back to the auto-pick. Shared by the spawn resolver (boot) and the live
 * credentials resolver (runtime) so the two paths can never diverge on
 * connection selection.
 *
 * Both branches are bound to `packageId`: the by-id branch filters on
 * `integrationId` (and `requiredAuthKey` when set) so a pinned/overridden
 * connection id belonging to a DIFFERENT integration never resolves —
 * it returns `null` (or fails closed) instead of decrypting foreign
 * credentials under this integration's manifest.
 */
export async function selectAccessibleConnection(
  packageId: string,
  declaredAuthKeys: string[],
  snapshotConnectionId: string | null,
  context: { applicationId: string; actor: Actor; requiredAuthKey?: string },
): Promise<ResolvedConnectionRow | null> {
  return snapshotConnectionId
    ? loadAccessibleConnectionById(
        snapshotConnectionId,
        packageId,
        context.requiredAuthKey ?? null,
        context,
      )
    : pickAnyAccessibleConnection(packageId, declaredAuthKeys, context);
}

/**
 * Per-app activation state for an integration: the `active` flag plus the admin
 * `block_user_connections` gate. `blockUserConnections` defaults to `false` when
 * no per-app row exists.
 */
export interface IntegrationActivation {
  active: boolean;
  blockUserConnections: boolean;
}

/**
 * THE activation resolver — the single source of truth every call site (spawn
 * resolver, agent readiness, sidecar guards, settings list, agent-editor detail)
 * consults, directly or via the {@link isIntegrationActive} /
 * {@link listActiveIntegrationIds} wrappers below. One SELECT over
 * `application_packages` for the whole set; the precedence rule lives here and
 * nowhere else:
 *
 *   1. An `application_packages` row EXISTS → its `enabled` flag wins. This is
 *      the explicit, sticky operator decision: an installed-and-enabled row is
 *      active; a disabled row (`enabled = false`) is inactive and STAYS inactive
 *      across runs (never silently re-enabled).
 *   2. NO row → auto-active iff the integration is a SYSTEM integration (offered
 *      by the deployment via `SYSTEM_INTEGRATIONS`, with or without a shared
 *      OAuth client, via {@link isSystemIntegration}). System integrations work
 *      out of the box without an explicit install; everything else stays
 *      inactive until installed.
 *
 * Disabling a never-installed system integration materializes a row with
 * `enabled = false` (see the enable/disable upsert), which then wins via rule 1
 * — that is what makes the opt-out sticky.
 *
 * Returns a map keyed by package id; every requested id is present (rows absent
 * from the table resolve via the system-integration fallback).
 */
export async function resolveIntegrationActivations(
  packageIds: readonly string[],
  applicationId: string,
): Promise<Map<string, IntegrationActivation>> {
  const result = new Map<string, IntegrationActivation>();
  if (packageIds.length === 0) return result;
  const rows = await db
    .select({
      packageId: applicationPackages.packageId,
      enabled: applicationPackages.enabled,
      blockUserConnections: applicationPackages.blockUserConnections,
    })
    .from(applicationPackages)
    .where(
      and(
        eq(applicationPackages.applicationId, applicationId),
        inArray(applicationPackages.packageId, packageIds as string[]),
      ),
    );
  const byId = new Map(rows.map((r) => [r.packageId, r]));
  for (const id of packageIds) {
    const row = byId.get(id);
    result.set(id, {
      // Rule 1: explicit row wins. Rule 2: no row → auto-active iff system.
      active: row !== undefined ? row.enabled : isSystemIntegration(id),
      blockUserConnections: row?.blockUserConnections ?? false,
    });
  }
  return result;
}

/**
 * `true` when the integration is active in the app — thin wrapper over
 * {@link resolveIntegrationActivations}. Use {@link assertIntegrationActive}
 * when the caller needs a structured 404 instead of a boolean.
 */
export async function isIntegrationActive(
  packageId: string,
  applicationId: string,
): Promise<boolean> {
  const map = await resolveIntegrationActivations([packageId], applicationId);
  return map.get(packageId)!.active;
}

/**
 * Active subset of `packageIds` — thin wrapper over
 * {@link resolveIntegrationActivations}. Used on the run-kickoff hot path
 * (agent readiness) where an agent may declare several integrations.
 */
export async function listActiveIntegrationIds(
  packageIds: readonly string[],
  applicationId: string,
): Promise<Set<string>> {
  const map = await resolveIntegrationActivations(packageIds, applicationId);
  const active = new Set<string>();
  for (const [id, activation] of map) {
    if (activation.active) active.add(id);
  }
  return active;
}

/** Throw `notFound` unless the integration is active in the application. */
export async function assertIntegrationActive(
  packageId: string,
  applicationId: string,
): Promise<void> {
  if (!(await isIntegrationActive(packageId, applicationId))) {
    throw notFound(`Integration '${packageId}' is not installed in this application`);
  }
}

// ─────────────────────────────────────────────
// OAuth client registration (admin)
// ─────────────────────────────────────────────

type IntegrationOAuthClientRow = typeof integrationOauthClients.$inferSelect;

/**
 * Project a stored client row into the internal `…WithSecret` shape, decrypting
 * `client_secret`. A decrypt failure degrades to an empty secret (logged) rather
 * than throwing — the connection it mints surfaces `needs_reconnection` later.
 */
function projectClientWithSecret(row: IntegrationOAuthClientRow): IntegrationOAuthClientWithSecret {
  let secret = "";
  try {
    secret =
      decryptCredentials<{ client_secret?: string }>(row.clientSecretEncrypted).client_secret ?? "";
  } catch (err) {
    logger.warn("integration_oauth_client: client_secret decrypt failed", {
      packageId: row.integrationId,
      authKey: row.authKey,
      clientId: row.id,
      err: String(err),
    });
  }
  return {
    id: row.id,
    applicationId: row.applicationId,
    integration_package_id: row.integrationId,
    auth_key: row.authKey,
    client_id: row.clientId,
    clientSecret: secret,
    has_client_secret: secret.length > 0,
    redirect_uri: row.redirectUri,
    isDefault: row.isDefault,
    autoProvisioned: row.autoProvisioned,
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
    ...rest
  } = client;
  return rest;
}

/**
 * Load every custom (BYO-app) client registered for `(packageId, authKey)`,
 * decrypted. The connect resolver picks among them (default → first); the
 * descriptor list is built from this. Ordered oldest-first for a stable list.
 */
async function listIntegrationOAuthClientsWithSecret(
  scope: AppScope,
  packageId: string,
  authKey: string,
): Promise<IntegrationOAuthClientWithSecret[]> {
  const rows = await db
    .select()
    .from(integrationOauthClients)
    .where(
      and(
        eq(integrationOauthClients.applicationId, scope.applicationId),
        eq(integrationOauthClients.integrationId, packageId),
        eq(integrationOauthClients.authKey, authKey),
      ),
    )
    .orderBy(integrationOauthClients.createdAt);
  return rows.map(projectClientWithSecret);
}

/**
 * Load the single auto-provisioned (DCR/CIMD) client for `(packageId, authKey)`,
 * if any. The partial unique `idx_ioc_one_auto` guarantees at most one — this is
 * the find half of the DCR find-or-create.
 */
async function getAutoProvisionedClient(
  scope: AppScope,
  packageId: string,
  authKey: string,
): Promise<IntegrationOAuthClientWithSecret | null> {
  const [row] = await db
    .select()
    .from(integrationOauthClients)
    .where(
      and(
        eq(integrationOauthClients.applicationId, scope.applicationId),
        eq(integrationOauthClients.integrationId, packageId),
        eq(integrationOauthClients.authKey, authKey),
        eq(integrationOauthClients.autoProvisioned, true),
      ),
    )
    .limit(1);
  return row ? projectClientWithSecret(row) : null;
}

/** Whether any custom client for this auth is currently flagged default. */
async function hasDefaultCustomClient(
  scope: AppScope,
  packageId: string,
  authKey: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: integrationOauthClients.id })
    .from(integrationOauthClients)
    .where(
      and(
        eq(integrationOauthClients.applicationId, scope.applicationId),
        eq(integrationOauthClients.integrationId, packageId),
        eq(integrationOauthClients.authKey, authKey),
        eq(integrationOauthClients.isDefault, true),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Register a NEW per-application OAuth2 client for an integration auth — one of
 * the N custom (BYO-app) clients (model-provider pattern). Always an INSERT (no
 * upsert): a fresh client id is minted each time so multiple clients coexist.
 *
 * `is_default` is set to `true` only when no other custom client is already the
 * default (mirrors `org-models` first-credential-wins); the DB partial unique
 * `idx_ioc_one_default` is the backstop. Public clients (`tokenAuthMethod=none`)
 * pass `clientSecret: ""`, still encrypted for a uniform table shape.
 *
 * `opts.autoProvisioned` marks a DCR/CIMD machine client (internal — the admin
 * route never sets it; a remote-MCP auth keeps exactly one, enforced by
 * `idx_ioc_one_auto`).
 */
export async function createIntegrationOAuthClient(
  scope: AppScope,
  packageId: string,
  authKey: string,
  input: { clientId: string; clientSecret: string; redirectUri?: string },
  opts: { autoProvisioned?: boolean } = {},
): Promise<IntegrationOAuthClientWithSecret> {
  await assertApplicationInScope(scope);
  const manifest = await loadManifestOrThrow(scope, packageId);
  const auth = lookupAuth(manifest, authKey);
  if (auth.type !== "oauth2") {
    throw invalidRequest(
      `Cannot register an OAuth client for auth '${authKey}' (type '${auth.type}' is not oauth2)`,
    );
  }

  const autoProvisioned = opts.autoProvisioned ?? false;
  // An auto-provisioned client is the sole client for its auth → default. A
  // classic client wins the default only when none already holds it.
  const isDefault = autoProvisioned
    ? true
    : !(await hasDefaultCustomClient(scope, packageId, authKey));

  const ciphertext = encryptCredentials({ client_secret: input.clientSecret ?? "" });
  const now = new Date();
  const [row] = await db
    .insert(integrationOauthClients)
    .values({
      applicationId: scope.applicationId,
      integrationId: packageId,
      authKey,
      clientId: input.clientId,
      clientSecretEncrypted: ciphertext,
      redirectUri: input.redirectUri ?? null,
      isDefault,
      autoProvisioned,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!row) {
    throw new Error("createIntegrationOAuthClient: insert returned no row");
  }
  return projectClientWithSecret(row);
}

/**
 * Rotate an existing custom client's credentials in place, by its id. Scoped to
 * the caller's application (escalation guard) — a client id from another app
 * cannot be rotated. `is_default` / `auto_provisioned` are not touched here
 * (default selection is `setDefaultIntegrationClient`'s job).
 */
export async function updateIntegrationOAuthClient(
  scope: AppScope,
  clientId: string,
  input: { clientId: string; clientSecret: string; redirectUri?: string },
): Promise<IntegrationOAuthClientWithSecret> {
  await assertApplicationInScope(scope);
  const [existing] = await db
    .select({ autoProvisioned: integrationOauthClients.autoProvisioned })
    .from(integrationOauthClients)
    .where(
      and(
        eq(integrationOauthClients.id, clientId),
        eq(integrationOauthClients.applicationId, scope.applicationId),
      ),
    )
    .limit(1);
  if (!existing) {
    throw notFound(`OAuth client '${clientId}' not found`);
  }
  // Auto-provisioned (DCR) clients are machine-managed — refuse manual rotation
  // (it would point the DCR find-or-create at hand-entered credentials).
  if (existing.autoProvisioned) {
    throw invalidRequest(
      `OAuth client '${clientId}' is auto-provisioned (DCR/CIMD) and cannot be edited manually; delete it to re-trigger registration.`,
    );
  }
  const ciphertext = encryptCredentials({ client_secret: input.clientSecret ?? "" });
  const [row] = await db
    .update(integrationOauthClients)
    .set({
      clientId: input.clientId,
      clientSecretEncrypted: ciphertext,
      redirectUri: input.redirectUri ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(integrationOauthClients.id, clientId),
        eq(integrationOauthClients.applicationId, scope.applicationId),
      ),
    )
    .returning();
  if (!row) {
    throw notFound(`OAuth client '${clientId}' not found`);
  }
  return projectClientWithSecret(row);
}

/**
 * A connect-time client resolved from a credential source — either an
 * env-provided system client or the org's per-application custom client. The
 * `clientRef` is what gets pinned on the connection so refresh resolves the
 * same credentials.
 */
export interface ResolvedConnectClient {
  clientId: string;
  clientSecret: string;
  /** Pre-registered redirect URI override, or null to use the platform default. */
  redirectUri: string | null;
  clientRef: string;
}

/** Project a registered system client into the connect-time resolved shape. */
function systemConnectClient(def: SystemIntegrationClientDefinition): ResolvedConnectClient {
  return {
    clientId: def.clientId,
    clientSecret: def.clientSecret,
    // System clients use the platform default redirect URI (no per-client override).
    redirectUri: null,
    clientRef: def.id,
  };
}

/** Project the org's per-application custom client into the resolved shape. */
function customConnectClient(client: IntegrationOAuthClientWithSecret): ResolvedConnectClient {
  return {
    clientId: client.client_id,
    clientSecret: client.clientSecret,
    redirectUri: client.redirect_uri ?? null,
    clientRef: client.id,
  };
}

/**
 * Resolve WHICH OAuth client a connect flow uses, and its credentials — the
 * single home for the client-selection precedence (previously inlined in
 * `OAuth2Strategy.begin`). An integration auth may be served by the org's own
 * per-application custom clients (BYO-app, the N loaded into
 * `resolved.customClients`) AND/OR an env-provided system client. New
 * connections always use the **default** — there is no per-connect picker:
 *   - The default custom client when one is flagged (deliberate BYO-app), else
 *     the default system client (shared, zero-config), else the first custom
 *     client.
 * Auto-provisioned remote-MCP auths (DCR/CIMD) keep their own (custom) client
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
  const customClients = resolved.customClients;

  // The default. Among the N custom (BYO-app) clients the one flagged
  // `is_default` wins; an admin can move the flag to the system client
  // (no custom default), in which case the default system client wins. With no
  // default custom and no system client, the first custom is the connectable
  // fallback. Analogous to the org default-pointer resolution cascade in
  // org-models.ts / org-proxies.ts, scoped per `(app, integration, auth)` here.
  const defaultCustom = customClients.find((c) => c.isDefault);
  if (defaultCustom) return customConnectClient(defaultCustom);
  if (!autoProvisioned) {
    const sys = getDefaultSystemIntegrationClient(integrationId, authKey);
    if (sys) return systemConnectClient(sys);
  }
  // Custom clients present but none flagged default, and no system client to
  // fall to — still connectable via the first custom rather than failing.
  if (customClients.length > 0) return customConnectClient(customClients[0]!);

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
 * first, then the per-application `integration_oauth_clients` table by id.
 *
 * SECURITY: the custom lookup is scoped to `(applicationId, integrationId,
 * authKey)` so a custom id belonging to another app/integration/auth never
 * resolves — the same re-validation the system branch applies. Returns `null`
 * when the id resolves to neither (since-removed client, remapped system entry,
 * cross-scope id) → the caller skips refresh (surfaces needs_reconnection).
 *
 * `tokenEndpointAuthMethod` gates secret resolution: a public client
 * (`"none"`) carries no secret, so the system secret is dropped and the custom
 * ciphertext is never decrypted.
 */
export async function resolveIntegrationClientById(
  clientRef: string,
  applicationId: string,
  integrationId: string,
  authKey: string,
  tokenEndpointAuthMethod: string | undefined,
): Promise<{ clientId: string; clientSecret: string } | null> {
  const needsSecret = tokenEndpointAuthMethod !== "none";

  // 1) System client (env), validated against this (integrationId, authKey).
  const sys = resolveSystemClientForAuth(clientRef, integrationId, authKey);
  if (sys) {
    return { clientId: sys.clientId, clientSecret: needsSecret ? sys.clientSecret : "" };
  }

  // A custom client id is the row's UUID PK. Anything else — a since-removed
  // system id, a remapped id, garbage — cannot be a custom row, so skip the
  // typed lookup (and avoid a `uuid` cast error on a non-UUID literal).
  if (!isUuid(clientRef)) return null;

  // 2) Custom per-application client, by id AND fully scoped (escalation guard).
  const [row] = await db
    .select({
      clientId: integrationOauthClients.clientId,
      clientSecretEncrypted: integrationOauthClients.clientSecretEncrypted,
    })
    .from(integrationOauthClients)
    .where(
      and(
        eq(integrationOauthClients.id, clientRef),
        eq(integrationOauthClients.applicationId, applicationId),
        eq(integrationOauthClients.integrationId, integrationId),
        eq(integrationOauthClients.authKey, authKey),
      ),
    )
    .limit(1);
  if (!row) return null;

  let clientSecret = "";
  if (needsSecret) {
    try {
      clientSecret =
        decryptCredentials<{ client_secret?: string }>(row.clientSecretEncrypted).client_secret ??
        "";
    } catch (err) {
      logger.warn("Integration custom client_secret decrypt failed", {
        integrationId,
        authKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
  return { clientId: row.clientId, clientSecret };
}

/**
 * A client available to connect an integration auth — surfaced in the UI so a
 * user can see the shared system client and/or the org's own (BYO) client and
 * which one is the default. Secrets are never included.
 */
export interface IntegrationClientDescriptor {
  /** `client_ref` to pass back at connect time. */
  client_ref: string;
  /** `"built-in"` (env system client) or `"custom"` (org per-app client). */
  source: "built-in" | "custom";
  /**
   * For `"custom"` clients, the org's own OAuth `client_id` (they registered it).
   * For `"built-in"` (system) clients, a stable opaque FINGERPRINT (truncated
   * SHA-256) — never the real `SYSTEM_INTEGRATIONS` client_id, which is a
   * deployment secret and must not leak to the front. It is display-only; the
   * connect/refresh keyspace is `client_ref`, not this field.
   */
  client_id: string;
  /** True for the client used when no explicit `client_ref` is given at connect. */
  is_default: boolean;
  /** True for a DCR/CIMD machine client — read-only in the UI (no manual edit). */
  auto_provisioned: boolean;
  /** True when the client carries a non-empty secret (private client). */
  has_client_secret: boolean;
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
 * List the OAuth clients available for `(packageId, authKey)`: the org's custom
 * per-application client (when registered) plus any env-provided system
 * clients. The default mirrors the connect resolution precedence — the org's
 * custom client wins when present (it was registered on purpose), else the
 * first system client.
 */
export async function listIntegrationClients(
  scope: AppScope,
  packageId: string,
  authKey: string,
): Promise<IntegrationClientDescriptor[]> {
  await assertApplicationInScope(scope);
  const customRows = await listIntegrationOAuthClientsWithSecret(scope, packageId, authKey);
  // Same generic system+DB merge the model-provider / proxy lists use: system
  // entries first, a DB row whose id collides with a system id is skipped
  // (system wins) — matching the system-first resolution in
  // `resolveIntegrationClientById`.
  const system = new Map(
    listSystemIntegrationClientsFor(packageId, authKey).map((def) => [def.id, def] as const),
  );
  const merged = mergeSystemAndDb<
    SystemIntegrationClientDefinition,
    (typeof customRows)[number],
    IntegrationClientDescriptor
  >({
    system,
    rows: customRows,
    mapSystem: (id, def) => ({
      client_ref: id,
      source: "built-in",
      // Never expose the real system client_id (deployment secret) — only an
      // opaque, stable fingerprint for the UI to show/diff.
      client_id: fingerprintSystemClientId(def.clientId),
      is_default: false,
      auto_provisioned: false,
      has_client_secret: def.clientSecret.length > 0,
      redirect_uri: null,
    }),
    mapRow: (row) => ({
      client_ref: row.id,
      source: "custom",
      client_id: row.client_id,
      is_default: false,
      auto_provisioned: row.autoProvisioned,
      has_client_secret: row.has_client_secret,
      redirect_uri: row.redirect_uri,
    }),
  });
  // Default resolution mirrors connect (and the model-provider cascade): the
  // custom client flagged `is_default` wins (at most one — DB-enforced); else
  // the first system client; else (no system) the first custom client.
  const defaultCustom = customRows.find((c) => c.isDefault);
  const defaultRef =
    defaultCustom?.id ??
    merged.find((c) => c.source === "built-in")?.client_ref ??
    merged.find((c) => c.source === "custom")?.client_ref ??
    null;
  return merged.map((c) => ({ ...c, is_default: c.client_ref === defaultRef }));
}

/**
 * Choose which OAuth client is the default for new connections on
 * `(application, integration, auth)` — the model-provider `setDefaultModel`
 * analogue. Among the N custom (BYO-app) clients at most one is flagged default
 * (DB-enforced by `idx_ioc_one_default`):
 *   - `clientRef` names one of the org's custom clients → flag it default
 *     (`true`) and clear every other custom of the auth (`false`).
 *   - `clientRef` names a system client → clear ALL custom defaults so the
 *     resolution cascade falls to the system client.
 * Selecting a system default with no custom clients is a no-op (the system
 * client is already the default). An unknown or cross-scope `clientRef` is
 * rejected, never silently stored. Clear-then-set runs in one transaction so the
 * partial unique never sees two defaults mid-flight.
 */
export async function setDefaultIntegrationClient(
  scope: AppScope,
  integrationId: string,
  authKey: string,
  clientRef: string,
): Promise<void> {
  await assertApplicationInScope(scope);
  const customRows = await db
    .select({ id: integrationOauthClients.id })
    .from(integrationOauthClients)
    .where(
      and(
        eq(integrationOauthClients.applicationId, scope.applicationId),
        eq(integrationOauthClients.integrationId, integrationId),
        eq(integrationOauthClients.authKey, authKey),
      ),
    );

  const target = customRows.find((r) => r.id === clientRef);
  // The ref must name either one of the org's custom clients or a system client
  // serving this auth — anything else is rejected, never silently stored.
  if (!target && !resolveSystemClientForAuth(clientRef, integrationId, authKey)) {
    throw invalidRequest(
      `Unknown OAuth client '${clientRef}' for '${integrationId}' auth '${authKey}'`,
    );
  }

  if (customRows.length === 0) return; // system default with no custom rows — nothing to persist.

  const authScope = and(
    eq(integrationOauthClients.applicationId, scope.applicationId),
    eq(integrationOauthClients.integrationId, integrationId),
    eq(integrationOauthClients.authKey, authKey),
  );
  const now = new Date();
  await setExactlyOneDefault({
    // Clear every custom default first so the partial unique never sees two.
    clear: (tx) =>
      tx
        .update(integrationOauthClients)
        .set({ isDefault: false, updatedAt: now })
        .where(and(authScope, eq(integrationOauthClients.isDefault, true))),
    // Then flag the chosen custom client (system selection leaves all cleared).
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
  /**
   * The org's custom (BYO-app) clients for this auth — N for an oauth2-classic
   * auth, 0..1 for an auto-provisioned (DCR/CIMD) auth. Empty when none is
   * registered and dynamic registration is either not opted-in or unavailable —
   * the caller surfaces the "register an OAuth client" / provisioning error.
   */
  customClients: IntegrationOAuthClientWithSecret[];
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
    getRemoteSource(manifest) !== null
  );
}

/**
 * `fetch` wrapper that refuses SSRF-unsafe targets before every request. The
 * remote-MCP discovery chain probes manifest- and *server*-derived URLs (RFC
 * 9728 well-known + the `WWW-Authenticate` challenge's `resource_metadata`,
 * then RFC 8414 metadata), so each GET must be guarded — not just the
 * registration POST.
 *
 * Delegates to the shared {@link guardedFetch} primitive, which does per-hop
 * DNS resolution + blocklist checks and follows redirects MANUALLY (each hop
 * re-checked), strips userinfo/fragment, and rejects non-http(s) schemes. This
 * is strictly stronger than the previous literal-only `isBlockedUrl` + raw
 * `fetch` posture, which resolved no DNS (a public host with an A record
 * pointing at `169.254.169.254`/RFC1918 sailed through) and left `redirect`
 * unpinned (Bun follows 3xx by default, so a `302` to a private host was
 * followed unchecked — SSRF + DNS-rebind). `discoverProtectedResourceMetadata`
 * is best-effort (swallows fetch errors → returns `null`), so a blocked URL
 * cleanly degrades to "discovery failed" rather than throwing.
 */
const ssrfGuardedFetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return guardedFetch(url, init, { logger });
  // `preconnect` is never invoked by the discovery helpers; cast to satisfy the
  // `typeof fetch` shape Bun's lib declares.
}) as typeof fetch;

/** Drop a URL that targets a blocked (loopback/RFC1918/link-local/metadata) host. */
function safeUrl(url: string | undefined): string | undefined {
  return url && !isBlockedUrl(url) ? url : undefined;
}

/**
 * Resolve the OAuth connect config for an auth, auto-registering a client via
 * RFC 7591 Dynamic Client Registration for remote MCP integrations when none is
 * pre-registered. This is the MCP-spec onboarding path: an operator installs
 * the connector, the first actor clicks Connect, and Appstrate self-registers
 * — no hand-created OAuth app, no client secret.
 *
 * Discovery chain (when the manifest doesn't declare endpoints):
 *   `source.remote.url` → RFC 9728 protected-resource metadata
 *   (`resource` + `authorization_servers`) → RFC 8414 AS metadata
 *   (`authorization_endpoint` / `token_endpoint` / `registration_endpoint`).
 *
 * Best-effort: any discovery/registration failure returns the existing client
 * (or `null`), letting the caller fall back to the classic "register a client"
 * error. Never throws for the dynamic path — classic (non-remote) integrations
 * are unaffected: they early-return with the existing lookup.
 */
export async function ensureIntegrationOAuthClient(
  scope: AppScope,
  packageId: string,
  authKey: string,
  manifest: IntegrationManifest,
  auth: AfpsManifestAuth,
  redirectUri: string,
): Promise<ResolvedOAuthConnect> {
  // Classic path: not a remote MCP oauth2 auth — load ALL custom clients (the
  // connect resolver picks the default among the N); endpoints come from the
  // manifest in the caller.
  if (!usesAutoProvisionedClient(manifest, auth)) {
    return {
      customClients: await listIntegrationOAuthClientsWithSecret(scope, packageId, authKey),
    };
  }

  // Auto-provisioned path: there is exactly one machine client (DCR/CIMD).
  const existing = await getAutoProvisionedClient(scope, packageId, authKey);

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
  if (issuer && isBlockedUrl(issuer)) {
    logger.warn("auto-DCR: discovered issuer blocked by SSRF guard", {
      packageId,
      authKey,
      issuer,
    });
    issuer = undefined;
  }

  // Fill authorize/token/registration endpoints from issuer discovery
  // (RFC 8414). Manifest endpoints, when declared, win.
  const endpoints = await resolveOAuthEndpoints({
    ...(issuer ? { issuer } : {}),
    ...(auth.authorization_endpoint ? { authorizationEndpoint: auth.authorization_endpoint } : {}),
    ...(auth.token_endpoint ? { tokenEndpoint: auth.token_endpoint } : {}),
  });

  // SSRF: a discovery document is server-controlled and can advertise endpoints
  // on internal hosts. The token endpoint is fetched server-side at exchange,
  // so drop any blocked endpoint before threading it into the connect state.
  const resolved: ResolvedOAuthConnect = {
    customClients: existing ? [existing] : [],
    ...(issuer ? { issuer } : {}),
    ...(safeUrl(endpoints.authorizationEndpoint)
      ? { authorizationEndpoint: endpoints.authorizationEndpoint }
      : {}),
    ...(safeUrl(endpoints.tokenEndpoint) ? { tokenEndpoint: endpoints.tokenEndpoint } : {}),
    ...(resource ? { resource } : {}),
  };

  // Client already registered — nothing to mint; just return discovered config.
  if (existing) return resolved;

  // No registration endpoint discovered — can't auto-register; let the caller
  // surface the existing "register a client" error.
  const registrationEndpoint = endpoints.registrationEndpoint;
  if (!registrationEndpoint) {
    logger.warn("auto-DCR: no registration_endpoint discovered", { packageId, authKey, issuer });
    return {
      ...resolved,
      provisioningFailure: {
        message:
          "the authorization server did not advertise dynamic client registration; register an OAuth client manually, or retry once the server advertises it",
      },
    };
  }

  // SSRF pre-check — the endpoint is manifest/discovery-derived and we POST to
  // it. This LITERAL check (no DNS) exists to surface the friendly
  // provisioningFailure below for obviously-internal targets; the authoritative
  // guard is `registerDynamicClient` itself, whose default transport is
  // `guardedFetch` (per-hop DNS resolution + blocklist, `maxRedirects: 0`), so
  // a public hostname rebinding to an internal address is refused at connect
  // time even though it passes this literal check.
  if (isBlockedUrl(registrationEndpoint)) {
    logger.warn("auto-DCR: registration_endpoint blocked by SSRF guard", {
      packageId,
      authKey,
      registrationEndpoint,
    });
    return {
      ...resolved,
      provisioningFailure: {
        message:
          "the discovered registration endpoint was refused as an unsafe (loopback/internal) target; register an OAuth client manually instead",
      },
    };
  }

  // Narrow the concurrency window: re-check in case a parallel Connect just
  // registered a client for the same (app, package, authKey).
  const racedClient = await getAutoProvisionedClient(scope, packageId, authKey);
  if (racedClient) return { ...resolved, customClients: [racedClient] };

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
    const grantTypes = endpoints.grantTypesSupported?.includes("refresh_token")
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
    });
    let client: IntegrationOAuthClientWithSecret;
    try {
      client = await createIntegrationOAuthClient(
        scope,
        packageId,
        authKey,
        {
          clientId: registration.clientId,
          clientSecret: registration.clientSecret ?? "",
          redirectUri,
        },
        { autoProvisioned: true },
      );
    } catch (insertErr) {
      // Concurrent auto-DCR: a parallel Connect for the same (app, package,
      // authKey) registered its client between our `racedClient` re-check above
      // and this insert. The partial unique `idx_ioc_one_auto` rejects the
      // second auto-provisioned row (Postgres 23505) — catch it and re-select
      // the winner instead of surfacing a 500. Our own upstream registration is
      // abandoned (harmless: an unused DCR client), the connection proceeds on
      // the winning client.
      if (
        insertErr instanceof Error &&
        "code" in insertErr &&
        (insertErr as { code: string }).code === "23505"
      ) {
        const winner = await getAutoProvisionedClient(scope, packageId, authKey);
        if (winner) {
          logger.info("auto-DCR: lost registration race, reusing concurrently-registered client", {
            packageId,
            authKey,
            clientId: winner.client_id,
          });
          return { ...resolved, customClients: [winner] };
        }
      }
      throw insertErr;
    }
    logger.info("auto-DCR: registered OAuth client", {
      packageId,
      authKey,
      clientId: registration.clientId,
    });
    return { ...resolved, customClients: [client] };
  } catch (err) {
    if (err instanceof DynamicClientRegistrationError) {
      logger.warn("auto-DCR: dynamic client registration failed", {
        packageId,
        authKey,
        registrationEndpoint,
        status: err.status,
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
      const reachedServer = err.status !== undefined;
      return {
        ...resolved,
        provisioningFailure: reachedServer
          ? {
              message:
                err.errorDescription ??
                "the authorization server rejected dynamic client registration",
              status: err.status,
            }
          : {
              message:
                "could not reach the authorization server to register a client; retry once it is reachable",
            },
      };
    }
    throw err;
  }
}

/**
 * Delete one custom client by its id, scoped to the caller's application
 * (escalation guard). If it was the default, no auto-promotion — the resolution
 * cascade simply falls to the system client (or the admin re-picks a default);
 * this matches the model-provider behaviour and keeps the operation predictable.
 */
export async function deleteIntegrationOAuthClient(
  scope: AppScope,
  clientId: string,
): Promise<{ deletedConnections: number }> {
  await assertApplicationInScope(scope);
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(integrationOauthClients)
      .where(
        and(
          eq(integrationOauthClients.id, clientId),
          eq(integrationOauthClients.applicationId, scope.applicationId),
        ),
      )
      .returning({ id: integrationOauthClients.id });
    if (deleted.length === 0) {
      throw notFound(`OAuth client '${clientId}' not found`);
    }
    // Cascade: every connection pinned to this client is now dead — the
    // client_id/secret that minted its tokens is gone, so it can never refresh
    // again (resolveIntegrationClientById → null → needs_reconnection forever).
    // Industry standard mirrors this: deleting an OAuth app at the IdP
    // (GitHub/Google) revokes all tokens it issued. We delete the orphaned
    // connections in the SAME transaction rather than leave un-refreshable
    // zombies. `client_ref` holds this client's UUID PK — globally unique and
    // never collides with a non-UUID system id — so the applicationId-scoped
    // match is exact. The pg_notify DELETE trigger fires `connection_update`
    // so live UI badges clear without a manual publish.
    const deletedConns = await tx
      .delete(integrationConnections)
      .where(
        and(
          eq(integrationConnections.clientRef, clientId),
          eq(integrationConnections.applicationId, scope.applicationId),
        ),
      )
      .returning({ id: integrationConnections.id });
    return { deletedConnections: deletedConns.length };
  });
}

// ─────────────────────────────────────────────
// Identity extraction
// ─────────────────────────────────────────────

/**
 * Apply `extractTokenIdentity` JSONPath-like accessors against a token
 * response (or a credentials bag for non-OAuth auths). The mapping is
 * intentionally simple — `"$.field"` or `"field"` selects a top-level
 * key, `"$.a.b"` walks nested objects, missing values become `""`.
 *
 * Always produces a stable `accountId` — falls back to:
 *   1. The declared `extractTokenIdentity.accountId` mapping
 *   2. `email` / `account_email` / `sub` claims if present
 *   3. The literal string `"default"` when nothing matches (single-account)
 */
export function extractIdentity(
  manifest: IntegrationManifest,
  authKey: string,
  source: Record<string, unknown>,
): { accountId: string; identityClaims: Record<string, unknown> } {
  const auth = lookupAuth(manifest, authKey) as AfpsManifestAuth;
  // AFPS: the token identity mapping is `identity_claims`.
  const mapping = auth.identity_claims ?? {};
  const claims: Record<string, unknown> = {};
  for (const [outKey, accessor] of Object.entries(mapping)) {
    claims[outKey] = readPath(source, accessor);
  }
  const accountId =
    (typeof claims.accountId === "string" && claims.accountId) ||
    (typeof claims.account_id === "string" && claims.account_id) ||
    (typeof source.email === "string" && source.email) ||
    (typeof source.account_email === "string" && source.account_email) ||
    (typeof source.sub === "string" && source.sub) ||
    "default";
  return { accountId, identityClaims: claims };
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
  // The mapping value is either a bare claim name (`"sub"`) or a JSONPath
  // (`"$.sub"`, `"$.user.email"`). For the OIDC keyspace check we only
  // care about leaf single-segment names — that's the canonical form of
  // an OIDC claim. A deeper path like `"$.user.email"` is by definition
  // not an OIDC claim, so we don't index it (the spec example in §7.4
  // line 931 shows OIDC standard claims only).
  const oidcToAfpsKeys = new Map<string, string[]>();
  for (const [afpsKey, accessor] of Object.entries(mapping)) {
    const path = accessor.startsWith("$.") ? accessor.slice(2) : accessor;
    if (path.length === 0 || path.includes(".")) continue;
    const list = oidcToAfpsKeys.get(path);
    if (list) list.push(afpsKey);
    else oidcToAfpsKeys.set(path, [afpsKey]);
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

function readPath(source: Record<string, unknown>, accessor: string): unknown {
  const path = accessor.startsWith("$.") ? accessor.slice(2) : accessor;
  const parts = path.split(".");
  let cur: unknown = source;
  for (const part of parts) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return "";
    }
  }
  return cur;
}

// ─────────────────────────────────────────────
// Connection storage
// ─────────────────────────────────────────────

export interface StoreConnectionInput {
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
}

/**
 * Where a {@link persistCredentialBundle} write lands. Matches the three
 * converged write sites:
 *
 *   - `insert`       — first acquisition (OAuth2 callback / fields submit).
 *   - `update-owned` — user-initiated reconnect / scope upgrade. Owner-scoped
 *                      WHERE (id + applicationId + actor identity + the
 *                      (packageId, authKey) the credentials belong to); throws
 *                      `notFound` when the row isn't the caller's OR belongs to
 *                      a different integration/auth (a caller-supplied id can
 *                      never overwrite an unrelated connection of theirs).
 *   - `update-by-id` — system write-back (proactive token refresh). Keyed by
 *                      id only — the id came from an already-authorized
 *                      resolution — and silently no-ops when the row is gone
 *                      (matches the pre-convergence refresh behaviour).
 */
export type PersistTarget =
  | { kind: "insert"; scope: AppScope; actor: Actor }
  | {
      kind: "update-owned";
      scope: AppScope;
      actor: Actor;
      connectionId: string;
      /** The (packageId, authKey) the credentials belong to — re-stamped into
       * the WHERE so a mismatched `connectionId` matches zero rows. */
      packageId: string;
      authKey: string;
    }
  | { kind: "update-by-id"; connectionId: string };

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
 *     `scope` — the scope high-water-mark.
 */
export interface PersistCredentialInput {
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
}

/**
 * The single low-level writer of the credential columns
 * (`credentials_encrypted`, `expires_at`, `scopes_granted`, `identity_claims`,
 * `needs_reconnection`) on `integration_connections`. Every acquisition and
 * refresh path converges here (spec §4.1 — "1 writer"). Returns the persisted
 * summary for INSERT / `update-owned`; `null` for `update-by-id` (the refresh
 * write-back consumes its own result shape and ignores this).
 *
 * Why no upsert-by-accountId: the previous model collapsed every connection on
 * the same `(packageId, authKey, accountId, app, owner)` tuple and silently
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
    await assertApplicationInScope(target.scope);
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
    // mix of declared auths (OAuth + PAT + custom). The runtime picks exactly
    // one per run via the resolver cascade; the member picker disambiguates
    // when >1 candidate is accessible.
    //
    // Display name, resolved once at creation and stable thereafter (refresh /
    // update paths never touch `label`). The extracted identity (`accountId`,
    // which `extractTokenIdentity` maps to the upstream email/login) when one
    // was produced, else "Connexion N" — N is the actor's existing connection
    // count for this (app, integration) + 1, computed as a subquery in the
    // INSERT so it's one statement. This is the single source of truth for the
    // UI: no render-time fallback, the label is always set. User-editable after.
    const identityLabel =
      input.accountId && input.accountId !== "default" ? input.accountId : undefined;
    const ownerFilter = userId ? sql`user_id = ${userId}` : sql`end_user_id = ${endUserId}`;
    const labelValue: string | SQL =
      identityLabel ??
      input.labelHint ??
      sql<string>`'Connexion ' || ((SELECT COUNT(*) FROM integration_connections WHERE application_id = ${target.scope.applicationId} AND integration_package_id = ${insertPackageId} AND ${ownerFilter}) + 1)`;
    // Serialize the COUNT(*)-derived "Connexion N" numbering per
    // (app, integration, owner) with a transaction-scoped advisory lock: two
    // concurrent first-time connects for the same actor would otherwise both
    // read the same COUNT (READ COMMITTED — neither sees the other's
    // uncommitted row) and mint duplicate "Connexion 2" labels. Under the lock
    // the second insert waits for the first to commit, so its subquery counts
    // the freshly-inserted row and numbers monotonically. Identity/labelHint
    // labels don't need it but the lock is cheap and keeps one code path.
    const ownerKey = userId ?? endUserId ?? "";
    const labelLockKey = `ic_label:${target.scope.applicationId}:${insertPackageId}:${ownerKey}`;
    const row = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${labelLockKey})::bigint)`);
      const inserted = await tx
        .insert(integrationConnections)
        .values({
          integrationId: insertPackageId,
          authKey: insertAuthKey,
          accountId: insertAccountId,
          applicationId: target.scope.applicationId,
          userId,
          endUserId,
          credentialsEncrypted: ciphertext,
          identityClaims: input.identityClaims ?? {},
          scopesGranted: input.scopesGranted ?? [],
          needsReconnection: input.needsReconnection ?? false,
          clientRef: input.clientRef ?? null,
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
    return serializeIntegrationConnection(row);
  }

  // UPDATE — shared column set; WHERE differs by target.
  const clearsReconnection = !(input.needsReconnection ?? false);
  const set: Partial<typeof integrationConnections.$inferInsert> = {
    credentialsEncrypted: ciphertext,
    expiresAt: input.expiresAt ?? null,
    needsReconnection: input.needsReconnection ?? false,
    // Any successful credential write clears the transient-refresh streak — a
    // working refresh (or a user reconnect) proves the connection is healthy
    // again, so the escalation counter must not carry over. See
    // `recordIntegrationRefreshFailure`.
    refreshFailureCount: 0,
    lastRefreshFailureAt: null,
    updatedAt: now,
  };
  if (input.accountId !== undefined) set.accountId = input.accountId;
  if (input.identityClaims !== undefined) set.identityClaims = input.identityClaims;
  if (input.scopesGranted !== undefined) set.scopesGranted = input.scopesGranted;
  // Re-stamp the minting client on reconnect (acquisition UPDATE passes it);
  // the refresh write-back omits it so the high-water client_ref is preserved.
  if (input.clientRef !== undefined) set.clientRef = input.clientRef;

  if (target.kind === "update-owned") {
    await assertApplicationInScope(target.scope);
    const ownerPredicate = actorFilter(target.actor, integrationConnections);
    // Owner-scoped reconnect: id + application + actor identity, PLUS the
    // (packageId, authKey) the new credentials belong to. Without the latter
    // two, a caller-supplied `connectionId` could overwrite ANY connection they
    // own — including one for a different integration — with this integration's
    // credentials. Re-stamping them in the WHERE makes a mismatched id match
    // zero rows → the caller gets `notFound`, never a cross-integration clobber.
    const ownerScope = and(
      eq(integrationConnections.id, target.connectionId),
      eq(integrationConnections.applicationId, target.scope.applicationId),
      eq(integrationConnections.integrationId, target.packageId),
      eq(integrationConnections.authKey, target.authKey),
      ownerPredicate,
    );
    // Identity guard: a reconnect / scope-upgrade must stay on the SAME
    // upstream account. If the re-consent authenticated a different identity
    // (e.g. the user picked another Google account on the consent screen),
    // refuse — silently rebinding a connection (possibly shared or pinned to
    // agents under the assumption it's account A) to a different account is a
    // data-integrity and access surprise. Only enforced between two real
    // identities; "default" (identity-less) never blocks an upgrade.
    //
    // The read (identity check) and the write must be atomic: performed as two
    // separate statements, a concurrent update could change `accountId` between
    // them and slip a different-account clobber past the guard. Do both in one
    // transaction and take a row lock (`FOR UPDATE`) on the SELECT so the row
    // is pinned for the duration.
    const row = await db.transaction(async (tx) => {
      if (input.accountId !== undefined && input.accountId !== "default") {
        const [existing] = await tx
          .select({ accountId: integrationConnections.accountId })
          .from(integrationConnections)
          .where(ownerScope)
          .limit(1)
          .for("update");
        if (
          existing &&
          existing.accountId !== "default" &&
          existing.accountId !== input.accountId
        ) {
          throw conflict(
            "identity_mismatch",
            `This connection is linked to a different account (${existing.accountId}). Reconnect with the same account, or create a new connection.`,
          );
        }
      }
      const updated = await tx
        .update(integrationConnections)
        .set(set)
        .where(ownerScope)
        .returning();
      return updated[0];
    });
    if (!row) {
      throw notFound(`Connection '${target.connectionId}' not found or not owned by caller`);
    }
    return serializeIntegrationConnection(row);
  }

  // update-by-id (system write-back) — keyed by id only, silent no-op on miss.
  // Monotonic clear: the proactive refresh write-back always passes
  // `needsReconnection: false`, which would race-clobber a `true` set
  // concurrently by `markIntegrationConnectionNeedsReconnection` (scope-shrink /
  // revoke). When this write CLEARS the flag, gate the row on
  // `needs_reconnection = false` so a concurrently-set `true` is preserved — the
  // refresh simply no-ops on that row (a flagged connection's cached credentials
  // are stale anyway, so skipping the write-back is harmless). An explicit
  // `true` write (or any non-clearing write) stays unconditional.
  const byIdWhere = clearsReconnection
    ? and(
        eq(integrationConnections.id, target.connectionId),
        eq(integrationConnections.needsReconnection, false),
      )
    : eq(integrationConnections.id, target.connectionId);
  await db.update(integrationConnections).set(set).where(byIdWhere);
  return null;
}

/**
 * The single writer of `needs_reconnection = true` that does NOT touch the
 * stored credentials. Flips a row to "re-connect required" — used by the
 * refresh paths (no refresh_token / revoked grant) and the scope-shrink-
 * below-floor guard. Keyed by id (system write); no-ops when the row is gone.
 */
/**
 * Read and decrypt the stored credential fields for one connection by id.
 * Returns `null` when the row is gone. Used by the re-auth (acquisition) path
 * to preserve a still-valid `refresh_token` when the IdP omits one on
 * re-consent — the refresh path already does the equivalent inline.
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
  return decryptCredentialsToStringMap(row.credentialsEncrypted);
}

export async function markIntegrationConnectionNeedsReconnection(
  connectionId: string,
): Promise<void> {
  await db
    .update(integrationConnections)
    .set({ needsReconnection: true, updatedAt: new Date() })
    .where(eq(integrationConnections.id, connectionId));
}

/**
 * Record a *transient* token-refresh failure (network / 5xx / parse — NOT
 * `invalid_grant`, which flips `needsReconnection` immediately via
 * {@link markIntegrationConnectionNeedsReconnection}). Atomic, race-safe:
 * the increment and the escalation decision happen in one SQL statement so
 * concurrent refreshes on the same row (overlapping runs) cannot lose a count.
 *
 * Escalation gate — `needsReconnection` is set to `true` only when BOTH:
 *   1. this failure brings the streak to `>= maxFailures`, AND
 *   2. the token is genuinely dead: `expires_at` is set AND already older than
 *      `graceSeconds` ago.
 *
 * The expiry gate is what makes this safe: a transient upstream outage while
 * the cached token is still valid (future `expires_at`) increments the counter
 * but never escalates — the connection keeps working and a later refresh
 * recovers (clearing the streak via `persistCredentialBundle`). Only a token
 * that is expired-past-grace AND repeatedly unrefreshable — the silent-death
 * case — gets flipped. `needsReconnection` is OR'd so a concurrently-set `true`
 * (revoke / scope-shrink) is never cleared here.
 */
export async function recordIntegrationRefreshFailure(
  connectionId: string,
  maxFailures: number,
  graceSeconds: number,
): Promise<void> {
  await db
    .update(integrationConnections)
    .set({
      refreshFailureCount: sql`${integrationConnections.refreshFailureCount} + 1`,
      lastRefreshFailureAt: sql`now()`,
      needsReconnection: sql`${integrationConnections.needsReconnection} OR (${integrationConnections.refreshFailureCount} + 1 >= ${maxFailures} AND ${integrationConnections.expiresAt} IS NOT NULL AND ${integrationConnections.expiresAt} < now() - make_interval(secs => ${graceSeconds}))`,
      updatedAt: sql`now()`,
    })
    .where(eq(integrationConnections.id, connectionId));
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
  scope: AppScope,
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
 * List the actor's connections for an integration. End-users see only
 * their own rows; dashboard users see only their own rows. Filtering by
 * actor matches the runtime-side resolver in Phase 1.2a.
 */
export async function listIntegrationConnections(
  scope: AppScope,
  packageId: string,
  actor: Actor,
): Promise<IntegrationConnectionSummary[]> {
  await assertApplicationInScope(scope);
  const ownerPredicate = actorFilter(actor, integrationConnections);
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.integrationId, packageId),
        eq(integrationConnections.applicationId, scope.applicationId),
        ownerPredicate,
      ),
    );
  return rows.map(serializeIntegrationConnection);
}

/** One integration the actor could attach to an agent (own and/or org-shared). */
export interface UsableIntegration {
  integration_id: string;
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
 * current application: any integration for which a connection exists that is
 * either the actor's own (`actorFilter`) OR opted into org-wide sharing
 * (`sharedWithOrg`). Mirrors the resolver predicate in `loadActorConnection`.
 *
 * Deduped to the integration level (the agent picks an integration; the
 * connection itself is resolved at run time by `resolveAgentIntegrationPick`).
 * `source` reflects whether the actor owns a connection, only inherits a
 * shared one, or both.
 */
export async function listUsableIntegrationsForActor(
  scope: AppScope,
  actor: Actor,
): Promise<UsableIntegration[]> {
  await assertApplicationInScope(scope);
  const ownerPredicate = actorFilter(actor, integrationConnections);
  const rows = await db
    .select({
      integrationId: integrationConnections.integrationId,
      userId: integrationConnections.userId,
      endUserId: integrationConnections.endUserId,
      sharedWithOrg: integrationConnections.sharedWithOrg,
    })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.applicationId, scope.applicationId),
        or(ownerPredicate, eq(integrationConnections.sharedWithOrg, true)),
      ),
    );
  if (rows.length === 0) return [];

  // own = row owned by this actor; shared = row opted into org-wide sharing.
  // A single integration can have both kinds across multiple connection rows.
  const acc = new Map<string, { own: boolean; shared: boolean }>();
  for (const row of rows) {
    const own = actor.type === "end_user" ? row.endUserId === actor.id : row.userId === actor.id;
    const entry = acc.get(row.integrationId) ?? { own: false, shared: false };
    entry.own ||= own;
    entry.shared ||= row.sharedWithOrg;
    acc.set(row.integrationId, entry);
  }

  const ids = [...acc.keys()];
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
      integration_id: integrationId,
      name: nameMap.get(integrationId) ?? integrationId,
      source,
      version: versionMap.get(integrationId),
      default_tools: defaultToolsMap.get(integrationId),
    };
  });
}

/**
 * Delete one connection row. Used by the "disconnect" button per auth
 * (or per account, when multi-account).
 */
export async function deleteIntegrationConnection(
  scope: AppScope | ActorScope,
  connectionId: string,
  actor: Actor,
): Promise<void> {
  // Confirm the target application belongs to the caller's org before touching
  // any connection — same escalation guard the other connection mutations run.
  // Without it a caller could pass an application id from another org and the
  // WHERE (id + applicationId + owner) would silently match zero rows and 404,
  // masking the cross-org attempt instead of rejecting it up front.
  //
  // The `/me/connections` path passes an `ActorScope` (no `orgId`): it is
  // actor-scoped, so the actor-ownership predicate below is the authoritative
  // boundary and the app∈org check does not apply. The escalation guard runs
  // only for `AppScope` callers (those that resolved an org). See docs: /me
  // routes skip org context.
  if ("orgId" in scope) await assertApplicationInScope(scope);
  const ownerPredicate = actorFilter(actor, integrationConnections);
  const deleted = await db
    .delete(integrationConnections)
    .where(
      and(
        eq(integrationConnections.id, connectionId),
        eq(integrationConnections.applicationId, scope.applicationId),
        ownerPredicate,
      ),
    )
    .returning({ id: integrationConnections.id });
  if (deleted.length === 0) {
    throw notFound(`Connection '${connectionId}' not found or not owned by caller`);
  }
}

/**
 * Single wire serializer for an `integration_connections` row — every route
 * that returns a connection (list, connect flows, metadata PATCH) goes
 * through this so the DTO shape never forks.
 */
export function serializeIntegrationConnection(
  row: typeof integrationConnections.$inferSelect,
): IntegrationConnectionSummary {
  if (row.userId && row.endUserId) {
    // DB check constraint rules this out; guard against drift.
    throw new Error("integration_connections row has both userId and endUserId set");
  }
  return {
    id: row.id,
    packageId: row.integrationId,
    auth_key: row.authKey,
    account_id: row.accountId,
    identity_claims: (row.identityClaims as Record<string, unknown> | null) ?? null,
    scopes_granted: row.scopesGranted,
    needs_reconnection: row.needsReconnection,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    owner_type: row.userId ? "user" : "end_user",
    owner_id: (row.userId ?? row.endUserId)!,
    label: row.label,
    shared_with_org: row.sharedWithOrg,
    // Which registered client minted this connection (system env id or custom
    // `integration_oauth_clients.id`); null for non-oauth2 auths. Surfaced so the
    // UI can show, per connection, exactly which client is in use.
    client_ref: row.clientRef,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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
  scope: AppScope,
  packageId: string,
  actor: Actor,
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
   * Whether the integration is activated in the current application — an
   * enabled `application_packages` row exists. Part of the resource state
   * (mirrors the list endpoint's `active` flag), not an operation scrap.
   */
  active: boolean;
  /**
   * Admin gate: when `true`, only org admins may create personal
   * connections in this application. Defaults to `false` when the
   * integration is not activated. Same source as the list endpoint.
   */
  block_user_connections: boolean;
}> {
  await assertApplicationInScope(scope);
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

  const allConnections = await listIntegrationConnections(scope, packageId, actor);
  // Same precedence rule as the settings list endpoint, via the shared
  // resolver — env-backed SYSTEM integrations stay `active` here too.
  const activation = (await resolveIntegrationActivations([packageId], scope.applicationId)).get(
    packageId,
  )!;
  const oauthClients = await db
    .select({ authKey: integrationOauthClients.authKey })
    .from(integrationOauthClients)
    .where(
      and(
        eq(integrationOauthClients.applicationId, scope.applicationId),
        eq(integrationOauthClients.integrationId, packageId),
      ),
    );
  const oauthClientKeys = new Set(oauthClients.map((r) => r.authKey));

  const auths: IntegrationAuthStatus[] = Object.entries(authsMap).map(([key, rawAuth]) => {
    // AFPS: default scopes are `default_scopes`, the OAuth resource is
    // `resource` (RFC 8707); the Appstrate run-policy `required` flag lives
    // under `_meta["dev.appstrate/auth"].required`.
    const auth = rawAuth as AfpsManifestAuth;
    const authMeta = (auth._meta?.["dev.appstrate/auth"] ?? undefined) as
      | { required?: boolean }
      | undefined;
    const resource = auth.resource ?? null;
    const keyConnections = allConnections.filter((c) => c.auth_key === key);
    return {
      auth_key: key,
      type: auth.type,
      required: authMeta?.required ?? true,
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
  };
}

/**
 * Surfaces the manifest's `auth` declaration verbatim — used by the
 * OAuth initiate handler to read endpoints + resource + scopes without
 * a second DB round-trip. Returns the full manifest too so callers that
 * need the wider catalog don't re-fetch.
 */
export async function readIntegrationAuth(
  scope: AppScope,
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
// Install/uninstall (thin wrapper enforcing integration type)
// ─────────────────────────────────────────────

/**
 * Verify the package exists and is actually an integration before
 * delegating to the generic application_packages install path. The
 * marketplace UI never calls `/api/packages/.../install`; it always
 * routes through this so the "wrong type" error surface is uniform.
 */
export async function assertIsIntegration(scope: AppScope, packageId: string): Promise<void> {
  const [row] = await db
    .select({ type: packages.type })
    .from(packages)
    .where(
      and(
        eq(packages.id, packageId),
        sql`(${packages.orgId} = ${scope.orgId} OR ${packages.source} = 'system')`,
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
