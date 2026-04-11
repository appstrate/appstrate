// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth client admin service.
 *
 * Thin wrapper around the Better Auth `oauth-provider` plugin's internal
 * client CRUD. Every client is scoped to a single Appstrate application via
 * the `referenceId` column, so every admin route in this module takes an
 * `applicationId` and enforces it on both read and write.
 *
 * The actual plugin calls happen through the module's Stage 3 plugin wiring
 * (`auth.api.oauth2.*` via the `@appstrate/db/auth` Proxy). Phase 0's Proxy
 * shim guarantees that any access here happens post-boot, after the Better
 * Auth singleton has been constructed with our plugin contribution.
 */

import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { oauthClient } from "../schema.ts";

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
