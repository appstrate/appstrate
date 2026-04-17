// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth client admin service — polymorphic org + application clients.
 *
 * Direct CRUD against `oauth_clients`. Each client is scoped at one of three
 * levels:
 *
 *   - `instance`: platform-wide, no org/app FK (the platform dashboard SPA)
 *   - `org`: pinned to an organization via `referenced_org_id` (dashboard
 *     users are the actors)
 *   - `application`: pinned to an application via `referenced_application_id`
 *     (end-users are the actors)
 *
 * A DB-level CHECK constraint guarantees exactly one of the two FKs is set
 * based on `level` (or neither for instance), so "mixed" clients are
 * unrepresentable.
 *
 * Why we bypass `auth.api.adminCreateOAuthClient`: the plugin derives its
 * `reference_id` via `clientReference({ session })` which doesn't have
 * access to Appstrate's multi-tenant context. We write directly to the
 * Drizzle schema and stash the polymorphic fields into the plugin-readable
 * `metadata` JSON column so the `customAccessTokenClaims` closure can
 * branch on them at token-mint time.
 *
 * `metadata` shape (single source of truth readable by the plugin):
 *   {
 *     level: "instance" | "org" | "application",
 *     referencedOrgId?: string,
 *     referencedApplicationId?: string,
 *   }
 *
 * The same values are also persisted in dedicated SQL columns for query
 * performance + FK integrity. Writes keep both in lockstep.
 *
 * Secrets are generated as base64url-encoded random bytes, hashed with
 * SHA-256 at rest, and only returned in plaintext from `createClient` /
 * `rotateClientSecret` — subsequent reads never expose them.
 */

import { eq, or, inArray, asc } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applications } from "@appstrate/db/schema";
import { oauthClient } from "../schema.ts";
import { prefixedId } from "../../../lib/ids.ts";
import { logger } from "../../../lib/logger.ts";
import { APPSTRATE_SCOPES } from "../auth/scopes.ts";
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
// Why this shape: the multi-level (instance / org / application) model makes
// a single Drizzle predicate awkward — routes already know the authenticated
// org, so a post-fetch check is both simpler and more obviously correct than
// a compound WHERE clause. But it means a new caller that forgets the guard
// becomes an authorization bypass. If you add a new endpoint that mutates an
// OAuth client by id, the `getClientOwningOrg` check is REQUIRED.
//
// The only exception are the scoped list helpers (`listClientsForOrg`,
// `listClientsForApp`, `listClientsForOrgAndApps`) which filter by the
// caller's org/applications at query time and are safe to expose directly.

export type OAuthClientLevel = "instance" | "org" | "application";

export type OAuthAdminValidationField =
  | "scopes"
  | "redirectUris"
  | "referencedOrgId"
  | "referencedApplicationId"
  | "signupPolicy";

export class OAuthAdminValidationError extends Error {
  readonly field: OAuthAdminValidationField;
  constructor(field: OAuthAdminValidationField, message: string) {
    super(message);
    this.name = "OAuthAdminValidationError";
    this.field = field;
  }
}

const APPSTRATE_SCOPE_SET = new Set<string>(APPSTRATE_SCOPES);

function assertValidScopes(scopes: readonly string[] | undefined): void {
  if (!scopes || scopes.length === 0) return;
  const invalid = scopes.filter((s) => !APPSTRATE_SCOPE_SET.has(s));
  if (invalid.length > 0) {
    throw new OAuthAdminValidationError(
      "scopes",
      `OIDC: unknown scopes rejected at service boundary: ${invalid.join(", ")}. ` +
        `Only scopes in APPSTRATE_SCOPES (identity scopes + OIDC_ALLOWED_SCOPES) may be registered.`,
    );
  }
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
 * Role allowlist for org-level auto-provisioning. `owner` is intentionally
 * excluded at the service, DB, and UI layers: self-promotion to owner via a
 * misconfigured client is an unacceptable operational risk. Admins who
 * genuinely need a new owner must promote after the fact.
 */
export const SIGNUP_ROLE_ALLOWED = ["admin", "member", "viewer"] as const;
export type SignupRole = (typeof SIGNUP_ROLE_ALLOWED)[number];

export interface OAuthClientRecord {
  id: string;
  clientId: string;
  name: string | null;
  level: OAuthClientLevel;
  referencedOrgId: string | null;
  referencedApplicationId: string | null;
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
   *   - `application`: brand-new BA user + JIT `end_users` provisioning.
   * Defaults to `false` (secure-by-default) on every level.
   */
  allowSignup: boolean;
  /** Org-level: role assigned on auto-join. `owner` forbidden. Defaults to `"member"`. */
  signupRole: SignupRole;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface OAuthClientWithSecret extends OAuthClientRecord {
  clientSecret: string;
}

function mapRow(row: typeof oauthClient.$inferSelect): OAuthClientRecord {
  if (row.level !== "instance" && row.level !== "org" && row.level !== "application") {
    throw new Error(`OIDC: unexpected oauth_client.level value: ${String(row.level)}`);
  }
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    level: row.level,
    referencedOrgId: row.referencedOrgId ?? null,
    referencedApplicationId: row.referencedApplicationId ?? null,
    redirectUris: row.redirectUris ?? [],
    postLogoutRedirectUris: row.postLogoutRedirectUris ?? [],
    scopes: row.scopes ?? [],
    disabled: row.disabled ?? false,
    isFirstParty: row.skipConsent ?? false,
    allowSignup: row.allowSignup ?? false,
    signupRole: row.signupRole as SignupRole,
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

// ─── Short-TTL client cache ───────────────────────────────────────────────────
//
// The OIDC auth strategy hits `getClient()` on every authenticated request to
// verify the client is still enabled (defense-in-depth against stale tokens
// from disabled clients). That would put a DB round-trip on the hot path of
// every API call authenticated via OIDC. The server-rendered login/consent
// pages also re-read the same client across a GET → POST pair, adding two
// more queries per browser login.
//
// Solution: a tiny in-process TTL cache keyed by `clientId`. Reads fall
// through on miss or expiry; mutations (update / delete / rotate) invalidate
// the entry synchronously so `updateClient(id, { disabled: true })` takes
// effect immediately on the next request instead of waiting out the TTL.
// `createClient` does NOT need to invalidate because new `clientId` values
// are guaranteed to be absent from the map.
//
// Best-effort only: the cache lives per-process, so in a multi-replica
// deployment a disabled client may remain cached for up to TTL on OTHER
// replicas. That is acceptable — the worst-case window is one TTL, and the
// mutation path is already rare compared to the read path it protects.
const CLIENT_CACHE_TTL_MS = 30_000;
const clientCache = new Map<string, { record: OAuthClientRecord | null; expiresAt: number }>();

function cacheInvalidate(clientId: string): void {
  clientCache.delete(clientId);
}

/**
 * Cached variant of `getClient`. Safe for read-heavy hot paths (auth
 * strategy, page rendering). Returns `null` for unknown clientIds (also
 * cached to soak up probes for non-existent clients).
 */
export async function getClientCached(clientId: string): Promise<OAuthClientRecord | null> {
  const now = Date.now();
  const cached = clientCache.get(clientId);
  if (cached && cached.expiresAt > now) return cached.record;
  const record = await getClient(clientId);
  clientCache.set(clientId, { record, expiresAt: now + CLIENT_CACHE_TTL_MS });
  return record;
}

/** @internal Test helper — drop every entry. */
export function _resetClientCache(): void {
  clientCache.clear();
}

// ─── Scope-filter helpers ─────────────────────────────────────────────────────
//
// Org-level clients are visible to any admin of the org. Application-level
// clients are visible to any admin of the org that owns the application.

export async function listClientsForOrg(orgId: string): Promise<OAuthClientRecord[]> {
  const rows = await db.select().from(oauthClient).where(eq(oauthClient.referencedOrgId, orgId));
  return rows.map(mapRow);
}

export async function listClientsForApp(applicationId: string): Promise<OAuthClientRecord[]> {
  const rows = await db
    .select()
    .from(oauthClient)
    .where(eq(oauthClient.referencedApplicationId, applicationId));
  return rows.map(mapRow);
}

/** Combined list for the admin UI — returns every client the caller's org can see in a single query. */
export async function listClientsForOrgAndApps(
  orgId: string,
  applicationIds: string[],
): Promise<OAuthClientRecord[]> {
  const conditions = [eq(oauthClient.referencedOrgId, orgId)];
  if (applicationIds.length > 0) {
    conditions.push(inArray(oauthClient.referencedApplicationId, applicationIds));
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

export interface CreateOrgClientInput {
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
  signupRole?: SignupRole;
}

export interface CreateApplicationClientInput {
  level: "application";
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
  scopes?: string[];
  referencedApplicationId: string;
  isFirstParty?: boolean;
  /** Defaults to `false`. When `true`, a first OIDC login JIT-creates a BA user + `end_users` row. */
  allowSignup?: boolean;
}

export interface CreateInstanceClientInput {
  level: "instance";
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
  scopes?: string[];
  isFirstParty?: boolean;
  /** Defaults to `false`. Set explicitly by `ensureInstanceClient()`. */
  allowSignup?: boolean;
}

export type CreateClientInput =
  | CreateInstanceClientInput
  | CreateOrgClientInput
  | CreateApplicationClientInput;

export async function createClient(input: CreateClientInput): Promise<OAuthClientWithSecret> {
  assertValidRedirectUris(input.redirectUris);
  assertValidScopes(input.scopes);

  const id = prefixedId("oac");
  const clientId = `oauth_${randomSecret().slice(0, 24)}`;
  const plaintextSecret = randomSecret();
  const hashedSecret = await hashSecret(plaintextSecret);
  const now = new Date();

  // `clientId` is stashed alongside the polymorphic fields so the
  // `customAccessTokenClaims` closure can recover the client identity from
  // its `metadata` argument (Better Auth's oauth-provider plugin does not
  // pass `client.clientId` to the closure directly). Immutable — the unique
  // `client_id` column never changes for the client's lifetime, so no
  // drift with the SQL column.
  const metadata: Record<string, unknown> = { level: input.level, clientId };
  if (input.level === "org") {
    metadata.referencedOrgId = input.referencedOrgId;
  } else if (input.level === "application") {
    metadata.referencedApplicationId = input.referencedApplicationId;
  }
  // instance: no FK fields in metadata

  // `signupRole` is only meaningful on org-level clients (role assigned on
  // auto-join). Application clients have no org membership to attach to;
  // instance clients have no fixed org to attach to either. Reject loudly
  // on the non-org levels to surface configuration mistakes.
  if (input.level !== "org" && (input as { signupRole?: unknown }).signupRole !== undefined) {
    throw new OAuthAdminValidationError(
      "signupPolicy",
      "OIDC: signupRole is only valid for org-level clients",
    );
  }
  // `allowSignup` is honored on every level (unified Auth0/Keycloak/Okta
  // semantic). Defaults to `false` (secure-by-default); `ensureInstanceClient()`
  // opts in at boot to keep the fresh-install signup page open.
  const allowSignup = input.allowSignup ?? false;
  const signupRole: SignupRole = input.level === "org" ? (input.signupRole ?? "member") : "member";

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
      referencedApplicationId: input.level === "application" ? input.referencedApplicationId : null,
      metadata: JSON.stringify(metadata),
      skipConsent: input.isFirstParty ?? false,
      allowSignup,
      signupRole,
      disabled: false,
      type: "web",
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

export interface UpdateClientInput {
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
  scopes?: string[];
  disabled?: boolean;
  isFirstParty?: boolean;
  /** Honored on every level (unified semantic). */
  allowSignup?: boolean;
  /** Honored only on org-level clients; rejected on instance/application. `owner` forbidden. */
  signupRole?: SignupRole;
}

export async function updateClient(
  clientId: string,
  input: UpdateClientInput,
): Promise<OAuthClientRecord | null> {
  if (input.redirectUris !== undefined) {
    assertValidRedirectUris(input.redirectUris);
  }
  if (input.scopes !== undefined) {
    assertValidScopes(input.scopes);
  }

  // `signupRole` is only meaningful on org-level clients — reject updates
  // targeting instance/application levels loudly so configuration mistakes
  // surface. `allowSignup` is valid on every level.
  if (input.signupRole !== undefined) {
    const existing = await getClient(clientId);
    if (existing && existing.level !== "org") {
      throw new OAuthAdminValidationError(
        "signupPolicy",
        "OIDC: signupRole is only valid for org-level clients",
      );
    }
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

  const [row] = await db
    .update(oauthClient)
    .set(set)
    .where(eq(oauthClient.clientId, clientId))
    .returning();
  if (!row) return null;
  cacheInvalidate(clientId);
  // No metadata re-sync needed: none of the `UpdateClientInput` fields
  // (redirectUris, postLogoutRedirectUris, disabled, isFirstParty) feed
  // into `metadata`, and `level` / `referenced*` columns are immutable
  // (enforced by the `oauth_clients_level_immutable` DB trigger in
  // migration 0001). The metadata JSON written at creation time is
  // therefore frozen for the client's lifetime and cannot drift from
  // the SQL columns — eliminating the read-modify-write race that the
  // old `syncMetadata` helper introduced between mutations.
  return mapRow(row);
}

/**
 * Resolve the effective "owning entity" for a client — the org id for
 * org-level clients, or the org id derived from the application FK for
 * application-level clients. Used by route-level permission checks that
 * need to ensure the caller is an admin of the org that owns the client.
 *
 * Single `LEFT JOIN` so we never issue two sequential round-trips for
 * application-level clients — this function runs on every CRUD route
 * (`GET /:id`, `PATCH /:id`, `DELETE /:id`, `POST /:id/rotate`) and is
 * latency-sensitive. The join is cheap: `applications.id` is the primary
 * key and the FK is covered by an index from the initial migration.
 */
export async function getClientOwningOrg(clientId: string): Promise<string | null> {
  const [row] = await db
    .select({
      level: oauthClient.level,
      referencedOrgId: oauthClient.referencedOrgId,
      appOrgId: applications.orgId,
    })
    .from(oauthClient)
    .leftJoin(applications, eq(applications.id, oauthClient.referencedApplicationId))
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  if (!row) return null;
  // Instance clients are system-level — they have no owning org.
  if (row.level === "instance") return null;
  if (row.level === "org") return row.referencedOrgId;
  if (row.level === "application") return row.appOrgId ?? null;
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
 * `postLogoutRedirectUris` against the current `APP_URL` on every boot.
 * When the operator changes `APP_URL` (domain move, placeholder → real
 * URL on first setup), the existing row is updated in place — same
 * `client_id`, so outstanding tokens and live sessions remain valid.
 *
 * Without this reconciliation the dashboard SPA would loop on
 * `/api/auth/oauth2/authorize` after a URL change and eventually hit
 * the per-IP rate limit (see `auth/guards.ts` `AUTHORIZE_RL_POINTS`),
 * forcing operators to wipe the DB to recover.
 *
 * Called from `oidcModule.init()` at boot.
 */
export async function ensureInstanceClient(appUrl: string): Promise<string> {
  const expectedRedirectUris = [`${appUrl}/auth/callback`];
  const expectedPostLogoutRedirectUris = [appUrl, `${appUrl}/login`];

  const [existing] = await db
    .select({
      clientId: oauthClient.clientId,
      redirectUris: oauthClient.redirectUris,
      postLogoutRedirectUris: oauthClient.postLogoutRedirectUris,
    })
    .from(oauthClient)
    .where(eq(oauthClient.level, "instance"))
    .orderBy(asc(oauthClient.createdAt))
    .limit(1);

  if (existing) {
    const storedPostLogout = existing.postLogoutRedirectUris ?? [];
    const redirectDrift = !sameStringSet(existing.redirectUris, expectedRedirectUris);
    const postLogoutDrift = !sameStringSet(storedPostLogout, expectedPostLogoutRedirectUris);
    if (redirectDrift || postLogoutDrift) {
      await db
        .update(oauthClient)
        .set({
          redirectUris: expectedRedirectUris,
          postLogoutRedirectUris: expectedPostLogoutRedirectUris,
          updatedAt: new Date(),
        })
        .where(eq(oauthClient.clientId, existing.clientId));
      cacheInvalidate(existing.clientId);
      logger.warn("OIDC platform client redirect URIs updated to match APP_URL", {
        module: "oidc",
        clientId: existing.clientId,
        appUrl,
        redirectUrisFrom: existing.redirectUris,
        redirectUrisTo: expectedRedirectUris,
        postLogoutRedirectUrisFrom: storedPostLogout,
        postLogoutRedirectUrisTo: expectedPostLogoutRedirectUris,
      });
    }
    return existing.clientId;
  }

  // The platform auto-provisioned instance client opts into open signup at
  // boot so a fresh Appstrate install can register its first user. Every
  // other client (env-declared satellites, org tenants, application
  // clients) keeps the closed `allowSignup: false` default from
  // `createClient()` and can opt in independently via the admin API.
  const created = await createClient({
    level: "instance",
    name: "Appstrate Platform",
    redirectUris: expectedRedirectUris,
    postLogoutRedirectUris: expectedPostLogoutRedirectUris,
    scopes: ["openid", "profile", "email", "offline_access"],
    isFirstParty: true,
    allowSignup: true,
  });
  return created.clientId;
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
  assertValidScopes(input.scopes);

  const id = prefixedId("oac");
  const hashedSecret = await hashSecret(input.clientSecretPlaintext);
  const now = new Date();

  // Mirror `createClient()` — see oauth-admin.ts metadata shape for the
  // rationale. `clientId` is stashed alongside `level` so
  // `customAccessTokenClaims` in plugins.ts can dispatch to
  // `buildInstanceLevelClaims` at token-mint time.
  const metadata: Record<string, unknown> = {
    level: "instance",
    clientId: input.clientId,
  };

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
      referencedApplicationId: null,
      metadata: JSON.stringify(metadata),
      skipConsent: input.skipConsent,
      allowSignup: input.allowSignup,
      signupRole: "member",
      disabled: false,
      type: "web",
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

export interface InstanceClientDriftMismatch {
  field: string;
  stored: unknown;
  declared: unknown;
}

export type InstanceClientDriftResult =
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
 *   should refuse to operate on it (it belongs to an org/application client
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
