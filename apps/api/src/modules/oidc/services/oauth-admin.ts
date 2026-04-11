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
 * Stage 4 scope: this service does NOT go through Better Auth. It owns the
 * row directly so OAuth client admin works regardless of whether the Better
 * Auth oauth-provider plugin is wired. Stage 5 will hand the plaintext
 * secret to the plugin's token exchange code path; the hash-at-rest /
 * return-once pattern is already compatible with that.
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

async function hashSecret(plaintext: string): Promise<string> {
  const data = new TextEncoder().encode(plaintext);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(new Uint8Array(digest)).toString("hex");
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
      referenceId: applicationId,
      // Stash the applicationId inside `metadata` as well so the Better
      // Auth oauth-provider plugin's `customAccessTokenClaims` callback
      // can recover it at mint time. The plugin does NOT natively pipe
      // `client.referenceId` into the claims closure — it only passes
      // `parseClientMetadata(client.metadata)` — so we use metadata as
      // the side-channel. Changing this shape will break token minting.
      metadata: JSON.stringify({ applicationId }),
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
