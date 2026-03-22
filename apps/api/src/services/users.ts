/**
 * Users API — CRUD operations for users managed via API.
 *
 * Users created via the API are standard Appstrate users with `source: "api"`,
 * no password, and automatically added as `member` of the org.
 */

import { eq, and, desc, lt, gt } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { user, connectionProfiles, organizationMembers, profiles } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { notFound, ApiError } from "../lib/errors.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserResponse {
  id: string;
  object: "user";
  name: string | null;
  email: string | null;
  externalId: string | null;
  source: string;
  metadata: Record<string, string> | null;
  createdAt: string;
}

export interface UserListResponse {
  object: "list";
  data: UserResponse[];
  hasMore: boolean;
  limit: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_METADATA_KEYS = 50;
const MAX_METADATA_KEY_LENGTH = 40;
const MAX_METADATA_VALUE_LENGTH = 500;

function generateUserId(): string {
  return `usr_${crypto.randomUUID()}`;
}

function toUserResponse(row: {
  id: string;
  name: string;
  email: string;
  externalId: string | null;
  source: string;
  metadata: unknown;
  createdAt: Date;
}): UserResponse {
  return {
    id: row.id,
    object: "user",
    name: row.name || null,
    email: row.email || null,
    externalId: row.externalId ?? null,
    source: row.source,
    metadata: (row.metadata as Record<string, string>) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function validateMetadata(
  metadata: unknown,
): { valid: true; data: Record<string, string> } | { valid: false; message: string } {
  if (metadata === null || metadata === undefined) {
    return { valid: true, data: {} };
  }
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    return { valid: false, message: "metadata must be an object" };
  }
  const entries = Object.entries(metadata as Record<string, unknown>);
  if (entries.length > MAX_METADATA_KEYS) {
    return { valid: false, message: `metadata cannot have more than ${MAX_METADATA_KEYS} keys` };
  }
  for (const [key, value] of entries) {
    if (key.length > MAX_METADATA_KEY_LENGTH) {
      return {
        valid: false,
        message: `metadata key '${key}' exceeds ${MAX_METADATA_KEY_LENGTH} characters`,
      };
    }
    if (typeof value !== "string") {
      return { valid: false, message: `metadata value for '${key}' must be a string` };
    }
    if (value.length > MAX_METADATA_VALUE_LENGTH) {
      return {
        valid: false,
        message: `metadata value for '${key}' exceeds ${MAX_METADATA_VALUE_LENGTH} characters`,
      };
    }
  }
  return { valid: true, data: metadata as Record<string, string> };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createUser(
  orgId: string,
  params: {
    name?: string;
    email?: string;
    externalId?: string;
    metadata?: Record<string, string>;
  },
): Promise<UserResponse> {
  const userId = generateUserId();
  const now = new Date();

  // Validate externalId uniqueness within org
  if (params.externalId) {
    const existing = await findByExternalId(orgId, params.externalId);
    if (existing) {
      throw new ApiError({
        status: 409,
        code: "external_id_taken",
        title: "Conflict",
        detail: `externalId '${params.externalId}' is already in use in this organization`,
        param: "externalId",
      });
    }
  }

  // Validate email uniqueness (global — Better Auth constraint)
  if (params.email) {
    const [emailExists] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, params.email))
      .limit(1);
    if (emailExists) {
      throw new ApiError({
        status: 409,
        code: "email_taken",
        title: "Conflict",
        detail: `Email '${params.email}' is already in use`,
        param: "email",
      });
    }
  }

  // Insert user
  const [created] = await db
    .insert(user)
    .values({
      id: userId,
      name: params.name ?? "",
      email: params.email ?? `${userId}@headless.appstrate.local`,
      emailVerified: false,
      source: "api",
      externalId: params.externalId ?? null,
      metadata: params.metadata ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  // Create profile (same as Better Auth hook)
  await db.insert(profiles).values({
    id: userId,
    displayName: params.name || params.email || userId,
  });

  // Add as member of the org
  await db.insert(organizationMembers).values({
    orgId,
    userId,
    role: "member",
  });

  // Create default connection profile
  await db.insert(connectionProfiles).values({
    userId,
    name: "Default",
    isDefault: true,
  });

  logger.info("User created via API", { userId, orgId, source: "api" });

  return toUserResponse(created!);
}

export async function listUsers(
  orgId: string,
  params: {
    limit?: number;
    startingAfter?: string;
    endingBefore?: string;
    externalId?: string;
    email?: string;
  },
): Promise<UserListResponse> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const fetchLimit = limit + 1; // Fetch one extra to detect hasMore

  const conditions = [eq(organizationMembers.orgId, orgId)];

  if (params.externalId) {
    conditions.push(eq(user.externalId, params.externalId));
  }
  if (params.email) {
    conditions.push(eq(user.email, params.email));
  }
  if (params.startingAfter) {
    conditions.push(lt(user.id, params.startingAfter));
  }
  if (params.endingBefore) {
    conditions.push(gt(user.id, params.endingBefore));
  }

  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      externalId: user.externalId,
      source: user.source,
      metadata: user.metadata,
      createdAt: user.createdAt,
    })
    .from(user)
    .innerJoin(organizationMembers, eq(organizationMembers.userId, user.id))
    .where(and(...conditions))
    .orderBy(desc(user.createdAt), desc(user.id))
    .limit(fetchLimit);

  const hasMore = rows.length > limit;
  const data = (hasMore ? rows.slice(0, limit) : rows).map(toUserResponse);

  return { object: "list", data, hasMore, limit };
}

export async function getUser(orgId: string, userId: string): Promise<UserResponse> {
  const [row] = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      externalId: user.externalId,
      source: user.source,
      metadata: user.metadata,
      createdAt: user.createdAt,
    })
    .from(user)
    .innerJoin(organizationMembers, eq(organizationMembers.userId, user.id))
    .where(and(eq(user.id, userId), eq(organizationMembers.orgId, orgId)))
    .limit(1);

  if (!row) {
    throw notFound(`User '${userId}' not found in this organization`);
  }

  return toUserResponse(row);
}

export async function updateUser(
  orgId: string,
  userId: string,
  params: {
    name?: string;
    email?: string;
    externalId?: string | null;
    metadata?: Record<string, string>;
  },
): Promise<UserResponse> {
  // Verify user exists and is member of org
  await getUser(orgId, userId);

  // Validate externalId uniqueness if changing
  if (params.externalId !== undefined && params.externalId !== null) {
    const existing = await findByExternalId(orgId, params.externalId);
    if (existing && existing.id !== userId) {
      throw new ApiError({
        status: 409,
        code: "external_id_taken",
        title: "Conflict",
        detail: `externalId '${params.externalId}' is already in use in this organization`,
        param: "externalId",
      });
    }
  }

  // Validate email uniqueness if changing
  if (params.email) {
    const [emailExists] = await db
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.email, params.email)))
      .limit(1);
    if (emailExists && emailExists.id !== userId) {
      throw new ApiError({
        status: 409,
        code: "email_taken",
        title: "Conflict",
        detail: `Email '${params.email}' is already in use`,
        param: "email",
      });
    }
  }

  // Merge metadata (Stripe pattern: keys in the update are merged, absent keys are kept)
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (params.name !== undefined) updates.name = params.name;
  if (params.email !== undefined) updates.email = params.email;
  if (params.externalId !== undefined) updates.externalId = params.externalId;
  if (params.metadata !== undefined) {
    const [current] = await db
      .select({ metadata: user.metadata })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    const merged = {
      ...((current?.metadata as Record<string, string>) ?? {}),
      ...params.metadata,
    };
    updates.metadata = merged;
  }

  const [updated] = await db.update(user).set(updates).where(eq(user.id, userId)).returning();

  return toUserResponse(updated!);
}

export async function deleteUser(orgId: string, userId: string): Promise<void> {
  // Verify user exists and is member of org
  await getUser(orgId, userId);

  // Delete user — cascades to profiles, org_members, connection_profiles, connections
  await db.delete(user).where(eq(user.id, userId));

  logger.info("User deleted via API", { userId, orgId });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function findByExternalId(orgId: string, externalId: string): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .innerJoin(organizationMembers, eq(organizationMembers.userId, user.id))
    .where(and(eq(user.externalId, externalId), eq(organizationMembers.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

/**
 * Check if a user is a member of an org. Used by Appstrate-User header resolution.
 */
export async function isOrgMember(
  orgId: string,
  userId: string,
): Promise<{ id: string; email: string; name: string } | null> {
  const [row] = await db
    .select({ id: user.id, email: user.email, name: user.name })
    .from(user)
    .innerJoin(organizationMembers, eq(organizationMembers.userId, user.id))
    .where(and(eq(user.id, userId), eq(organizationMembers.orgId, orgId)))
    .limit(1);
  return row ?? null;
}
