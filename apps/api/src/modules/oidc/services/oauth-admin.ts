// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth client admin service — polymorphic org + application clients.
 *
 * Direct CRUD against `oauth_clients`. Each client is scoped at one of two
 * levels:
 *
 *   - `org`: pinned to an organization via `referenced_org_id` (dashboard
 *     users are the actors)
 *   - `application`: pinned to an application via `referenced_application_id`
 *     (end-users are the actors)
 *
 * A DB-level CHECK constraint guarantees exactly one of the two FKs is set
 * based on `level`, so "mixed" clients are unrepresentable.
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
 *     level: "org" | "application",
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

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@appstrate/db/client";
import { applications } from "@appstrate/db/schema";
import { oauthClient } from "../schema.ts";
import { prefixedId } from "../../../lib/ids.ts";
import { APPSTRATE_SCOPES } from "../auth/scopes.ts";
import { isValidRedirectUri } from "./redirect-uri.ts";

export type OAuthClientLevel = "org" | "application";

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
  level: z.enum(["org", "application"]),
  referencedOrgId: z.string().nullable(),
  referencedApplicationId: z.string().nullable(),
  redirectUris: z.array(z.url()),
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
  const level: OAuthClientLevel = row.level === "org" ? "org" : "application";
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    level,
    referencedOrgId: row.referencedOrgId ?? null,
    referencedApplicationId: row.referencedApplicationId ?? null,
    redirectUris: row.redirectUris ?? [],
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

/** Combined list for the admin UI — returns every client the caller's org can see. */
export async function listClientsForOrgAndApps(
  orgId: string,
  applicationIds: string[],
): Promise<OAuthClientRecord[]> {
  const orgLevel = await listClientsForOrg(orgId);
  const appLevel: OAuthClientRecord[] = [];
  for (const appId of applicationIds) {
    appLevel.push(...(await listClientsForApp(appId)));
  }
  return [...orgLevel, ...appLevel];
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
  scopes?: string[];
  referencedOrgId: string;
  isFirstParty?: boolean;
}

export interface CreateApplicationClientInput {
  level: "application";
  name: string;
  redirectUris: string[];
  scopes?: string[];
  referencedApplicationId: string;
  isFirstParty?: boolean;
}

export type CreateClientInput = CreateOrgClientInput | CreateApplicationClientInput;

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
  } else {
    metadata.referencedApplicationId = input.referencedApplicationId;
  }

  const inserted = await db
    .insert(oauthClient)
    .values({
      id,
      clientId,
      clientSecret: hashedSecret,
      name: input.name,
      redirectUris: input.redirectUris,
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

export async function setClientDisabled(
  clientId: string,
  disabled: boolean,
): Promise<OAuthClientRecord | null> {
  const [row] = await db
    .update(oauthClient)
    .set({ disabled, updatedAt: new Date() })
    .where(eq(oauthClient.clientId, clientId))
    .returning();
  return row ? mapRow(row) : null;
}

export async function updateClientRedirectUris(
  clientId: string,
  redirectUris: string[],
): Promise<OAuthClientRecord | null> {
  assertValidRedirectUris(redirectUris);
  const [row] = await db
    .update(oauthClient)
    .set({ redirectUris, updatedAt: new Date() })
    .where(eq(oauthClient.clientId, clientId))
    .returning();
  return row ? mapRow(row) : null;
}

export async function setClientFirstParty(
  clientId: string,
  isFirstParty: boolean,
): Promise<OAuthClientRecord | null> {
  const [row] = await db
    .update(oauthClient)
    .set({ skipConsent: isFirstParty, updatedAt: new Date() })
    .where(eq(oauthClient.clientId, clientId))
    .returning();
  return row ? mapRow(row) : null;
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
