// SPDX-License-Identifier: Apache-2.0

import { eq, and, isNull, lt } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  apiKeys,
  user as userTable,
  profiles,
  organizations,
  organizationMembers,
} from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "../lib/logger.ts";
import type { ApiKeyInfo } from "@appstrate/shared-types";
import type { OrgRole } from "../types/index.ts";
import { toISO, toISORequired } from "../lib/date-helpers.ts";
import type { AppScope, OrgScope } from "../lib/scope.ts";

const API_KEY_PREFIX = "ask_";

/** Generate a new API key: `ask_` + 48 hex chars. */
export function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${API_KEY_PREFIX}${hex}`;
}

/** SHA-256 hash of a raw key, returned as hex string. */
export async function hashApiKey(rawKey: string): Promise<string> {
  const data = new TextEncoder().encode(rawKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** First 8 characters of the raw key for display identification. */
export function extractKeyPrefix(rawKey: string): string {
  return rawKey.slice(0, 8);
}

export interface ValidatedApiKey {
  keyId: string;
  userId: string;
  email: string;
  name: string;
  orgId: string;
  orgSlug: string;
  applicationId: string;
  scopes: string[];
  creatorRole: OrgRole;
}

/**
 * Validate a raw API key. Returns key info if valid, null otherwise.
 * Updates lastUsedAt fire-and-forget.
 */
export async function validateApiKey(rawKey: string): Promise<ValidatedApiKey | null> {
  if (!rawKey.startsWith(API_KEY_PREFIX)) return null;

  const hash = await hashApiKey(rawKey);

  const rows = await db
    .select({
      id: apiKeys.id,
      orgId: apiKeys.orgId,
      applicationId: apiKeys.applicationId,
      createdBy: apiKeys.createdBy,
      scopes: apiKeys.scopes,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      userName: userTable.name,
      userEmail: userTable.email,
      orgSlug: organizations.slug,
      creatorRole: organizationMembers.role,
    })
    .from(apiKeys)
    .innerJoin(userTable, eq(apiKeys.createdBy, userTable.id))
    .innerJoin(organizations, eq(organizations.id, apiKeys.orgId))
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.orgId, apiKeys.orgId),
        eq(organizationMembers.userId, apiKeys.createdBy),
      ),
    )
    .where(eq(apiKeys.keyHash, hash))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // Check revoked
  if (row.revokedAt) return null;

  // Check expired (null = never expires)
  if (row.expiresAt && row.expiresAt < new Date()) return null;

  // Update lastUsedAt (fire-and-forget, no await)
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.id))
    .catch((err) => {
      logger.warn("Failed to update lastUsedAt for API key", {
        keyId: row.id,
        error: getErrorMessage(err),
      });
    });

  return {
    keyId: row.id,
    userId: row.createdBy!,
    email: row.userEmail,
    name: row.userName,
    orgId: row.orgId,
    orgSlug: row.orgSlug,
    applicationId: row.applicationId,
    scopes: row.scopes,
    creatorRole: row.creatorRole as OrgRole,
  };
}

/** Create a new API key record. Returns the record ID. */
export async function createApiKeyRecord(params: {
  scope: AppScope;
  name: string;
  keyHash: string;
  keyPrefix: string;
  createdBy: string;
  expiresAt: Date | null;
  scopes?: string[];
}): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(apiKeys).values({
    id,
    orgId: params.scope.orgId,
    applicationId: params.scope.applicationId,
    name: params.name,
    keyHash: params.keyHash,
    keyPrefix: params.keyPrefix,
    createdBy: params.createdBy,
    expiresAt: params.expiresAt,
    scopes: params.scopes ?? [],
  });
  return id;
}

/**
 * List active (non-revoked) API keys.
 *
 * Session callers typically pass `OrgScope` — admins manage keys org-wide
 * from the dashboard, optionally narrowing via the `applicationId` option.
 * API-key callers pass their own `AppScope`: the listing is forced to the
 * key's bound app so a key in App A cannot enumerate sibling apps' keys.
 */
export async function listApiKeys(
  scope: OrgScope | AppScope,
  opts: { applicationId?: string } = {},
): Promise<ApiKeyInfo[]> {
  const conditions = [eq(apiKeys.orgId, scope.orgId), isNull(apiKeys.revokedAt)];
  const appFilter =
    "applicationId" in scope ? scope.applicationId : (opts.applicationId ?? undefined);
  if (appFilter) {
    conditions.push(eq(apiKeys.applicationId, appFilter));
  }

  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      scopes: apiKeys.scopes,
      createdBy: apiKeys.createdBy,
      expiresAt: apiKeys.expiresAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt,
      displayName: profiles.displayName,
      userName: userTable.name,
    })
    .from(apiKeys)
    .leftJoin(userTable, eq(apiKeys.createdBy, userTable.id))
    .leftJoin(profiles, eq(apiKeys.createdBy, profiles.id))
    .where(and(...conditions))
    .orderBy(apiKeys.createdAt);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    keyPrefix: r.keyPrefix,
    scopes: r.scopes,
    createdBy: r.createdBy,
    createdByName: r.displayName || r.userName || undefined,
    expiresAt: toISO(r.expiresAt),
    lastUsedAt: toISO(r.lastUsedAt),
    revokedAt: toISO(r.revokedAt),
    createdAt: toISORequired(r.createdAt),
  }));
}

/**
 * Revoke (soft-delete) an API key.
 *
 * Session callers (admins) pass `OrgScope` for org-wide reach; API-key
 * callers pass their own `AppScope` so a key in App A can only revoke keys
 * within App A. Issue #172 (extension): passing the wrong scope type is
 * now a compile-time error instead of a missing argument.
 */
export async function revokeApiKey(scope: OrgScope | AppScope, keyId: string): Promise<boolean> {
  const conditions = [
    eq(apiKeys.id, keyId),
    eq(apiKeys.orgId, scope.orgId),
    isNull(apiKeys.revokedAt),
  ];
  if ("applicationId" in scope) {
    conditions.push(eq(apiKeys.applicationId, scope.applicationId));
  }

  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: apiKeys.id });

  return rows.length > 0;
}

/** Auto-revoke expired keys (called at startup). */
export async function cleanupExpiredKeys(): Promise<number> {
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(lt(apiKeys.expiresAt, new Date()), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });

  return rows.length;
}
