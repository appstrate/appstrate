/**
 * End-Users API — CRUD operations for end-users managed via API.
 *
 * End-users belong to an application and represent external users of the platform.
 * Each end-user gets a default connection profile on creation.
 */

import { z } from "zod";
import { eq, and, desc, lt, gt } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { endUsers, applications, connectionProfiles } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { notFound, ApiError } from "../lib/errors.ts";
import { getDefaultApplication } from "./applications.ts";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const endUserMetadataSchema = z
  .record(
    z.string().min(1).max(40),
    z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
  )
  .refine((obj) => Object.keys(obj).length <= 50, "Maximum 50 metadata keys");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EndUserResponse {
  id: string;
  object: "end_user";
  applicationId: string;
  name: string | null;
  email: string | null;
  externalId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface EndUserListResponse {
  object: "list";
  data: EndUserResponse[];
  hasMore: boolean;
  limit: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateEndUserId(): string {
  return `eu_${crypto.randomUUID()}`;
}

function toEndUserResponse(row: {
  id: string;
  applicationId: string;
  name: string | null;
  email: string | null;
  externalId: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}): EndUserResponse {
  return {
    id: row.id,
    object: "end_user",
    applicationId: row.applicationId,
    name: row.name ?? null,
    email: row.email ?? null,
    externalId: row.externalId ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function validateMetadata(
  metadata: unknown,
): { valid: true; data: Record<string, unknown> } | { valid: false; message: string } {
  if (metadata === null || metadata === undefined) {
    return { valid: true, data: {} };
  }
  const result = endUserMetadataSchema.safeParse(metadata);
  if (!result.success) {
    return { valid: false, message: result.error.issues[0]?.message ?? "Invalid metadata" };
  }
  return { valid: true, data: result.data };
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
  },
): Promise<EndUserResponse> {
  const endUserId = generateEndUserId();
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
    applicationId?: string;
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

  if (params.applicationId) {
    conditions.push(eq(endUsers.applicationId, params.applicationId));
  }
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

export async function getEndUser(orgId: string, endUserId: string): Promise<EndUserResponse> {
  const [row] = await db
    .select({
      id: endUsers.id,
      applicationId: endUsers.applicationId,
      name: endUsers.name,
      email: endUsers.email,
      externalId: endUsers.externalId,
      metadata: endUsers.metadata,
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
  },
): Promise<EndUserResponse> {
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
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (params.name !== undefined) updates.name = params.name;
  if (params.email !== undefined) updates.email = params.email;
  if (params.externalId !== undefined) updates.externalId = params.externalId;
  if (params.metadata !== undefined) {
    const [current] = await db
      .select({ metadata: endUsers.metadata })
      .from(endUsers)
      .where(and(eq(endUsers.id, endUserId), eq(endUsers.orgId, orgId)))
      .limit(1);
    const merged = {
      ...((current?.metadata as Record<string, unknown>) ?? {}),
      ...params.metadata,
    };
    updates.metadata = merged;
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

  // Delete end-user — cascades handle profiles, connections, executions
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
 * Resolve the applicationId for an end-user. Returns null if not found.
 * Used when we need the application context but only have an end-user ID.
 */
export async function getEndUserApplicationId(endUserId: string): Promise<string | null> {
  const [row] = await db
    .select({ applicationId: endUsers.applicationId })
    .from(endUsers)
    .where(eq(endUsers.id, endUserId))
    .limit(1);
  return row?.applicationId ?? null;
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
