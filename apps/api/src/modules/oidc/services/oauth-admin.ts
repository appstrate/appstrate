// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth client admin service — polymorphic org + space clients.
 *
 * Direct CRUD against `oauth_clients`. Each client is scoped at one of three
 * levels:
 *
 *   - `instance`: platform-wide, no org/space FK (the platform dashboard SPA)
 *   - `org`: pinned to an organization via `referenced_org_id` (dashboard
 *     users are the actors)
 *   - `space`: pinned to a space via `referenced_space_id`
 *     (end-users are the actors)
 *
 * A DB-level CHECK constraint guarantees exactly one of the two FKs is set
 * based on `level` (or neither for instance), so "mixed" clients are
 * unrepresentable.
 *
 * Why we bypass `auth.api.adminCreateOAuthClient`: the plugin derives its
 * `reference_id` via `clientReference({ session })` which doesn't have
 * access to Appstrate's multi-tenant context. We write directly to the
 * Drizzle schema.
 *
 * `level`, `referenced_org_id`, `referenced_space_id` and `self_service` are
 * SQL columns, and the claim builder reads them off the row. The provider's
 * `metadata` JSON is client-influenced — a registration body may set it — so no
 * platform decision is taken from it.
 *
 * Secrets are generated as base64url-encoded random bytes, hashed with
 * SHA-256 at rest, and only returned in plaintext from `createClient` /
 * `rotateClientSecret` — subsequent reads never expose them.
 */

import { eq, or, inArray, asc, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { createCache } from "@appstrate/core/cache";
import { spaces } from "@appstrate/db/schema";
import { oauthClient } from "@appstrate/db/schema";
import { prefixedId } from "../../../lib/ids.ts";
import { logger } from "../../../lib/logger.ts";
import { getAppstrateScopeSet, getEndUserScopeSet } from "../auth/scopes.ts";
import type { SpaceAssignment } from "@appstrate/core/permissions";
import { assertSpaceAssignmentsValid } from "../../../services/space-assignments.ts";
import type { AssignableOrgRole } from "@appstrate/shared-types";
import { isValidRedirectUri } from "./redirect-uri.ts";

// ─── SECURITY: Trust boundary ─────────────────────────────────────────────────
//
// This service layer is intentionally UNSCOPED. Functions that operate on a
// single client by `clientId` (getClient, updateClient, deleteClient,
// rotateClientSecret) perform NO ownership or tenancy filtering — they will
// act on any matching row regardless of which org owns it.
//
// The caller (route handler) MUST resolve ownership via `getClientOwningOrg`
// and verify it matches the authenticated org before invoking these
// functions. See the CRUD routes in `../routes.ts` for the canonical pattern:
//
//     const owning = await getClientOwningOrg(clientId);
//     if (!owning || owning !== orgId) throw notFound("OAuth client not found");
//     await deleteClient(clientId); // safe only after the guard above
//
// Why this shape: the multi-level (instance / org / space) model makes
// a single Drizzle predicate awkward — routes already know the authenticated
// org, so a post-fetch check is both simpler and more obviously correct than
// a compound WHERE clause. But it means a new caller that forgets the guard
// becomes an authorization bypass. If you add a new endpoint that mutates an
// OAuth client by id, the `getClientOwningOrg` check is REQUIRED.
//
// The only exception is the scoped list helper (`listClientsForOrgAndApps`)
// which filters by the caller's org/spaces at query time and is safe
// to expose directly.

export type OAuthClientLevel = "instance" | "org" | "space";

type OAuthAdminValidationField =
  "scopes" | "redirectUris" | "referencedOrgId" | "referencedSpaceId" | "signupPolicy";

export class OAuthAdminValidationError extends Error {
  readonly field: OAuthAdminValidationField;
  constructor(field: OAuthAdminValidationField, message: string) {
    super(message);
    this.name = "OAuthAdminValidationError";
    this.field = field;
  }
}

/**
 * The scopes in `scopes` that a client at `level` may not register — i.e.
 * exactly what {@link assertValidScopes} would refuse. Empty for a valid list,
 * and for `undefined`/empty input (nothing to validate, the caller's default
 * applies).
 *
 * The vocabulary is level-dependent because the token shape is: a space-level
 * client only ever mints `end_user` tokens, whose scopes are filtered through
 * the end-user allowlist at every mint, so a dashboard-only scope registered
 * there would be silently dropped forever. Instance and org clients get the
 * full vocabulary.
 *
 * Exported for `instance-client-sync.ts`, which must know whether a declaration
 * would SURVIVE a re-create before it tells an operator to delete a row and
 * restart. Answering that with a predicate rather than a catch keeps the
 * vocabulary in one place.
 */
export function invalidScopesIn(
  scopes: readonly string[] | undefined,
  level: OAuthClientLevel,
): string[] {
  if (!scopes || scopes.length === 0) return [];
  // OIDC owns its scope vocabulary directly (identity scopes + OIDC_ALLOWED_SCOPES
  // + the dashboard-only scopes, which space clients cannot carry).
  const allowed = level === "space" ? getEndUserScopeSet() : getAppstrateScopeSet();
  return scopes.filter((s) => !allowed.has(s));
}

/**
 * Reject any requested scope a client at `level` cannot register — outside the
 * OIDC vocabulary (identity scopes + `OIDC_ALLOWED_SCOPES` +
 * `OIDC_DASHBOARD_ONLY_SCOPES` + module `endUserGrantable` contributions), or,
 * for a space-level client, outside the end-user half of it.
 *
 * `undefined` / empty in — nothing to validate, the caller's own default
 * applies.
 */
function assertValidScopes(scopes: readonly string[] | undefined, level: OAuthClientLevel): void {
  const invalid = invalidScopesIn(scopes, level);
  if (invalid.length === 0) return;

  throw new OAuthAdminValidationError(
    "scopes",
    `OIDC: scopes rejected at service boundary for a ${level}-level client: ${invalid.join(", ")}. ` +
      `A space-level client may only register scopes an end-user token can carry ` +
      `(identity scopes + OIDC_ALLOWED_SCOPES); every other level may register the ` +
      `full OIDC vocabulary.`,
  );
}

function assertValidRedirectUris(uris: readonly string[]): void {
  if (uris.length === 0) {
    throw new OAuthAdminValidationError("redirectUris", "OIDC: at least one redirectUri required");
  }
  const bad = uris.filter((uri) => !isValidRedirectUri(uri));
  if (bad.length > 0) {
    throw new OAuthAdminValidationError(
      "redirectUris",
      `OIDC: redirectUri scheme or host not allowed: ${bad.join(", ")}`,
    );
  }
}

/**
 * OIDC Dynamic Registration §2 application type, derived from the redirect URIs
 * the caller registered. The provider validates every redirect URI against this
 * value and only a `native` client may declare an `http://` loopback callback —
 * which `isValidRedirectUri` admits, so hard-coding `web` here would refuse at
 * authorization time what registration accepted. Same rule the DCR register
 * hook applies (`auth/guards.ts`).
 */
function applicationTypeFor(redirectUris: readonly string[]): "web" | "native" {
  return redirectUris.some((uri) => uri.startsWith("http://")) ? "native" : "web";
}

export interface OAuthClientRecord {
  id: string;
  clientId: string;
  name: string | null;
  level: OAuthClientLevel;
  referencedOrgId: string | null;
  referencedSpaceId: string | null;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  scopes: string[];
  disabled: boolean;
  isFirstParty: boolean;
  /**
   * Unified signup opt-in across all levels (mirrors Auth0 "Disable Sign-Ups",
   * Keycloak "User Registration", Okta JIT toggle):
   *   - `instance`: brand-new Better Auth user may be created platform-wide.
   *   - `org`: brand-new BA user + auto-join to `referencedOrgId` with `signupRole`.
   *   - `space`: brand-new BA user + JIT `end_users` provisioning.
   * Defaults to `false` (secure-by-default) on every level.
   */
  allowSignup: boolean;
  /** Org-level: role assigned on auto-join. `owner` forbidden. Defaults to `"member"`. */
  signupRole: AssignableOrgRole;
  signupSpaceAssignments: ReadonlyArray<SpaceAssignment>;
  createdAt: string | null;
  updatedAt: string | null;
}

interface OAuthClientWithSecret extends OAuthClientRecord {
  clientSecret: string;
}

function mapRow(row: typeof oauthClient.$inferSelect): OAuthClientRecord {
  if (row.level !== "instance" && row.level !== "org" && row.level !== "space") {
    throw new Error(`OIDC: unexpected oauth_client.level value: ${String(row.level)}`);
  }
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    level: row.level,
    referencedOrgId: row.referencedOrgId ?? null,
    referencedSpaceId: row.referencedSpaceId ?? null,
    redirectUris: row.redirectUris ?? [],
    postLogoutRedirectUris: row.postLogoutRedirectUris ?? [],
    scopes: row.scopes ?? [],
    disabled: row.disabled ?? false,
    isFirstParty: row.skipConsent ?? false,
    allowSignup: row.allowSignup ?? false,
    signupRole: row.signupRole,
    signupSpaceAssignments: row.signupSpaceAssignments,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

function randomSecret(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function hashSecret(plaintext: string): Promise<string> {
  const data = new TextEncoder().encode(plaintext);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(new Uint8Array(digest)).toString("hex");
}

// Per-process TTL. An invalidation is broadcast to every replica through the
// platform cache bus, so a disabled client is dropped everywhere within a
// round trip; a lost broadcast leaves it cached for at most one TTL window
// on the replicas that missed it.
const CLIENT_CACHE_TTL_MS = 30_000;
// Hard ceiling on distinct cached entries. Because `getClientCached` also
// caches `null` for UNKNOWN clientIds (to soak up repeated probes), an
// attacker spraying random client_ids at any OIDC-authenticated endpoint
// would otherwise grow this Map without bound — a slow memory-exhaustion
// vector. The entry cap below keeps the cache bounded regardless of probe
// volume (oldest entry evicted past it).
const CLIENT_CACHE_MAX_ENTRIES = 10_000;
/**
 * `clientId` → record, or `null` for an unknown client (cached too, to soak
 * up repeated probes — the entry cap above bounds what a spray can allocate).
 * A `@appstrate/core/cache`: bounded, TTL'd, concurrent lookups of one client
 * coalesce, and an invalidation is broadcast to every replica through the
 * platform cache bus (`lib/cache-bus.ts`).
 */
const clientCache = createCache<OAuthClientRecord | null>({
  name: "oidc-oauth-client",
  ttlMs: CLIENT_CACHE_TTL_MS,
  max: CLIENT_CACHE_MAX_ENTRIES,
});

function cacheInvalidate(clientId: string): void {
  clientCache.invalidate(clientId);
}

/**
 * Cached variant of `getClient`. Safe for read-heavy hot paths (auth
 * strategy, page rendering). Returns `null` for unknown clientIds (also
 * cached to soak up probes for non-existent clients).
 */
export function getClientCached(clientId: string): Promise<OAuthClientRecord | null> {
  return clientCache.get(clientId, () => getClient(clientId));
}

/** @internal Test helper — drop every entry. */
export function _resetClientCache(): void {
  clientCache.clear();
}

// ─── Scope-filter helpers ─────────────────────────────────────────────────────
//
// Org-level clients are visible to any admin of the org. Space-level
// clients are visible to any admin of the org that owns the space.

/** Combined list for the admin UI — returns every client the caller's org can see in a single query. */
export async function listClientsForOrgAndApps(
  orgId: string,
  spaceIds: string[],
): Promise<OAuthClientRecord[]> {
  const conditions = [eq(oauthClient.referencedOrgId, orgId)];
  if (spaceIds.length > 0) {
    conditions.push(inArray(oauthClient.referencedSpaceId, spaceIds));
  }
  const rows = await db
    .select()
    .from(oauthClient)
    .where(or(...conditions));
  return rows.map(mapRow);
}

export async function getClient(clientId: string): Promise<OAuthClientRecord | null> {
  const [row] = await db
    .select()
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  return row ? mapRow(row) : null;
}

// ─── Create ───────────────────────────────────────────────────────────────────

interface CreateOrgClientInput {
  level: "org";
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
  scopes?: string[];
  referencedOrgId: string;
  isFirstParty?: boolean;
  /** Defaults to `false` at org level. */
  allowSignup?: boolean;
  /** Defaults to `"member"`. `owner` forbidden. */
  signupRole?: AssignableOrgRole;
  signupSpaceAssignments?: ReadonlyArray<SpaceAssignment>;
}

interface CreateSpaceClientInput {
  level: "space";
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
  scopes?: string[];
  referencedSpaceId: string;
  isFirstParty?: boolean;
  /** Defaults to `false`. When `true`, a first OIDC login JIT-creates a BA user + `end_users` row. */
  allowSignup?: boolean;
}

interface CreateInstanceClientInput {
  level: "instance";
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
  scopes?: string[];
  isFirstParty?: boolean;
  /** Defaults to `false`. Set explicitly by `ensureInstanceClient()`. */
  allowSignup?: boolean;
}

type CreateClientInput = CreateInstanceClientInput | CreateOrgClientInput | CreateSpaceClientInput;

export async function createClient(input: CreateClientInput): Promise<OAuthClientWithSecret> {
  assertValidRedirectUris(input.redirectUris);
  assertValidScopes(input.scopes, input.level);

  const id = prefixedId("oac");
  const clientId = `oauth_${randomSecret().slice(0, 24)}`;
  const plaintextSecret = randomSecret();
  const hashedSecret = await hashSecret(plaintextSecret);
  const now = new Date();

  // `signupRole` is only meaningful on org-level clients (role assigned on
  // auto-join). Space clients have no org membership to attach to;
  // instance clients have no fixed org to attach to either. Reject loudly
  // on the non-org levels to surface configuration mistakes.
  if (
    input.level !== "org" &&
    ((input as { signupRole?: unknown }).signupRole !== undefined ||
      (input as { signupSpaceAssignments?: unknown }).signupSpaceAssignments !== undefined)
  ) {
    throw new OAuthAdminValidationError(
      "signupPolicy",
      "OIDC: signupRole and signupSpaceAssignments are only valid for org-level clients",
    );
  }
  // `allowSignup` is honored on every level (unified Auth0/Keycloak/Okta
  // semantic). Defaults to `false` (secure-by-default); `ensureInstanceClient()`
  // opts in at boot to keep the fresh-install signup page open.
  const allowSignup = input.allowSignup ?? false;
  const signupRole: AssignableOrgRole =
    input.level === "org" ? (input.signupRole ?? "member") : "member";
  const signupSpaceAssignments = input.level === "org" ? (input.signupSpaceAssignments ?? []) : [];
  if (input.level === "org") {
    await assertSpaceAssignmentsValid({
      orgId: input.referencedOrgId,
      role: signupRole,
      assignments: signupSpaceAssignments,
      param: "signupSpaceAssignments",
    });
  }

  const inserted = await db
    .insert(oauthClient)
    .values({
      id,
      clientId,
      clientSecret: hashedSecret,
      name: input.name,
      redirectUris: input.redirectUris,
      postLogoutRedirectUris: input.postLogoutRedirectUris ?? [],
      scopes: input.scopes ?? ["openid", "profile", "email"],
      level: input.level,
      referencedOrgId: input.level === "org" ? input.referencedOrgId : null,
      referencedSpaceId: input.level === "space" ? input.referencedSpaceId : null,
      skipConsent: input.isFirstParty ?? false,
      allowSignup,
      signupRole,
      signupSpaceAssignments,
      disabled: false,
      applicationType: applicationTypeFor(input.redirectUris),
      tokenEndpointAuthMethod: "client_secret_basic",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      requirePKCE: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (inserted.length === 0) {
    throw new Error("OIDC: failed to insert oauth_clients row");
  }
  return { ...mapRow(inserted[0]!), clientSecret: plaintextSecret };
}

// ─── Self-service onboarding (DCR / CIMD) ──────────────────────────────────────

/**
 * Stamp a self-registered (RFC 7591 DCR or CIMD) OAuth client as a
 * self-service **instance** client.
 *
 * The native DCR insert and the CIMD plugin both bypass `createClient`, so the
 * row arrives with no platform discriminator. `level = "instance"` lets it mint
 * instance tokens; `self_service = true` is what `/oauth2/token` reads to
 * confine those tokens to a single protected resource — the discriminator
 * between an operator-provisioned instance client (the dashboard SPA / CLI,
 * which may target the platform audience) and a self-registered one, which may
 * not.
 *
 * Both are columns, never the `metadata` JSON: the provider owns that JSON and
 * a registration body may set it, so a flag kept there is a flag the client can
 * name. Idempotent — a refreshed CIMD client is re-stamped on every resolution.
 *
 * It writes exactly those two columns and NEVER `scopes` (issue #1351). This
 * function once backfilled the scope set from the CIMD document, to work around
 * a Better Auth < 1.7.3 bug where the first resolution handed `/authorize` a
 * client row with `scopes: []` and the request bounced with `invalid_scope`.
 * That bug is fixed upstream — `persistOAuthClientRegistration` now writes the
 * self-service ceiling in the same statement that creates the row — and the
 * backfill was removed in #1287. Do not restore it: it is a path where the
 * CLIENT decides its own persisted scope set, which is the ceiling `/authorize`
 * enforces. The recorded symptom "CIMD 1st hit = invalid_scope" is not a reason
 * to bring it back; `test/integration/services/dcr-cimd.test.ts` pins both the
 * first-resolution flow and this function leaving `scopes` alone.
 */
export async function markClientSelfService(clientId: string): Promise<void> {
  await db
    .update(oauthClient)
    .set({ selfService: true, level: "instance", updatedAt: new Date() })
    .where(eq(oauthClient.clientId, clientId));
  cacheInvalidate(clientId);
}

// ─── Update / delete / rotate ─────────────────────────────────────────────────

export async function deleteClient(clientId: string): Promise<OAuthClientRecord | null> {
  const [row] = await db.delete(oauthClient).where(eq(oauthClient.clientId, clientId)).returning();
  cacheInvalidate(clientId);
  return row ? mapRow(row) : null;
}

export async function rotateClientSecret(clientId: string): Promise<OAuthClientWithSecret | null> {
  const plaintextSecret = randomSecret();
  const hashedSecret = await hashSecret(plaintextSecret);
  const [row] = await db
    .update(oauthClient)
    .set({ clientSecret: hashedSecret, updatedAt: new Date() })
    .where(eq(oauthClient.clientId, clientId))
    .returning();
  cacheInvalidate(clientId);
  return row ? { ...mapRow(row), clientSecret: plaintextSecret } : null;
}

interface UpdateClientInput {
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
  scopes?: string[];
  disabled?: boolean;
  isFirstParty?: boolean;
  /** Honored on every level (unified semantic). */
  allowSignup?: boolean;
  /** Honored only on org-level clients; rejected on instance/space. `owner` forbidden. */
  signupRole?: AssignableOrgRole;
  signupSpaceAssignments?: ReadonlyArray<SpaceAssignment>;
}

export async function updateClient(
  clientId: string,
  input: UpdateClientInput,
): Promise<OAuthClientRecord | null> {
  if (input.redirectUris !== undefined) {
    assertValidRedirectUris(input.redirectUris);
  }
  // Both the scope vocabulary and the signup-policy rules depend on the
  // client's level, which only the stored row knows — read it once when either
  // is in play, and not at all otherwise.
  const existing =
    input.scopes !== undefined ||
    input.signupRole !== undefined ||
    input.signupSpaceAssignments !== undefined
      ? await getClient(clientId)
      : null;

  if (input.scopes !== undefined) {
    if (!existing) return null;
    assertValidScopes(input.scopes, existing.level);
  }

  // `signupRole` is only meaningful on org-level clients — reject updates
  // targeting instance/space levels loudly so configuration mistakes
  // surface. `allowSignup` is valid on every level.
  if (input.signupRole !== undefined || input.signupSpaceAssignments !== undefined) {
    if (!existing) return null;
    if (existing.level !== "org" || !existing.referencedOrgId) {
      throw new OAuthAdminValidationError(
        "signupPolicy",
        "OIDC: signupRole and signupSpaceAssignments are only valid for org-level clients",
      );
    }
    await assertSpaceAssignmentsValid({
      orgId: existing.referencedOrgId,
      role: input.signupRole ?? existing.signupRole,
      assignments: input.signupSpaceAssignments ?? existing.signupSpaceAssignments,
      param: "signupSpaceAssignments",
    });
  }

  // Build a single SET clause — atomic, no partial-update risk.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.redirectUris !== undefined) set.redirectUris = input.redirectUris;
  if (input.postLogoutRedirectUris !== undefined)
    set.postLogoutRedirectUris = input.postLogoutRedirectUris;
  if (input.scopes !== undefined) set.scopes = input.scopes;
  if (input.disabled !== undefined) set.disabled = input.disabled;
  if (input.isFirstParty !== undefined) set.skipConsent = input.isFirstParty;
  if (input.allowSignup !== undefined) set.allowSignup = input.allowSignup;
  if (input.signupRole !== undefined) set.signupRole = input.signupRole;
  if (input.signupSpaceAssignments !== undefined)
    set.signupSpaceAssignments = input.signupSpaceAssignments;

  const [row] = await db
    .update(oauthClient)
    .set(set)
    .where(eq(oauthClient.clientId, clientId))
    .returning();
  if (!row) return null;
  cacheInvalidate(clientId);
  return mapRow(row);
}

/**
 * Resolve the effective "owning entity" for a client — the org id for
 * org-level clients, or the org id derived from the space FK for
 * space-level clients. Used by route-level permission checks that
 * need to ensure the caller is an admin of the org that owns the client.
 *
 * Single `LEFT JOIN` so we never issue two sequential round-trips for
 * space-level clients — this function runs on every CRUD route
 * (`GET /:id`, `PATCH /:id`, `DELETE /:id`, `POST /:id/rotate`) and is
 * latency-sensitive. The join is cheap: `spaces.id` is the primary
 * key and the FK is covered by an index from the initial migration.
 */
export async function getClientOwningOrg(clientId: string): Promise<string | null> {
  const [row] = await db
    .select({
      level: oauthClient.level,
      referencedOrgId: oauthClient.referencedOrgId,
      spaceOrgId: spaces.orgId,
    })
    .from(oauthClient)
    .leftJoin(spaces, eq(spaces.id, oauthClient.referencedSpaceId))
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  if (!row) return null;
  // Instance clients are system-level — they have no owning org.
  if (row.level === "instance") return null;
  if (row.level === "org") return row.referencedOrgId;
  if (row.level === "space") return row.spaceOrgId ?? null;
  return null;
}

// ─── Instance client helpers ──────────────────────────────────────────────────

/**
 * Lookup the platform SPA instance-level client's `clientId`.
 *
 * Consumed by `oidcModule.appConfigContribution()` to publish the platform
 * SPA's OIDC config. With `OIDC_INSTANCE_CLIENTS`, multiple
 * instance-level clients can coexist (the platform one + env-provisioned
 * satellites). `ensureInstanceClient()` runs BEFORE `syncInstanceClientsFromEnv()`
 * in `oidcModule.init()`, so the platform client always carries the earliest
 * `created_at` — `ORDER BY created_at ASC LIMIT 1` is therefore deterministic
 * and returns the platform client regardless of how many satellites are
 * declared in the env.
 */
/**
 * Snapshot all first-party (`skip_consent = true`) clientIds at boot. Fed to
 * `oauthProvider({ cachedTrustedClients })` so the plugin's hot-path skips a
 * DB lookup on each authorize call. The cache is a static snapshot — clients
 * promoted to first-party post-boot fall back to the regular DB lookup until
 * the next restart, which is fine: `skipConsent` flips are operationally rare.
 */
export async function listFirstPartyClientIds(): Promise<string[]> {
  const rows = await db
    .select({ clientId: oauthClient.clientId })
    .from(oauthClient)
    .where(eq(oauthClient.skipConsent, true));
  return rows.map((r) => r.clientId);
}

export async function getInstanceClientId(): Promise<string | null> {
  const [row] = await db
    .select({ clientId: oauthClient.clientId })
    .from(oauthClient)
    .where(eq(oauthClient.level, "instance"))
    .orderBy(asc(oauthClient.createdAt))
    .limit(1);
  return row?.clientId ?? null;
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const v of b) {
    if (!set.has(v)) return false;
  }
  return true;
}

/**
 * Auto-provision the instance-level OIDC client for the platform SPA.
 *
 * Idempotent on presence AND reconciles `redirectUris` /
 * `postLogoutRedirectUris` against the current `APP_URL` on every boot,
 * plus the public-client auth shape (`public=true`,
 * `tokenEndpointAuthMethod="none"`, `clientSecret=null`). When the
 * operator changes `APP_URL` (domain move, placeholder → real URL on
 * first setup), the existing row is updated in place — same
 * `client_id`, so outstanding tokens and live sessions remain valid.
 *
 * Auth-shape reconciliation is what upgrades pre-#154 installs. Before
 * that PR the platform SPA was provisioned as a confidential client
 * (`tokenEndpointAuthMethod="client_secret_basic"` + hashed
 * `clientSecret`). The create path now provisions it as public + PKCE,
 * but existing rows were left stuck as confidential — every SPA OIDC
 * token exchange then failed with `invalid_client: client secret must
 * be provided`. The existing-row path below converges the stored shape
 * to the public-client contract.
 *
 * Without this reconciliation the dashboard SPA would loop on
 * `/api/auth/oauth2/authorize` after a URL change and eventually hit
 * the per-IP rate limit (see `auth/guards.ts` `AUTHORIZE_RL_POINTS`),
 * forcing operators to wipe the DB to recover.
 *
 * ## Concurrency
 *
 * The SELECT+UPDATE is not transactional. Under multi-replica boot, both
 * replicas may detect drift and both issue the UPDATE — benign, since
 * both compute identical expected values from the same `APP_URL` env
 * var and the same public-client constants (last-write-wins with
 * identical payloads). No coordination primitive required.
 *
 * ## Cache propagation across replicas
 *
 * `cacheInvalidate()` clears the local entry and broadcasts the
 * invalidation on the platform cache bus (`lib/cache-bus.ts`), so other
 * replicas drop theirs within a round trip. A lost broadcast falls back
 * to one TTL window (~30s, `CLIENT_CACHE_TTL_MS`) — acceptable because
 * reconciliation only happens at boot, and all replicas boot with the
 * same `APP_URL` and therefore reconcile independently.
 *
 * Called from `oidcModule.init()` at boot.
 *
 * The platform SPA is a **public** OAuth client: it runs in a browser
 * and cannot hold a `client_secret` (any value shipped in the JS bundle
 * is publicly readable, so OAuth 2.1 RFC 9700 § 2.2 mandates treating
 * SPAs as public clients). PKCE is the proof-of-possession. We bypass
 * `createClient` here because that helper hard-codes `client_secret_basic`
 * + a hashed secret for confidential clients — the SPA has no way to
 * send the Basic header, so the token exchange would 400 on
 * `invalid_client`. Direct insert keeps the confidential defaults
 * correct for every other caller.
 *
 * The platform auto-provisioned instance client also opts into open
 * signup at boot so a fresh Appstrate install can register its first
 * user. Every other client (env-declared satellites, org tenants,
 * space clients) keeps the closed `allowSignup: false` default.
 */
export async function ensureInstanceClient(appUrl: string): Promise<string> {
  // Normalize: strip trailing slash(es) so `APP_URL=https://x.com/` does
  // not produce `https://x.com//auth/callback`. Reconciliation on an
  // already-created-with-trailing-slash row will also now converge to
  // the normalized form.
  const normalizedAppUrl = appUrl.replace(/\/+$/, "");
  const expectedRedirectUris = [`${normalizedAppUrl}/auth/callback`];
  const expectedPostLogoutRedirectUris = [normalizedAppUrl, `${normalizedAppUrl}/login`];

  // Same validation policy as the create path below (and as every other
  // callsite of `assertValidRedirectUris`): reject loopback-in-prod,
  // bad schemes, etc. Keeps the update path from silently writing a
  // value the create path would refuse, should `isValidRedirectUri`
  // ever tighten its rules.
  assertValidRedirectUris(expectedRedirectUris);

  // Race-safety: the check-then-insert below is not atomic on its own. On a
  // multi-replica boot two processes both SELECT (no instance client), both
  // fall through, and both INSERT — leaving DUPLICATE platform clients (each
  // with a distinct random `client_id`, so no natural unique key catches it,
  // and the schema is owned by core so we cannot add a partial unique index
  // from here). Serialize the whole check-reconcile-insert under a DB-global
  // transaction-scoped advisory lock (same primitive core migrations and run
  // concurrency use, PGlite-compatible). The second replica blocks on the
  // lock, then observes the row the first inserted and reconciles/returns it.
  // The cache drop is broadcast to other replicas, so it must follow the
  // commit: a replica told to drop while the UPDATE is still uncommitted
  // re-reads the old row and re-caches it.
  let reconciledClientId: string | null = null;
  const instanceClientId = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('oidc:instance-client')::bigint)`);

    const [existing] = await tx
      .select({
        clientId: oauthClient.clientId,
        redirectUris: oauthClient.redirectUris,
        postLogoutRedirectUris: oauthClient.postLogoutRedirectUris,
        tokenEndpointAuthMethod: oauthClient.tokenEndpointAuthMethod,
        clientSecret: oauthClient.clientSecret,
      })
      .from(oauthClient)
      .where(eq(oauthClient.level, "instance"))
      .orderBy(asc(oauthClient.createdAt))
      .limit(1);

    if (existing) {
      const storedPostLogout = existing.postLogoutRedirectUris ?? [];
      const redirectDrift = !sameStringSet(existing.redirectUris, expectedRedirectUris);
      const postLogoutDrift = !sameStringSet(storedPostLogout, expectedPostLogoutRedirectUris);
      // `tokenEndpointAuthMethod === "none"` IS the public-client contract —
      // it is the value the provider derives "public" from, and the one that
      // makes it demand PKCE.
      const authMethodDrift =
        existing.tokenEndpointAuthMethod !== "none" || existing.clientSecret !== null;

      if (redirectDrift || postLogoutDrift || authMethodDrift) {
        await tx
          .update(oauthClient)
          .set({
            redirectUris: expectedRedirectUris,
            postLogoutRedirectUris: expectedPostLogoutRedirectUris,
            ...(authMethodDrift
              ? {
                  tokenEndpointAuthMethod: "none" as const,
                  clientSecret: null,
                }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(oauthClient.clientId, existing.clientId));
        reconciledClientId = existing.clientId;
        logger.warn("OIDC platform client reconciled to match APP_URL and public-client contract", {
          module: "oidc",
          clientId: existing.clientId,
          appUrl: normalizedAppUrl,
          redirectUrisFrom: existing.redirectUris,
          redirectUrisTo: expectedRedirectUris,
          postLogoutRedirectUrisFrom: storedPostLogout,
          postLogoutRedirectUrisTo: expectedPostLogoutRedirectUris,
          tokenEndpointAuthMethodFrom: existing.tokenEndpointAuthMethod,
          tokenEndpointAuthMethodTo: authMethodDrift ? "none" : existing.tokenEndpointAuthMethod,
          clientSecretCleared: authMethodDrift && existing.clientSecret !== null,
        });
      }
      return existing.clientId;
    }

    const id = prefixedId("oac");
    const clientId = `oauth_${randomSecret().slice(0, 24)}`;
    const now = new Date();

    await tx.insert(oauthClient).values({
      id,
      clientId,
      clientSecret: null,
      name: "Appstrate Platform",
      redirectUris: expectedRedirectUris,
      postLogoutRedirectUris: expectedPostLogoutRedirectUris,
      scopes: ["openid", "profile", "email", "offline_access"],
      level: "instance",
      referencedOrgId: null,
      referencedSpaceId: null,
      skipConsent: true,
      allowSignup: true,
      signupRole: "member",
      disabled: false,
      applicationType: applicationTypeFor(expectedRedirectUris),
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      requirePKCE: true,
      createdAt: now,
      updatedAt: now,
    });
    return clientId;
  });
  if (reconciledClientId) cacheInvalidate(reconciledClientId);
  return instanceClientId;
}

// ─── Env-provisioned instance clients ─────────────────────────────────────────
//
// Satellite apps (admin dashboards, second-party web apps) are declared in
// `OIDC_INSTANCE_CLIENTS` and materialized here. Unlike
// `createClient`, the operator supplies both `clientId` and `clientSecret`
// out-of-band — no HTTP surface, no admin route. See
// `services/instance-client-sync.ts` for the boot sync driver.

export interface CreateInstanceClientFromEnvInput {
  /** Operator-chosen stable identifier. Becomes the OAuth `client_id`. */
  clientId: string;
  /** Operator-supplied secret. Hashed at insert; never stored in plaintext. */
  clientSecretPlaintext: string;
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  scopes: string[];
  /** Skip the consent screen for this client (first-party semantic). */
  skipConsent: boolean;
  /**
   * Whether BA should let a brand-new user sign up through this client.
   * Mutable policy — re-synced by `updateInstanceClientPolicyFromEnv` on
   * every boot, so an operator can toggle it in env without touching the
   * DB. Defaults to `false` upstream in the Zod schema.
   */
  allowSignup: boolean;
}

/**
 * Insert a new instance-level OAuth client using operator-supplied
 * `clientId` + `clientSecret`. The secret is hashed with `hashSecret()`
 * before insert and is never echoed back (contrast with `createClient()`,
 * which returns the plaintext).
 *
 * Throws `OAuthAdminValidationError` on bad `redirectUris` / `scopes`.
 * The caller is responsible for checking that no row with this `clientId`
 * already exists — this function will surface a DB unique-constraint
 * violation otherwise.
 */
export async function createInstanceClientFromEnv(
  input: CreateInstanceClientFromEnvInput,
): Promise<OAuthClientRecord> {
  assertValidRedirectUris(input.redirectUris);
  assertValidScopes(input.scopes, "instance");

  const id = prefixedId("oac");
  const hashedSecret = await hashSecret(input.clientSecretPlaintext);
  const now = new Date();

  const inserted = await db
    .insert(oauthClient)
    .values({
      id,
      clientId: input.clientId,
      clientSecret: hashedSecret,
      name: input.name,
      redirectUris: input.redirectUris,
      postLogoutRedirectUris: input.postLogoutRedirectUris,
      scopes: input.scopes,
      level: "instance",
      referencedOrgId: null,
      referencedSpaceId: null,
      skipConsent: input.skipConsent,
      allowSignup: input.allowSignup,
      signupRole: "member",
      disabled: false,
      applicationType: applicationTypeFor(input.redirectUris),
      tokenEndpointAuthMethod: "client_secret_basic",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      requirePKCE: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (inserted.length === 0) {
    throw new Error("OIDC: failed to insert oauth_clients row from env declaration");
  }
  return mapRow(inserted[0]!);
}

interface InstanceClientDriftMismatch {
  field: string;
  stored: unknown;
  declared: unknown;
}

type InstanceClientDriftResult =
  | { kind: "not-found" }
  | { kind: "wrong-level"; storedLevel: string }
  | { kind: "match" }
  | { kind: "drift"; mismatches: InstanceClientDriftMismatch[] };

function setEquals(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  for (const v of b) if (!setA.has(v)) return false;
  return true;
}

/**
 * Compare a declared env-provisioned instance client against its stored row.
 *
 * - `not-found`: no row with this `clientId` exists.
 * - `wrong-level`: a row exists but its `level` is not `"instance"` — caller
 *   should refuse to operate on it (it belongs to an org/space client
 *   with the same `clientId`, which is an authorization-critical collision).
 * - `match`: every managed field matches.
 * - `drift`: managed fields differ — caller should fail boot with the list.
 *
 * Managed fields: `name`, `redirectUris`, `postLogoutRedirectUris`, `scopes`,
 * `skipConsent`, `clientSecret` hash. Order-insensitive for array fields.
 */
export async function compareDeclaredClientWithStored(
  declared: CreateInstanceClientFromEnvInput,
): Promise<InstanceClientDriftResult> {
  const [row] = await db
    .select()
    .from(oauthClient)
    .where(eq(oauthClient.clientId, declared.clientId))
    .limit(1);
  if (!row) return { kind: "not-found" };
  if (row.level !== "instance") {
    return { kind: "wrong-level", storedLevel: row.level };
  }

  const mismatches: InstanceClientDriftMismatch[] = [];

  if (row.name !== declared.name) {
    mismatches.push({ field: "name", stored: row.name, declared: declared.name });
  }
  if (!setEquals(row.redirectUris ?? [], declared.redirectUris)) {
    mismatches.push({
      field: "redirectUris",
      stored: row.redirectUris ?? [],
      declared: declared.redirectUris,
    });
  }
  if (!setEquals(row.postLogoutRedirectUris ?? [], declared.postLogoutRedirectUris)) {
    mismatches.push({
      field: "postLogoutRedirectUris",
      stored: row.postLogoutRedirectUris ?? [],
      declared: declared.postLogoutRedirectUris,
    });
  }
  // Exact comparison, deliberately: a divergence from the stored row is
  // reported, never absorbed by an alias. What a `scopes` divergence must NOT
  // do is fall through to the generic "delete the row and restart" remedy when
  // the declared list would not survive the re-create — that is destructive AND
  // useless, since the re-create trips `assertValidScopes` on the same env
  // value. `syncInstanceClientsFromEnv` checks that with `invalidScopesIn`
  // before offering the remedy.
  if (!setEquals(row.scopes ?? [], declared.scopes)) {
    mismatches.push({
      field: "scopes",
      stored: row.scopes ?? [],
      declared: declared.scopes,
    });
  }
  if ((row.skipConsent ?? false) !== declared.skipConsent) {
    mismatches.push({
      field: "skipConsent",
      stored: row.skipConsent ?? false,
      declared: declared.skipConsent,
    });
  }
  const declaredSecretHash = await hashSecret(declared.clientSecretPlaintext);
  if (row.clientSecret !== declaredSecretHash) {
    // Never leak the hashes themselves in the mismatch — just signal the
    // field. A drift on the secret means the operator rotated it; the new
    // value is already visible in their env.
    mismatches.push({
      field: "clientSecret",
      stored: "<hash>",
      declared: "<hash>",
    });
  }

  if (mismatches.length === 0) return { kind: "match" };
  return { kind: "drift", mismatches };
}

/**
 * Idempotently update the mutable signup policy fields on an env-declared
 * instance client. Called by `syncInstanceClientsFromEnv` on every boot so
 * `allowSignup` is always authoritative from env — unlike structural fields
 * (name, redirectUris, secret, …) where drift is fatal, a policy flag is
 * designed to be toggled without touching the DB.
 *
 * Also invalidates the `getClientCached` entry so the new value is visible
 * to `loadClientSignupPolicy` (and the magic-link pre-check in
 * `auth/guards.ts`) on the next request rather than after a 30s TTL.
 */
export async function updateInstanceClientPolicyFromEnv(
  clientId: string,
  policy: { allowSignup: boolean },
): Promise<void> {
  await db
    .update(oauthClient)
    .set({ allowSignup: policy.allowSignup, updatedAt: new Date() })
    .where(eq(oauthClient.clientId, clientId));
  cacheInvalidate(clientId);
}

/**
 * List every instance-level client's `clientId`. Used by the env sync to
 * detect orphans (clients present in DB but not in the current env
 * declaration). Returns `clientId` only to keep the row small.
 */
export async function listInstanceClientIds(): Promise<string[]> {
  const rows = await db
    .select({ clientId: oauthClient.clientId })
    .from(oauthClient)
    .where(eq(oauthClient.level, "instance"));
  return rows.map((r) => r.clientId);
}
