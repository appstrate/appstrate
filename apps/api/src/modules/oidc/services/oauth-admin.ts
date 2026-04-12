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
import { APPSTRATE_SCOPES } from "../auth/scopes.ts";
import { isValidRedirectUri } from "./redirect-uri.ts";

export type OAuthClientLevel = "instance" | "org" | "application";

export class OAuthAdminValidationError extends Error {
  readonly field: "scopes" | "redirectUris" | "referencedOrgId" | "referencedApplicationId";
  constructor(
    field: "scopes" | "redirectUris" | "referencedOrgId" | "referencedApplicationId",
    message: string,
  ) {
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
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const oauthClientWithSecretSchema = oauthClientBaseSchema.extend({
  clientSecret: z.string(),
});

export type OAuthClientRecord = z.infer<typeof oauthClientBaseSchema>;
export type OAuthClientWithSecret = z.infer<typeof oauthClientWithSecretSchema>;

function mapRow(row: typeof oauthClient.$inferSelect): OAuthClientRecord {
  if (row.level !== "instance" && row.level !== "org" && row.level !== "application") {
    throw new Error(`OIDC: unexpected oauth_client.level value: ${String(row.level)}`);
  }
  const level: OAuthClientLevel = row.level;
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    level,
    referencedOrgId: row.referencedOrgId ?? null,
    referencedApplicationId: row.referencedApplicationId ?? null,
    redirectUris: row.redirectUris ?? [],
    postLogoutRedirectUris: row.postLogoutRedirectUris ?? [],
    scopes: row.scopes ?? [],
    disabled: row.disabled ?? false,
    isFirstParty: row.skipConsent ?? false,
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

/**
 * Rebuild the `metadata` JSON column from the authoritative SQL columns.
 * Plugins (customAccessTokenClaims) read `metadata` at token-mint time;
 * keeping it in sync after every mutation prevents stale claim data.
 */
async function syncMetadata(row: typeof oauthClient.$inferSelect): Promise<void> {
  const metadata: Record<string, unknown> = { level: row.level };
  if (row.level === "org") metadata.referencedOrgId = row.referencedOrgId;
  else if (row.level === "application")
    metadata.referencedApplicationId = row.referencedApplicationId;
  // instance: no FK fields in metadata
  const current = row.metadata ? JSON.parse(row.metadata) : {};
  const expected = JSON.stringify(metadata);
  if (row.metadata !== expected && JSON.stringify(current) !== expected) {
    await db
      .update(oauthClient)
      .set({ metadata: expected })
      .where(eq(oauthClient.clientId, row.clientId));
  }
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

  const metadata: Record<string, unknown> = { level: input.level };
  if (input.level === "org") {
    metadata.referencedOrgId = input.referencedOrgId;
  } else if (input.level === "application") {
    metadata.referencedApplicationId = input.referencedApplicationId;
  }
  // instance: no FK fields in metadata

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
  return row ? { ...mapRow(row), clientSecret: plaintextSecret } : null;
}

export interface UpdateClientInput {
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
  disabled?: boolean;
  isFirstParty?: boolean;
}

export async function updateClient(
  clientId: string,
  input: UpdateClientInput,
): Promise<OAuthClientRecord | null> {
  if (input.redirectUris !== undefined) {
    assertValidRedirectUris(input.redirectUris);
  }
  // Build a single SET clause — atomic, no partial-update risk.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.redirectUris !== undefined) set.redirectUris = input.redirectUris;
  if (input.postLogoutRedirectUris !== undefined)
    set.postLogoutRedirectUris = input.postLogoutRedirectUris;
  if (input.disabled !== undefined) set.disabled = input.disabled;
  if (input.isFirstParty !== undefined) set.skipConsent = input.isFirstParty;

  const [row] = await db
    .update(oauthClient)
    .set(set)
    .where(eq(oauthClient.clientId, clientId))
    .returning();
  if (!row) return null;
  // Keep metadata JSON in sync with SQL columns — plugins read metadata
  // at token-mint time via customAccessTokenClaims.
  await syncMetadata(row);
  return mapRow(row);
}

/**
 * Resolve the effective "owning entity" for a client — the org id for
 * org-level clients, or the org id derived from the application FK for
 * application-level clients. Used by route-level permission checks that
 * need to ensure the caller is an admin of the org that owns the client.
 */
export async function getClientOwningOrg(clientId: string): Promise<string | null> {
  const [row] = await db
    .select({
      level: oauthClient.level,
      referencedOrgId: oauthClient.referencedOrgId,
      referencedApplicationId: oauthClient.referencedApplicationId,
    })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  if (!row) return null;
  // Instance clients are system-level — they have no owning org.
  if (row.level === "instance") return null;
  if (row.level === "org") return row.referencedOrgId;
  if (row.level === "application" && row.referencedApplicationId) {
    const [app] = await db
      .select({ orgId: applications.orgId })
      .from(applications)
      .where(eq(applications.id, row.referencedApplicationId))
      .limit(1);
    return app?.orgId ?? null;
  }
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
