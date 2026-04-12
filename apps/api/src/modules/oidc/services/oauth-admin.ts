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

import { eq, or, inArray } from "drizzle-orm";
import { z } from "zod";
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

export const oauthClientBaseSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  name: z.string().nullable(),
  level: z.enum(["instance", "org", "application"]),
  referencedOrgId: z.string().nullable(),
  referencedApplicationId: z.string().nullable(),
  redirectUris: z.array(z.url()),
  postLogoutRedirectUris: z.array(z.url()),
  scopes: z.array(z.string()),
  disabled: z.boolean(),
  isFirstParty: z.boolean(),
  /** Org-level: whether non-members are auto-joined on first sign-in. Defaults to `false`. */
  allowSignup: z.boolean(),
  /** Org-level: role assigned on auto-join. `owner` forbidden. Defaults to `"member"`. */
  signupRole: z.enum(SIGNUP_ROLE_ALLOWED),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const oauthClientWithSecretSchema = oauthClientBaseSchema.extend({
  clientSecret: z.string(),
});

export type OAuthClientRecord = z.infer<typeof oauthClientBaseSchema>;
export type OAuthClientWithSecret = z.infer<typeof oauthClientWithSecretSchema>;

/** @internal exported for unit tests */
export function isKnownLevel(level: unknown): level is OAuthClientLevel {
  return level === "instance" || level === "org" || level === "application";
}

/**
 * Strict row mapper — throws on unexpected `level` values. Use this for
 * single-row lookups (`getClient`, `createClient`, `updateClient`) where
 * a corrupted row is a hard failure the caller should surface.
 */
function mapRow(row: typeof oauthClient.$inferSelect): OAuthClientRecord {
  if (!isKnownLevel(row.level)) {
    throw new Error(`OIDC: unexpected oauth_client.level value: ${String(row.level)}`);
  }
  // Drizzle returns `signup_role` as `string` (no enum narrowing on reads).
  // Narrow it back to the allowlist and fall back to `"member"` on any
  // unexpected value — the DB CHECK constraint prevents bad values from
  // ever being written, so this branch is defense in depth against
  // out-of-band SQL mutations.
  const signupRole: SignupRole = (SIGNUP_ROLE_ALLOWED as readonly string[]).includes(row.signupRole)
    ? (row.signupRole as SignupRole)
    : "member";
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
    signupRole,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

/**
 * Lenient row mapper — returns `null` and logs a warning for unexpected
 * `level` values instead of throwing. Use this in list/batch operations
 * so one corrupted row (e.g. after a botched migration) cannot crash the
 * entire listing and lock admins out of the UI.
 */
/** @internal exported for unit tests */
export function mapRowSafe(row: typeof oauthClient.$inferSelect): OAuthClientRecord | null {
  if (!isKnownLevel(row.level)) {
    logger.warn("oidc: skipping oauth_client row with unexpected level", {
      module: "oidc",
      clientId: row.clientId,
      level: String(row.level),
    });
    return null;
  }
  return mapRow(row);
}

function mapRowsSafe(rows: (typeof oauthClient.$inferSelect)[]): OAuthClientRecord[] {
  const out: OAuthClientRecord[] = [];
  for (const row of rows) {
    const mapped = mapRowSafe(row);
    if (mapped) out.push(mapped);
  }
  return out;
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
  return mapRowsSafe(rows);
}

export async function listClientsForApp(applicationId: string): Promise<OAuthClientRecord[]> {
  const rows = await db
    .select()
    .from(oauthClient)
    .where(eq(oauthClient.referencedApplicationId, applicationId));
  return mapRowsSafe(rows);
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
  return mapRowsSafe(rows);
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
  /** Defaults to `false`. Only honored for org-level clients. */
  allowSignup?: boolean;
  /** Defaults to `"member"`. Only honored for org-level clients. `owner` forbidden. */
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
}

export interface CreateInstanceClientInput {
  level: "instance";
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
  scopes?: string[];
  isFirstParty?: boolean;
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

  // Org-level signup policy. Mutable (unlike the rest of `metadata`) so it
  // lives only in dedicated SQL columns — the plugin reads it at token mint
  // via `loadOrgClientPolicy` (backed by `getClientCached`) rather than the
  // frozen metadata JSON. Rejected on application/instance clients to
  // prevent silent-ignore footguns.
  if (input.level === "org") {
    // no-op — defaults apply if unset
  } else if (
    (input as { allowSignup?: unknown }).allowSignup !== undefined ||
    (input as { signupRole?: unknown }).signupRole !== undefined
  ) {
    throw new OAuthAdminValidationError(
      "signupPolicy",
      "OIDC: allowSignup / signupRole are only valid for org-level clients",
    );
  }
  const allowSignup = input.level === "org" ? (input.allowSignup ?? false) : false;
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
  /** Org-level only — rejected on app/instance clients with a clear error. */
  allowSignup?: boolean;
  /** Org-level only — rejected on app/instance clients. `owner` forbidden. */
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

  // Reject signup policy updates on non-org clients early — the caller
  // probably meant to PATCH a different client. Silently ignoring would
  // hide configuration mistakes.
  if (input.allowSignup !== undefined || input.signupRole !== undefined) {
    const existing = await getClient(clientId);
    if (existing && existing.level !== "org") {
      throw new OAuthAdminValidationError(
        "signupPolicy",
        "OIDC: allowSignup / signupRole are only valid for org-level clients",
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

/** Lookup the (unique) instance-level client's clientId. */
export async function getInstanceClientId(): Promise<string | null> {
  const [row] = await db
    .select({ clientId: oauthClient.clientId })
    .from(oauthClient)
    .where(eq(oauthClient.level, "instance"))
    .limit(1);
  return row?.clientId ?? null;
}

/**
 * Auto-provision the instance-level OIDC client for the platform SPA.
 * Idempotent — returns the existing clientId if one already exists.
 * Called from `oidcModule.init()` at boot.
 */
export async function ensureInstanceClient(appUrl: string): Promise<string> {
  const existing = await getInstanceClientId();
  if (existing) return existing;

  const created = await createClient({
    level: "instance",
    name: "Appstrate Platform",
    redirectUris: [`${appUrl}/auth/callback`],
    postLogoutRedirectUris: [appUrl, `${appUrl}/login`],
    scopes: ["openid", "profile", "email", "offline_access"],
    isFirstParty: true,
  });
  return created.clientId;
}
