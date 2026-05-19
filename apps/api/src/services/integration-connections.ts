// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.3 — integration connection layer (marketplace UI backend).
 *
 * Backs the `/api/integrations/*` REST surface. Covers:
 *
 *   - Per-application OAuth2 client registration (admin) backing the
 *     marketplace's "Configure OAuth" admin form. Stored in
 *     `integration_oauth_clients` with the client_secret v1-envelope
 *     encrypted (empty string for public clients).
 *   - End-user connect flows for all 5 auth types declared by the
 *     manifest's `auths.{key}` map: `api_key`, `basic`, `custom`,
 *     `oauth2`, `oauth1`. OAuth2 drives PKCE S256 via
 *     `@appstrate/connect/integration-oauth`. OAuth1 returns a NOT
 *     IMPLEMENTED error for now (the runtime layer in Phase 1.2a knows
 *     how to consume oauth1 credentials but the user-facing connect
 *     popup needs platform OAuth1 endpoints — out of scope for the
 *     marketplace MVP, falls back to `custom` auth where the user
 *     pastes tokens).
 *   - Per-(integration, auth, account) connection storage in
 *     `integration_connections` with v1-envelope encrypted credentials.
 *   - Lookup helpers consumed by the marketplace UI (per-auth status,
 *     scopes granted, expiry, multi-account list).
 *
 * The runtime spawn path (Phase 1.2a/c) reads `integration_connections`
 * directly; this module is the user-facing write side that populates it.
 */

import { and, eq, or, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  applicationPackages,
  integrationConnections,
  integrationOauthClients,
  applications,
  packages,
} from "@appstrate/db/schema";
import { encryptCredentials, decryptCredentials } from "@appstrate/connect";
import { logger } from "../lib/logger.ts";
import { notFound, conflict, invalidRequest, forbidden } from "../lib/errors.ts";
import type { AppScope } from "../lib/scope.ts";
import type { Actor } from "@appstrate/connect";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { getIntegration } from "./integration-service.ts";

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
  clientSecret: string;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function assertActorIdentity(actor: Actor): { userId: string | null; endUserId: string | null } {
  if (actor.type === "user") return { userId: actor.id, endUserId: null };
  return { userId: null, endUserId: actor.id };
}

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

async function assertAppBelongsToOrg(scope: AppScope): Promise<void> {
  const [app] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.id, scope.applicationId), eq(applications.orgId, scope.orgId)))
    .limit(1);
  if (!app) {
    throw notFound(`Application '${scope.applicationId}' not found in this organization`);
  }
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
export interface ActorConnectionRow {
  id: string;
  credentialsEncrypted: string;
  expiresAt: Date | null;
  scopesGranted: string[];
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
 * order picks. The picker UI lands in p4 to disambiguate; for now
 * single-source-of-shared-credential is the supported pattern (matches
 * the documented workflow).
 */
export async function loadActorConnection(
  packageId: string,
  authKey: string,
  context: { applicationId: string; actor: Actor },
): Promise<ActorConnectionRow | null> {
  const ownerPredicate =
    context.actor.type === "user"
      ? eq(integrationConnections.userId, context.actor.id)
      : eq(integrationConnections.endUserId, context.actor.id);
  const rows = await db
    .select({
      id: integrationConnections.id,
      credentialsEncrypted: integrationConnections.credentialsEncrypted,
      expiresAt: integrationConnections.expiresAt,
      scopesGranted: integrationConnections.scopesGranted,
      userId: integrationConnections.userId,
      endUserId: integrationConnections.endUserId,
    })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.integrationPackageId, packageId),
        eq(integrationConnections.authKey, authKey),
        eq(integrationConnections.applicationId, context.applicationId),
        or(ownerPredicate, eq(integrationConnections.sharedWithOrg, true)),
      ),
    );
  if (rows.length === 0) return null;

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
  };
}

/**
 * `true` when the integration is recorded in `application_packages` for the
 * given app. Use {@link assertIntegrationInstalled} when the caller needs a
 * structured 404 instead of a boolean.
 */
export async function isIntegrationInstalled(
  packageId: string,
  applicationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ packageId: applicationPackages.packageId })
    .from(applicationPackages)
    .where(
      and(
        eq(applicationPackages.applicationId, applicationId),
        eq(applicationPackages.packageId, packageId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Throw `notFound` unless the integration is installed in the application. */
export async function assertIntegrationInstalled(
  packageId: string,
  applicationId: string,
): Promise<void> {
  if (!(await isIntegrationInstalled(packageId, applicationId))) {
    throw notFound(`Integration '${packageId}' is not installed in this application`);
  }
}

// ─────────────────────────────────────────────
// OAuth client registration (admin)
// ─────────────────────────────────────────────

/**
 * Register or rotate the per-application OAuth2 client credentials for
 * an integration auth. Idempotent — upserts on the unique index
 * `(applicationId, packageId, authKey)`.
 *
 * Public clients (`tokenAuthMethod=none`) pass `clientSecret: ""` and
 * the empty secret is still encrypted to keep the table shape uniform.
 */
export async function upsertIntegrationOAuthClient(
  scope: AppScope,
  packageId: string,
  authKey: string,
  input: { clientId: string; clientSecret: string; redirectUri?: string },
): Promise<IntegrationOAuthClient> {
  await assertAppBelongsToOrg(scope);
  const manifest = await loadManifestOrThrow(scope, packageId);
  const auth = lookupAuth(manifest, authKey);
  if (auth.type !== "oauth2") {
    throw invalidRequest(
      `Cannot register an OAuth client for auth '${authKey}' (type '${auth.type}' is not oauth2)`,
    );
  }

  const ciphertext = encryptCredentials({ client_secret: input.clientSecret ?? "" });
  const now = new Date();
  const [row] = await db
    .insert(integrationOauthClients)
    .values({
      applicationId: scope.applicationId,
      integrationPackageId: packageId,
      authKey,
      clientId: input.clientId,
      clientSecretEncrypted: ciphertext,
      redirectUri: input.redirectUri ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        integrationOauthClients.applicationId,
        integrationOauthClients.integrationPackageId,
        integrationOauthClients.authKey,
      ],
      set: {
        clientId: input.clientId,
        clientSecretEncrypted: ciphertext,
        redirectUri: input.redirectUri ?? null,
        updatedAt: now,
      },
    })
    .returning();

  if (!row) {
    throw new Error("upsertIntegrationOAuthClient: insert returned no row");
  }

  return {
    applicationId: row.applicationId,
    integrationPackageId: row.integrationPackageId,
    authKey: row.authKey,
    clientId: row.clientId,
    hasClientSecret: (input.clientSecret ?? "").length > 0,
    redirectUri: row.redirectUri,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Load the OAuth client record (incl. decrypted `clientSecret`). Public
 * route handlers MUST project to {@link IntegrationOAuthClient}
 * (`{ clientSecret: _, ...publicShape } = …`) before responding.
 */
export async function getIntegrationOAuthClient(
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
        eq(integrationOauthClients.integrationPackageId, packageId),
        eq(integrationOauthClients.authKey, authKey),
      ),
    )
    .limit(1);
  if (!row) return null;
  let secret = "";
  try {
    const decrypted = decryptCredentials<{ client_secret?: string }>(row.clientSecretEncrypted);
    secret = decrypted.client_secret ?? "";
  } catch (err) {
    logger.warn("integration_oauth_client: client_secret decrypt failed", {
      packageId,
      authKey,
      err: String(err),
    });
  }
  return {
    applicationId: row.applicationId,
    integrationPackageId: row.integrationPackageId,
    authKey: row.authKey,
    clientId: row.clientId,
    clientSecret: secret,
    hasClientSecret: secret.length > 0,
    redirectUri: row.redirectUri,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function deleteIntegrationOAuthClient(
  scope: AppScope,
  packageId: string,
  authKey: string,
): Promise<void> {
  const deleted = await db
    .delete(integrationOauthClients)
    .where(
      and(
        eq(integrationOauthClients.applicationId, scope.applicationId),
        eq(integrationOauthClients.integrationPackageId, packageId),
        eq(integrationOauthClients.authKey, authKey),
      ),
    )
    .returning({ id: integrationOauthClients.id });
  if (deleted.length === 0) {
    throw notFound(`No OAuth client registered for '${packageId}' auth '${authKey}'`);
  }
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
  const auth = lookupAuth(manifest, authKey);
  const mapping = auth.extractTokenIdentity ?? {};
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
}

/**
 * Insert-or-update one connection row (per the unique index on
 * `(packageId, authKey, accountId, applicationId, owner)`). Returns the
 * persisted summary view.
 */
export async function saveIntegrationConnection(
  scope: AppScope,
  input: StoreConnectionInput,
): Promise<IntegrationConnectionSummary> {
  await assertAppBelongsToOrg(scope);
  const { userId, endUserId } = assertActorIdentity(input.actor);
  const ciphertext = encryptCredentials(input.credentials);
  const now = new Date();

  // Manual upsert — Drizzle's `onConflictDoUpdate` won't engage with the
  // `coalesce(nullable)` expression in the unique index. We try update
  // first; if no row matched the owner predicate, fall back to insert.
  const ownerPredicate = userId
    ? eq(integrationConnections.userId, userId)
    : eq(integrationConnections.endUserId, endUserId!);

  const updated = await db
    .update(integrationConnections)
    .set({
      credentialsEncrypted: ciphertext,
      identityClaims: input.identityClaims ?? {},
      scopesGranted: input.scopesGranted ?? [],
      needsReconnection: false,
      expiresAt: input.expiresAt ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(integrationConnections.integrationPackageId, input.packageId),
        eq(integrationConnections.authKey, input.authKey),
        eq(integrationConnections.accountId, input.accountId),
        eq(integrationConnections.applicationId, scope.applicationId),
        ownerPredicate,
      ),
    )
    .returning();

  let row = updated[0];
  if (!row) {
    // Single-auth-per-integration-per-actor invariant: refuse the insert
    // when the actor already has a connection on a DIFFERENT auth for
    // this integration in this application. Multi-auth integrations
    // (e.g. GitHub MCP with `oauth` + `pat`) would otherwise leave the
    // PAT row as dead weight (the spawn resolver prefers oauth2 and the
    // MITM gets ambiguous per-request behaviour). The actor disconnects
    // first if they want to switch auth.
    const existingOther = await db
      .select({ authKey: integrationConnections.authKey })
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.integrationPackageId, input.packageId),
          eq(integrationConnections.applicationId, scope.applicationId),
          ownerPredicate,
        ),
      )
      .limit(1);
    if (existingOther[0] && existingOther[0].authKey !== input.authKey) {
      throw conflict(
        "integration_other_auth_connected",
        `This integration is already connected via auth '${existingOther[0].authKey}'. Disconnect it before connecting via '${input.authKey}'.`,
      );
    }

    const inserted = await db
      .insert(integrationConnections)
      .values({
        integrationPackageId: input.packageId,
        authKey: input.authKey,
        accountId: input.accountId,
        applicationId: scope.applicationId,
        userId,
        endUserId,
        credentialsEncrypted: ciphertext,
        identityClaims: input.identityClaims ?? {},
        scopesGranted: input.scopesGranted ?? [],
        needsReconnection: false,
        expiresAt: input.expiresAt ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    row = inserted[0];
  }

  if (!row) {
    throw new Error("saveIntegrationConnection: upsert returned no row");
  }

  return rowToSummary(row);
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
  await assertAppBelongsToOrg(scope);
  const { userId, endUserId } = assertActorIdentity(actor);
  const ownerPredicate = userId
    ? eq(integrationConnections.userId, userId)
    : eq(integrationConnections.endUserId, endUserId!);
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.integrationPackageId, packageId),
        eq(integrationConnections.applicationId, scope.applicationId),
        ownerPredicate,
      ),
    );
  return rows.map(rowToSummary);
}

/**
 * Delete one connection row. Used by the "disconnect" button per auth
 * (or per account, when multi-account).
 */
export async function deleteIntegrationConnection(
  scope: AppScope,
  connectionId: string,
  actor: Actor,
): Promise<void> {
  const { userId, endUserId } = assertActorIdentity(actor);
  const ownerPredicate = userId
    ? eq(integrationConnections.userId, userId)
    : eq(integrationConnections.endUserId, endUserId!);
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

function rowToSummary(
  row: typeof integrationConnections.$inferSelect,
): IntegrationConnectionSummary {
  if (row.userId && row.endUserId) {
    // DB check constraint rules this out; guard against drift.
    throw new Error("integration_connections row has both userId and endUserId set");
  }
  return {
    id: row.id,
    packageId: row.integrationPackageId,
    authKey: row.authKey,
    accountId: row.accountId,
    identityClaims: (row.identityClaims as Record<string, unknown> | null) ?? null,
    scopesGranted: row.scopesGranted,
    needsReconnection: row.needsReconnection,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    ownerType: row.userId ? "user" : "end_user",
    ownerId: (row.userId ?? row.endUserId)!,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─────────────────────────────────────────────
// Non-OAuth connect flows
// ─────────────────────────────────────────────

/**
 * Connect an `api_key` / `basic` / `custom` auth. The `credentials`
 * payload shape is validated against the auth's declared
 * `credentials.schema` (best-effort — full AJV validation lives in the
 * route layer; this guard catches obviously empty payloads).
 */
export async function connectIntegrationWithFields(
  scope: AppScope,
  packageId: string,
  authKey: string,
  credentials: Record<string, string>,
  actor: Actor,
): Promise<IntegrationConnectionSummary> {
  const manifest = await loadManifestOrThrow(scope, packageId);
  const auth = lookupAuth(manifest, authKey);
  if (auth.type === "oauth2" || auth.type === "oauth1") {
    throw invalidRequest(
      `Auth '${authKey}' is type '${auth.type}' — use the OAuth flow, not the fields flow`,
    );
  }
  if (!credentials || Object.keys(credentials).length === 0) {
    throw invalidRequest("credentials payload cannot be empty", "credentials");
  }

  const { accountId, identityClaims } = extractIdentity(manifest, authKey, credentials);
  return saveIntegrationConnection(scope, {
    packageId,
    authKey,
    accountId,
    credentials,
    identityClaims,
    actor,
  });
}

// ─────────────────────────────────────────────
// Aggregate views for the marketplace UI
// ─────────────────────────────────────────────

import type { IntegrationAuthStatus } from "@appstrate/shared-types";

/**
 * Marketplace "detail" view — manifest + per-auth status for the calling
 * actor. Drives the connect buttons + "configure OAuth client" admin
 * panel.
 */
export async function getIntegrationAuthStatuses(
  scope: AppScope,
  packageId: string,
  actor: Actor,
): Promise<{ manifest: IntegrationManifest; auths: IntegrationAuthStatus[] }> {
  await assertAppBelongsToOrg(scope);
  const manifest = await loadManifestOrThrow(scope, packageId);
  const authsMap = manifest.auths ?? {};
  const allConnections = await listIntegrationConnections(scope, packageId, actor);
  const oauthClients = await db
    .select({ authKey: integrationOauthClients.authKey })
    .from(integrationOauthClients)
    .where(
      and(
        eq(integrationOauthClients.applicationId, scope.applicationId),
        eq(integrationOauthClients.integrationPackageId, packageId),
      ),
    );
  const oauthClientKeys = new Set(oauthClients.map((r) => r.authKey));

  const auths: IntegrationAuthStatus[] = Object.entries(authsMap).map(([key, auth]) => ({
    authKey: key,
    type: auth.type,
    required: auth.required ?? true,
    scopes: auth.scopes ?? [],
    audience: auth.audience ?? null,
    connections: allConnections.filter((c) => c.authKey === key),
    hasOAuthClient: oauthClientKeys.has(key),
  }));

  return { manifest, auths };
}

/**
 * Surfaces the manifest's `auth` declaration verbatim — used by the
 * OAuth initiate handler to read endpoints + audience + scopes without
 * a second DB round-trip. Returns the full manifest too so callers that
 * need the wider catalog (e.g. `expandGrantedScopes`) don't re-fetch.
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

/**
 * Per-actor gate for managing connections on behalf of someone else.
 * Members may manage their own connections; admin/owner may impersonate
 * via `Appstrate-User`. End-user actors are restricted by upstream
 * `requireAppContext()` + impersonation policy in `actor.ts`.
 */
export function assertCanManageActorConnection(
  actor: Actor,
  targetActor: Actor,
  callerRole: "owner" | "admin" | "member" | "viewer",
): void {
  if (actor.type === targetActor.type && actor.id === targetActor.id) return;
  if (callerRole === "owner" || callerRole === "admin") return;
  throw forbidden("Cannot manage connections for another actor");
}
