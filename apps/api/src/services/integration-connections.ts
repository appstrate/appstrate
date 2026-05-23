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
import {
  encryptCredentials,
  encryptCredentialEnvelope,
  decryptCredentials,
} from "@appstrate/connect";
import { logger } from "../lib/logger.ts";
import { notFound, conflict, invalidRequest } from "../lib/errors.ts";
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
 * order picks. The picker UI lands in p4 to disambiguate; for now
 * single-source-of-shared-credential is the supported pattern (matches
 * the documented workflow).
 *
 * `connectionId` override (#199 snapshot path): when set, the SELECT
 * additionally filters by id. The (own OR shared) predicate is kept as
 * defence-in-depth — pinned connections must be `sharedWithOrg=true`
 * (enforced at pin upsert) and override ids must come from accessible
 * candidates (enforced at kickoff by `resolveConnectionsForRun`). So
 * a snapshot-derived id always satisfies the access predicate; the AND
 * is a safety net against rogue callers, not a behavioural filter.
 */
export async function loadActorConnection(
  packageId: string,
  authKey: string,
  context: { applicationId: string; actor: Actor; connectionId?: string },
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
        ...(context.connectionId ? [eq(integrationConnections.id, context.connectionId)] : []),
      ),
    );
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
  };
}

/**
 * Load a specific connection row by its id, scoped to the application
 * and protected by the actor's access predicate (own OR shared). Used
 * by the spawn resolver to decrypt the connection chosen by the cascade
 * (admin pin / overrides / member pin / auto fallback) and return its
 * authKey for downstream delivery selection.
 */
async function loadAccessibleConnectionById(
  connectionId: string,
  context: { applicationId: string; actor: Actor },
): Promise<ResolvedConnectionRow | null> {
  const ownerPredicate =
    context.actor.type === "user"
      ? eq(integrationConnections.userId, context.actor.id)
      : eq(integrationConnections.endUserId, context.actor.id);
  const [row] = await db
    .select({
      id: integrationConnections.id,
      authKey: integrationConnections.authKey,
      credentialsEncrypted: integrationConnections.credentialsEncrypted,
      expiresAt: integrationConnections.expiresAt,
      scopesGranted: integrationConnections.scopesGranted,
    })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.id, connectionId),
        eq(integrationConnections.applicationId, context.applicationId),
        or(ownerPredicate, eq(integrationConnections.sharedWithOrg, true)),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Fallback connection pick used when no resolver snapshot is available
 * (the live credentials path). Walks the declared
 * auth keys and returns the first accessible connection found — same
 * auto-pick semantics as the runtime resolver's single-candidate fallback.
 * Multi-candidate ambiguity is resolved by iteration order (declared-auth
 * precedence); call sites needing deterministic disambiguation go through
 * `resolveConnectionsForRun`.
 */
export async function pickAnyAccessibleConnection(
  packageId: string,
  declaredAuthKeys: string[],
  context: { applicationId: string; actor: Actor },
): Promise<ResolvedConnectionRow | null> {
  for (const authKey of declaredAuthKeys) {
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
 */
export async function selectAccessibleConnection(
  packageId: string,
  declaredAuthKeys: string[],
  snapshotConnectionId: string | null,
  context: { applicationId: string; actor: Actor },
): Promise<ResolvedConnectionRow | null> {
  return snapshotConnectionId
    ? loadAccessibleConnectionById(snapshotConnectionId, context)
    : pickAnyAccessibleConnection(packageId, declaredAuthKeys, context);
}

/**
 * `true` when the integration is active in the app — i.e. recorded in
 * `application_packages` (activation installs the row, deactivation removes
 * it). Use {@link assertIntegrationActive} when the caller needs a
 * structured 404 instead of a boolean.
 */
export async function isIntegrationActive(
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
  /**
   * When provided, UPDATE this specific row (reconnect / upgrade-scopes
   * paths). Owner predicate is still applied as defence in depth — a
   * stale id from another actor can never land on someone else's row.
   * When omitted, always INSERT a new row — the user explicitly asked
   * for a new connection and we let them own duplicates if they want.
   */
  connectionId?: string;
}

/**
 * Where a {@link persistCredentialBundle} write lands. Matches the three
 * converged write sites:
 *
 *   - `insert`       — first acquisition (OAuth2 callback / fields submit).
 *   - `update-owned` — user-initiated reconnect / scope upgrade. Owner-scoped
 *                      WHERE (id + applicationId + actor identity); throws
 *                      `notFound` when the row isn't the caller's.
 *   - `update-by-id` — system write-back (proactive token refresh). Keyed by
 *                      id only — the id came from an already-authorized
 *                      resolution — and silently no-ops when the row is gone
 *                      (matches the pre-convergence refresh behaviour).
 */
export type PersistTarget =
  | { kind: "insert"; scope: AppScope; actor: Actor }
  | { kind: "update-owned"; scope: AppScope; actor: Actor; connectionId: string }
  | { kind: "update-by-id"; connectionId: string };

/**
 * Persist input for the credential columns.
 *
 * `credentials` is the injectable **outputs** plane. `inputs` (spec §4.6) is
 * the bootstrap-secret plane, persisted ONLY when an OrchestratedStrategy
 * declares `persistLoginSecret` — when present (non-empty) the writer emits a
 * structured v2 envelope `{ v:2, outputs, inputs }`; otherwise it stays a flat
 * v1 blob, byte-identical to every pre-Phase-4 write. The injection path can
 * never read `inputs` (it only ever projects `outputs`).
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
  /** Bootstrap secrets (login password) — persisted NON-injectable (v2). */
  inputs?: Record<string, string>;
  expiresAt?: Date | null;
  needsReconnection?: boolean;
  accountId?: string;
  identityClaims?: Record<string, unknown>;
  scopesGranted?: string[];
  /** INSERT only — the `(packageId, authKey)` the new row belongs to. */
  packageId?: string;
  authKey?: string;
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
 */
export async function persistCredentialBundle(
  target: PersistTarget,
  input: PersistCredentialInput,
): Promise<IntegrationConnectionSummary | null> {
  // v2 structured envelope only when a bootstrap secret is being persisted
  // (`persistLoginSecret`); otherwise a flat v1 blob, byte-identical to every
  // pre-Phase-4 write so existing connections/round-trips are unchanged.
  const hasInputs = input.inputs && Object.keys(input.inputs).length > 0;
  const ciphertext = hasInputs
    ? encryptCredentialEnvelope({ outputs: input.credentials, inputs: input.inputs })
    : encryptCredentials(input.credentials);
  const now = new Date();

  if (target.kind === "insert") {
    await assertAppBelongsToOrg(target.scope);
    const { userId, endUserId } = assertActorIdentity(target.actor);
    if (!input.packageId || !input.authKey || input.accountId === undefined) {
      throw new Error("persistCredentialBundle(insert): packageId, authKey, accountId required");
    }
    // No mono-auth-per-actor gate: an actor may hold N connections across any
    // mix of declared auths (OAuth + PAT + custom). The runtime picks exactly
    // one per run via the resolver cascade; the member picker disambiguates
    // when >1 candidate is accessible.
    const inserted = await db
      .insert(integrationConnections)
      .values({
        integrationPackageId: input.packageId,
        authKey: input.authKey,
        accountId: input.accountId,
        applicationId: target.scope.applicationId,
        userId,
        endUserId,
        credentialsEncrypted: ciphertext,
        identityClaims: input.identityClaims ?? {},
        scopesGranted: input.scopesGranted ?? [],
        needsReconnection: input.needsReconnection ?? false,
        expiresAt: input.expiresAt ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      throw new Error("persistCredentialBundle: insert returned no row");
    }
    return rowToSummary(row);
  }

  // UPDATE — shared column set; WHERE differs by target.
  const set: Partial<typeof integrationConnections.$inferInsert> = {
    credentialsEncrypted: ciphertext,
    expiresAt: input.expiresAt ?? null,
    needsReconnection: input.needsReconnection ?? false,
    updatedAt: now,
  };
  if (input.accountId !== undefined) set.accountId = input.accountId;
  if (input.identityClaims !== undefined) set.identityClaims = input.identityClaims;
  if (input.scopesGranted !== undefined) set.scopesGranted = input.scopesGranted;

  if (target.kind === "update-owned") {
    await assertAppBelongsToOrg(target.scope);
    const { userId, endUserId } = assertActorIdentity(target.actor);
    const ownerPredicate = userId
      ? eq(integrationConnections.userId, userId)
      : eq(integrationConnections.endUserId, endUserId!);
    const updated = await db
      .update(integrationConnections)
      .set(set)
      .where(
        and(
          eq(integrationConnections.id, target.connectionId),
          eq(integrationConnections.applicationId, target.scope.applicationId),
          ownerPredicate,
        ),
      )
      .returning();
    const row = updated[0];
    if (!row) {
      throw notFound(`Connection '${target.connectionId}' not found or not owned by caller`);
    }
    return rowToSummary(row);
  }

  // update-by-id (system write-back) — keyed by id only, silent no-op on miss.
  await db
    .update(integrationConnections)
    .set(set)
    .where(eq(integrationConnections.id, target.connectionId));
  return null;
}

/**
 * The single writer of `needs_reconnection = true` that does NOT touch the
 * stored credentials. Flips a row to "re-connect required" — used by the
 * refresh paths (no refresh_token / revoked grant) and the scope-shrink-
 * below-floor guard. Keyed by id (system write); no-ops when the row is gone.
 */
export async function markIntegrationConnectionNeedsReconnection(
  connectionId: string,
): Promise<void> {
  await db
    .update(integrationConnections)
    .set({ needsReconnection: true, updatedAt: new Date() })
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
  };
  const summary = input.connectionId
    ? await persistCredentialBundle(
        { kind: "update-owned", scope, actor: input.actor, connectionId: input.connectionId },
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
    label: row.label,
    sharedWithOrg: row.sharedWithOrg,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─────────────────────────────────────────────
// Non-OAuth connect flows
// ─────────────────────────────────────────────

// The api_key/basic/custom paste-the-bag connect flow now lives in
// `services/connect/fields-strategy.ts` (FieldsStrategy) — selected via
// `resolveStrategy` and reached through the connect/fields route adapter.

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
 * need the wider catalog (e.g. `expandScopesGranted`) don't re-fetch.
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
