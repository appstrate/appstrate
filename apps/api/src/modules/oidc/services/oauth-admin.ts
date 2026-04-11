// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth client admin service.
 *
 * Direct CRUD against the module-owned `oauth_client` table, scoped by
 * `referenceId` = Appstrate `applicationId`. Secrets are generated as
 * base64url-encoded random bytes, hashed with SHA-256 at rest, and only
 * returned in plaintext from `createClient` / `rotateClientSecret` —
 * subsequent reads never expose them.
 *
 * Why we bypass `auth.api.adminCreateOAuthClient`: the plugin derives
 * `reference_id` from `clientReference({ session })` at creation time.
 * Appstrate's active `applicationId` is threaded via the `X-App-Id`
 * header + Hono context middleware, not through the Better Auth session
 * — so `clientReference` has no access to it. Rather than rewire the
 * whole session object to carry app context, we keep direct Drizzle
 * writes here.
 *
 * Why the `referenceId` + `metadata.applicationId` dual-write: the
 * plugin's `customAccessTokenClaims` / `customIdTokenClaims` closures
 * receive `metadata = parseClientMetadata(oauth_client.metadata)` — they
 * do NOT receive `oauth_client.reference_id`. (The `referenceId` closure
 * argument in `customAccessTokenClaims` carries `postLogin.consentReferenceId`,
 * a different feature we don't use.) So the applicationId has to live on
 * the `metadata` column to reach custom claims. The `reference_id` column
 * is populated in lockstep so the plugin's own client-ACL path
 * (`clientReference`-based admin CRUD gates) stays consistent if it is
 * ever wired. `buildOauthClientApplicationBinding()` is the single write
 * site for this invariant.
 */

import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applications } from "@appstrate/db/schema";
import { oauthClient } from "../schema.ts";
import { prefixedId } from "../../../lib/ids.ts";

export interface OAuthClientRecord {
  id: string;
  clientId: string;
  name: string | null;
  redirectUris: string[];
  scopes: string[];
  disabled: boolean;
  applicationId: string;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/** Returned only on create + rotate — the plaintext secret is never re-readable. */
export interface OAuthClientWithSecret extends OAuthClientRecord {
  clientSecret: string;
}

function mapRow(row: typeof oauthClient.$inferSelect): OAuthClientRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    redirectUris: row.redirectUris ?? [],
    scopes: row.scopes ?? [],
    disabled: row.disabled ?? false,
    applicationId: row.referenceId ?? "",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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
 * Produce the paired `referenceId` + `metadata` values that bind an oauth
 * client row to its owning Appstrate application. Both fields MUST be
 * written in lockstep:
 * - `metadata.applicationId` is what the plugin surfaces to
 *   `customAccessTokenClaims` / `customIdTokenClaims` — the actual source
 *   of the end-user claims at token-mint time.
 * - `referenceId` matches so the plugin's native client-ACL path stays
 *   consistent (e.g. `clientReference({ session })` admin gates).
 *
 * Any future mutation touching one MUST call this helper to preserve the
 * invariant. The invariant is defended at read time by
 * `buildEndUserClaims()` in `auth/plugins.ts`, which logs and fails-open
 * if `metadata.applicationId` is missing.
 */
export function buildOauthClientApplicationBinding(applicationId: string): {
  referenceId: string;
  metadata: string;
} {
  return {
    referenceId: applicationId,
    metadata: JSON.stringify({ applicationId }),
  };
}

export async function listClientsForApp(applicationId: string): Promise<OAuthClientRecord[]> {
  const rows = await db
    .select()
    .from(oauthClient)
    .where(eq(oauthClient.referenceId, applicationId));
  return rows.map(mapRow);
}

export async function getClient(
  applicationId: string,
  clientId: string,
): Promise<OAuthClientRecord | null> {
  const [row] = await db
    .select()
    .from(oauthClient)
    .where(and(eq(oauthClient.referenceId, applicationId), eq(oauthClient.clientId, clientId)))
    .limit(1);
  return row ? mapRow(row) : null;
}

export interface CreateClientInput {
  name: string;
  redirectUris: string[];
  scopes?: string[];
}

export async function createClient(
  applicationId: string,
  input: CreateClientInput,
): Promise<OAuthClientWithSecret> {
  const [app] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);
  if (!app) {
    throw new Error(`OIDC: application '${applicationId}' not found`);
  }

  const id = prefixedId("oac");
  const clientId = `oauth_${randomSecret().slice(0, 24)}`;
  const plaintextSecret = randomSecret();
  const hashedSecret = await hashSecret(plaintextSecret);
  const now = new Date();

  const inserted = await db
    .insert(oauthClient)
    .values({
      id,
      clientId,
      clientSecret: hashedSecret,
      name: input.name,
      redirectUris: input.redirectUris,
      scopes: input.scopes ?? ["openid", "profile", "email"],
      ...buildOauthClientApplicationBinding(applicationId),
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
    throw new Error("OIDC: failed to insert oauth_client row");
  }
  return { ...mapRow(inserted[0]!), clientSecret: plaintextSecret };
}

export async function deleteClient(
  applicationId: string,
  clientId: string,
): Promise<OAuthClientRecord | null> {
  const [row] = await db
    .delete(oauthClient)
    .where(and(eq(oauthClient.referenceId, applicationId), eq(oauthClient.clientId, clientId)))
    .returning();
  return row ? mapRow(row) : null;
}

export async function rotateClientSecret(
  applicationId: string,
  clientId: string,
): Promise<OAuthClientWithSecret | null> {
  const plaintextSecret = randomSecret();
  const hashedSecret = await hashSecret(plaintextSecret);
  const [row] = await db
    .update(oauthClient)
    .set({ clientSecret: hashedSecret, updatedAt: new Date() })
    .where(and(eq(oauthClient.referenceId, applicationId), eq(oauthClient.clientId, clientId)))
    .returning();
  return row ? { ...mapRow(row), clientSecret: plaintextSecret } : null;
}

export async function setClientDisabled(
  applicationId: string,
  clientId: string,
  disabled: boolean,
): Promise<OAuthClientRecord | null> {
  const [row] = await db
    .update(oauthClient)
    .set({ disabled, updatedAt: new Date() })
    .where(and(eq(oauthClient.referenceId, applicationId), eq(oauthClient.clientId, clientId)))
    .returning();
  return row ? mapRow(row) : null;
}

export async function updateClientRedirectUris(
  applicationId: string,
  clientId: string,
  redirectUris: string[],
): Promise<OAuthClientRecord | null> {
  const [row] = await db
    .update(oauthClient)
    .set({ redirectUris, updatedAt: new Date() })
    .where(and(eq(oauthClient.referenceId, applicationId), eq(oauthClient.clientId, clientId)))
    .returning();
  return row ? mapRow(row) : null;
}
