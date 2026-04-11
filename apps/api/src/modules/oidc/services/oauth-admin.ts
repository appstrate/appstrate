// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth client admin service.
 *
 * Direct CRUD against the module-owned `oauth_client` table, scoped by
 * Appstrate `applicationId`. Secrets are generated as base64url-encoded
 * random bytes, hashed with SHA-256 at rest, and only returned in
 * plaintext from `createClient` / `rotateClientSecret` — subsequent reads
 * never expose them.
 *
 * Why we bypass `auth.api.adminCreateOAuthClient`: the plugin derives
 * `reference_id` from `clientReference({ session })` at creation time.
 * Appstrate's active `applicationId` is threaded via the `X-App-Id`
 * header + Hono context middleware, not through the Better Auth session
 * — so `clientReference` has no access to it. Rather than rewire the
 * whole session object to carry app context, we keep direct Drizzle
 * writes here.
 *
 * Single source of truth for "which app owns this client" is
 * `oauth_client.metadata.applicationId`. It is the only value the
 * `@better-auth/oauth-provider` plugin exposes to its
 * `customAccessTokenClaims` closure (which receives `parseClientMetadata(
 * oauth_client.metadata)` and nothing else from the client row). Every
 * admin filter query below therefore reads the JSON path via
 * `byApplicationId()`, never the `referenceId` column.
 *
 * We still write `reference_id` in lockstep because the plugin's own
 * Drizzle schema declares the column `notNull` and emits it in internal
 * SELECTs (the `clientReference` ACL path at `oauth-provider/index.mjs`
 * line 1370 reads it if `opts.clientReference` is set — we don't set it,
 * so the value is functionally inert, but the column must exist and must
 * be non-null on every row). Treat it as a legacy mirror kept alive to
 * satisfy the plugin's schema contract, not as a lookup key.
 */

import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@appstrate/db/client";
import { oauthClient } from "../schema.ts";
import { prefixedId } from "../../../lib/ids.ts";
import type { AppContextRow } from "../../../middleware/app-context.ts";

/**
 * Single source of truth for the OAuth client shape returned by this
 * module. Backends, OpenAPI component schemas, and frontend hooks all
 * derive their types + JSON Schema from this definition.
 *
 * Dates are serialized to ISO 8601 strings at the service boundary so the
 * wire shape matches the frontend and OpenAPI contract — the DB column is
 * a `timestamp`, but consumers only ever see strings.
 */
export const oauthClientSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  name: z.string().nullable(),
  applicationId: z.string(),
  redirectUris: z.array(z.url()),
  scopes: z.array(z.string()),
  disabled: z.boolean(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

/** Returned only on create + rotate — the plaintext secret is never re-readable. */
export const oauthClientWithSecretSchema = oauthClientSchema.extend({
  clientSecret: z.string(),
});

export type OAuthClientRecord = z.infer<typeof oauthClientSchema>;
export type OAuthClientWithSecret = z.infer<typeof oauthClientWithSecretSchema>;

function mapRow(row: typeof oauthClient.$inferSelect): OAuthClientRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    redirectUris: row.redirectUris ?? [],
    scopes: row.scopes ?? [],
    disabled: row.disabled ?? false,
    applicationId: row.referenceId,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

/**
 * JSON path filter shared by every admin CRUD query. The single source of
 * truth for "which app owns this client" is `oauth_client.metadata.applicationId`
 * (the value the Better Auth plugin forwards to `customAccessTokenClaims`).
 * `oauth_client.reference_id` is kept populated in lockstep for compatibility
 * with the oauth-provider plugin's own schema — see the comment on the
 * `referenceId` column in `../schema.ts` — but queries should never filter
 * on it directly.
 */
function byApplicationId(applicationId: string) {
  return sql`(${oauthClient.metadata}::jsonb->>'applicationId') = ${applicationId}`;
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

export async function listClientsForApp(applicationId: string): Promise<OAuthClientRecord[]> {
  const rows = await db.select().from(oauthClient).where(byApplicationId(applicationId));
  return rows.map(mapRow);
}

export async function getClient(
  applicationId: string,
  clientId: string,
): Promise<OAuthClientRecord | null> {
  const [row] = await db
    .select()
    .from(oauthClient)
    .where(and(byApplicationId(applicationId), eq(oauthClient.clientId, clientId)))
    .limit(1);
  return row ? mapRow(row) : null;
}

export interface CreateClientInput {
  name: string;
  redirectUris: string[];
  scopes?: string[];
}

export async function createClient(
  app: AppContextRow,
  input: CreateClientInput,
): Promise<OAuthClientWithSecret> {
  const applicationId = app.id;
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
    .where(and(byApplicationId(applicationId), eq(oauthClient.clientId, clientId)))
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
    .where(and(byApplicationId(applicationId), eq(oauthClient.clientId, clientId)))
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
    .where(and(byApplicationId(applicationId), eq(oauthClient.clientId, clientId)))
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
    .where(and(byApplicationId(applicationId), eq(oauthClient.clientId, clientId)))
    .returning();
  return row ? mapRow(row) : null;
}
