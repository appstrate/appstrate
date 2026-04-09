// SPDX-License-Identifier: Apache-2.0

/**
 * End-Users API — CRUD operations for end-users managed via API.
 *
 * End-users belong to an application and represent external users of the platform.
 * Each end-user gets a default connection profile on creation.
 */

import { eq, and, desc, lt, gt } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { endUsers, applications, connectionProfiles } from "@appstrate/db/schema";
import type { EndUserInfo, EndUserListResponse } from "@appstrate/shared-types";
import { logger } from "../lib/logger.ts";
import { notFound, ApiError } from "../lib/errors.ts";
import { getDefaultApplication } from "./applications.ts";
import { prefixedId } from "../lib/ids.ts";
import { buildUpdateSet } from "../lib/db-helpers.ts";
import { toISORequired } from "../lib/date-helpers.ts";

function toEndUserResponse(row: {
  id: string;
  applicationId: string;
  name: string | null;
  email: string | null;
  externalId: string | null;
  metadata: unknown;
  status: string;
  emailVerified: boolean;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}): EndUserInfo {
  return {
    id: row.id,
    object: "end_user",
    applicationId: row.applicationId,
    name: row.name,
    email: row.email,
    externalId: row.externalId,
    metadata: row.metadata as Record<string, unknown> | null,
    status: row.status,
    emailVerified: row.emailVerified,
    role: row.role,
    createdAt: toISORequired(row.createdAt),
    updatedAt: toISORequired(row.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createEndUser(
  orgId: string,
  applicationId: string | null,
  params: {
    name?: string;
    email?: string;
    externalId?: string;
    metadata?: Record<string, unknown>;
    role?: string;
  },
): Promise<EndUserInfo> {
  const endUserId = prefixedId("eu");
  const now = new Date();

  // Resolve application: use provided or fall back to default
  let resolvedAppId: string;
  if (applicationId) {
    // Verify application exists and belongs to org
    const [app] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(and(eq(applications.id, applicationId), eq(applications.orgId, orgId)))
      .limit(1);
    if (!app) {
      throw notFound(`Application '${applicationId}' not found in this organization`);
    }
    resolvedAppId = applicationId;
  } else {
    const defaultApp = await getDefaultApplication(orgId);
    resolvedAppId = defaultApp.id;
  }

  // Validate externalId uniqueness within application
  if (params.externalId) {
    const existing = await findByExternalId(resolvedAppId, params.externalId);
    if (existing) {
      throw new ApiError({
        status: 409,
        code: "external_id_taken",
        title: "Conflict",
        detail: `externalId '${params.externalId}' is already in use in this application`,
        param: "externalId",
      });
    }
  }

  // Insert end-user
  const [created] = await db
    .insert(endUsers)
    .values({
      id: endUserId,
      applicationId: resolvedAppId,
      orgId,
      name: params.name ?? null,
      email: params.email ?? null,
      externalId: params.externalId ?? null,
      metadata: params.metadata ?? null,
      role: params.role ?? "member",
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  // Create default connection profile for the end-user
  await db.insert(connectionProfiles).values({
    endUserId,
    name: "Default",
    isDefault: true,
  });

  logger.info("End-user created via API", { endUserId, orgId, applicationId: resolvedAppId });

  return toEndUserResponse(created!);
}

export async function listEndUsers(
  orgId: string,
  params: {
    applicationId: string;
    externalId?: string;
    email?: string;
    limit?: number;
    startingAfter?: string;
    endingBefore?: string;
  },
): Promise<EndUserListResponse> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const fetchLimit = limit + 1; // Fetch one extra to detect hasMore

  const conditions = [eq(endUsers.orgId, orgId)];

  conditions.push(eq(endUsers.applicationId, params.applicationId));
  if (params.externalId) {
    conditions.push(eq(endUsers.externalId, params.externalId));
  }
  if (params.email) {
    conditions.push(eq(endUsers.email, params.email));
  }
  if (params.startingAfter) {
    conditions.push(lt(endUsers.id, params.startingAfter));
  }
  if (params.endingBefore) {
    conditions.push(gt(endUsers.id, params.endingBefore));
  }

  const rows = await db
    .select({
      id: endUsers.id,
      applicationId: endUsers.applicationId,
      name: endUsers.name,
      email: endUsers.email,
      externalId: endUsers.externalId,
      metadata: endUsers.metadata,
      status: endUsers.status,
      emailVerified: endUsers.emailVerified,
      role: endUsers.role,
      createdAt: endUsers.createdAt,
      updatedAt: endUsers.updatedAt,
    })
    .from(endUsers)
    .where(and(...conditions))
    .orderBy(desc(endUsers.createdAt), desc(endUsers.id))
    .limit(fetchLimit);

  const hasMore = rows.length > limit;
  const data = (hasMore ? rows.slice(0, limit) : rows).map(toEndUserResponse);

  return { object: "list", data, hasMore, limit };
}

export async function getEndUser(orgId: string, endUserId: string): Promise<EndUserInfo> {
  const [row] = await db
    .select({
      id: endUsers.id,
      applicationId: endUsers.applicationId,
      name: endUsers.name,
      email: endUsers.email,
      externalId: endUsers.externalId,
      metadata: endUsers.metadata,
      status: endUsers.status,
      emailVerified: endUsers.emailVerified,
      role: endUsers.role,
      createdAt: endUsers.createdAt,
      updatedAt: endUsers.updatedAt,
    })
    .from(endUsers)
    .where(and(eq(endUsers.id, endUserId), eq(endUsers.orgId, orgId)))
    .limit(1);

  if (!row) {
    throw notFound(`End-user '${endUserId}' not found in this organization`);
  }

  return toEndUserResponse(row);
}

export async function updateEndUser(
  orgId: string,
  endUserId: string,
  params: {
    name?: string;
    email?: string;
    externalId?: string;
    metadata?: Record<string, unknown>;
    role?: string;
  },
): Promise<EndUserInfo> {
  // Verify end-user exists and belongs to org
  const existing = await getEndUser(orgId, endUserId);

  // Validate externalId uniqueness if changing
  if (params.externalId !== undefined) {
    const found = await findByExternalId(existing.applicationId, params.externalId);
    if (found && found.id !== endUserId) {
      throw new ApiError({
        status: 409,
        code: "external_id_taken",
        title: "Conflict",
        detail: `externalId '${params.externalId}' is already in use in this application`,
        param: "externalId",
      });
    }
  }

  // Build update set — merge metadata (Stripe pattern)
  const { metadata, ...rest } = params;
  const updates = buildUpdateSet(rest);
  if (metadata !== undefined) {
    const [current] = await db
      .select({ metadata: endUsers.metadata })
      .from(endUsers)
      .where(and(eq(endUsers.id, endUserId), eq(endUsers.orgId, orgId)))
      .limit(1);
    updates.metadata = {
      ...((current?.metadata as Record<string, unknown>) ?? {}),
      ...metadata,
    };
  }

  const [updated] = await db
    .update(endUsers)
    .set(updates)
    .where(and(eq(endUsers.id, endUserId), eq(endUsers.orgId, orgId)))
    .returning();

  return toEndUserResponse(updated!);
}

export async function deleteEndUser(orgId: string, endUserId: string): Promise<void> {
  // Verify end-user exists and belongs to org
  await getEndUser(orgId, endUserId);

  // Delete end-user — cascades handle profiles, connections, runs
  await db.delete(endUsers).where(and(eq(endUsers.id, endUserId), eq(endUsers.orgId, orgId)));

  logger.info("End-user deleted via API", { endUserId, orgId });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export async function findByExternalId(
  applicationId: string,
  externalId: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: endUsers.id })
    .from(endUsers)
    .where(and(eq(endUsers.applicationId, applicationId), eq(endUsers.externalId, externalId)))
    .limit(1);
  return row ?? null;
}

/**
 * Check if an end-user belongs to a specific application. Used by auth middleware
 * for Appstrate-User header resolution when authenticating via API key.
 */
export async function isEndUserInApp(
  applicationId: string,
  endUserId: string,
): Promise<{
  id: string;
  applicationId: string;
  name: string | null;
  email: string | null;
} | null> {
  const [row] = await db
    .select({
      id: endUsers.id,
      applicationId: endUsers.applicationId,
      name: endUsers.name,
      email: endUsers.email,
    })
    .from(endUsers)
    .where(and(eq(endUsers.id, endUserId), eq(endUsers.applicationId, applicationId)))
    .limit(1);
  return row ?? null;
}
