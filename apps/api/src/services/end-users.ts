// SPDX-License-Identifier: Apache-2.0

/**
 * End-Users API — CRUD operations for end-users managed via API.
 *
 * End-users belong to an application and represent external users of the platform.
 */

import { eq, and, or, ilike, desc, lt, gt } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { endUsers, notifications, documents, runs } from "@appstrate/db/schema";
import type { EndUserInfo, ListEnvelope } from "@appstrate/shared-types";
import { logger } from "../lib/logger.ts";
import { notFound, ApiError } from "../lib/errors.ts";
import { listResponse } from "../lib/list-response.ts";
import { prefixedId } from "../lib/ids.ts";
import { buildUpdateSet } from "../lib/db-helpers.ts";
import { toISORequired } from "../lib/date-helpers.ts";
import type { AppScope } from "../lib/scope.ts";
import { assertApplicationInScope } from "./applications.ts";
import { enqueueStorageDeletion, type StorageDeletionJobInput } from "./storage-deletion.ts";
import {
  RUN_WORKSPACE_BUCKET,
  runWorkspaceBundleKey,
  runWorkspaceManifestKey,
} from "./run-workspace-storage.ts";

function toEndUserResponse(row: {
  id: string;
  applicationId: string;
  name: string | null;
  email: string | null;
  externalId: string | null;
  metadata: unknown;
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
    createdAt: toISORequired(row.createdAt),
    updatedAt: toISORequired(row.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createEndUser(
  scope: AppScope,
  params: {
    name?: string;
    email?: string;
    externalId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<EndUserInfo> {
  const endUserId = prefixedId("eu");
  const now = new Date();

  await assertApplicationInScope(scope);

  // Validate externalId uniqueness within application
  if (params.externalId) {
    const existing = await findByExternalId(scope.applicationId, params.externalId);
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
      applicationId: scope.applicationId,
      orgId: scope.orgId,
      name: params.name ?? null,
      email: params.email ?? null,
      externalId: params.externalId ?? null,
      metadata: params.metadata ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  logger.info("End-user created via API", {
    endUserId,
    orgId: scope.orgId,
    applicationId: scope.applicationId,
  });

  return toEndUserResponse(created!);
}

export async function listEndUsers(
  scope: AppScope,
  params: {
    externalId?: string;
    email?: string;
    search?: string;
    limit?: number;
    startingAfter?: string;
    endingBefore?: string;
  } = {},
): Promise<ListEnvelope<EndUserInfo>> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const fetchLimit = limit + 1; // Fetch one extra to detect hasMore

  const conditions = [
    eq(endUsers.orgId, scope.orgId),
    eq(endUsers.applicationId, scope.applicationId),
  ];

  if (params.externalId) {
    conditions.push(eq(endUsers.externalId, params.externalId));
  }
  if (params.email) {
    conditions.push(eq(endUsers.email, params.email));
  }
  if (params.search) {
    // Case-insensitive substring match across the human-facing fields so a
    // picker can find an end-user by name, email, or external id.
    const pattern = `%${params.search}%`;
    const term = or(
      ilike(endUsers.name, pattern),
      ilike(endUsers.email, pattern),
      ilike(endUsers.externalId, pattern),
    );
    if (term) conditions.push(term);
  }
  // Keyset pagination must use the SAME tuple the result set is ordered by —
  // `(createdAt DESC, id DESC)` below. Filtering on `id` alone while sorting by
  // `createdAt` makes the cursor boundary disagree with the sort order, so pages
  // skip or duplicate rows. Resolve the cursor's `createdAt` and compare the full
  // `(createdAt, id)` tuple lexicographically. A cursor id that no longer exists
  // (deleted between page loads) drops its clause — the page just starts at the
  // head rather than 500-ing.
  if (params.startingAfter) {
    const cursor = await getEndUserCursor(scope, params.startingAfter);
    if (cursor) {
      // Next page (older rows), DESC order: (createdAt, id) < (cursor.createdAt, cursor.id).
      conditions.push(
        or(
          lt(endUsers.createdAt, cursor.createdAt),
          and(eq(endUsers.createdAt, cursor.createdAt), lt(endUsers.id, cursor.id)),
        )!,
      );
    }
  }
  if (params.endingBefore) {
    const cursor = await getEndUserCursor(scope, params.endingBefore);
    if (cursor) {
      // Previous page (newer rows), DESC order: (createdAt, id) > (cursor.createdAt, cursor.id).
      conditions.push(
        or(
          gt(endUsers.createdAt, cursor.createdAt),
          and(eq(endUsers.createdAt, cursor.createdAt), gt(endUsers.id, cursor.id)),
        )!,
      );
    }
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

  return { ...listResponse(data, { hasMore }), limit };
}

export async function getEndUser(scope: AppScope, endUserId: string): Promise<EndUserInfo> {
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
    .where(
      and(
        eq(endUsers.id, endUserId),
        eq(endUsers.orgId, scope.orgId),
        eq(endUsers.applicationId, scope.applicationId),
      ),
    )
    .limit(1);

  if (!row) {
    throw notFound(`End-user '${endUserId}' not found in this application`);
  }

  return toEndUserResponse(row);
}

export async function updateEndUser(
  scope: AppScope,
  endUserId: string,
  params: {
    name?: string;
    email?: string;
    externalId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<EndUserInfo> {
  // Verify end-user exists and belongs to app
  const existing = await getEndUser(scope, endUserId);

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
  // Keys of `updateEndUserSchema` (routes/end-users.ts) minus `metadata`,
  // which is merged with the current value below.
  const updates = buildUpdateSet(rest, ["name", "email", "externalId"]);
  if (metadata !== undefined) {
    const [current] = await db
      .select({ metadata: endUsers.metadata })
      .from(endUsers)
      .where(
        and(
          eq(endUsers.id, endUserId),
          eq(endUsers.orgId, scope.orgId),
          eq(endUsers.applicationId, scope.applicationId),
        ),
      )
      .limit(1);
    updates.metadata = {
      ...((current?.metadata as Record<string, unknown>) ?? {}),
      ...metadata,
    };
  }

  const [updated] = await db
    .update(endUsers)
    .set(updates)
    .where(
      and(
        eq(endUsers.id, endUserId),
        eq(endUsers.orgId, scope.orgId),
        eq(endUsers.applicationId, scope.applicationId),
      ),
    )
    .returning();

  return toEndUserResponse(updated!);
}

export async function deleteEndUser(scope: AppScope, endUserId: string): Promise<void> {
  // Verify end-user exists and belongs to app
  await getEndUser(scope, endUserId);

  // Notifications carry the recipient as a polymorphic (recipientType,
  // recipientId) tuple with NO foreign key, so deleting the end-user does not
  // cascade them. Run-linked notifications are dropped transitively when the
  // end-user's runs cascade, but a future run-less end-user notification would
  // orphan — so delete the recipient's notifications explicitly. Scoped to the
  // app for tenant safety. Both deletes run in one transaction so a failure
  // mid-way can't leave the end-user gone but their notifications stranded
  // (or vice-versa).
  await db.transaction(async (tx) => {
    // Enumerate the end-user's storage objects BEFORE the FK cascade drops the
    // rows, and enqueue their physical deletion into the transactional outbox
    // (same tx) so the cascade can't orphan them. The end-user owns `documents`
    // (endUserId) and run-workspace objects for its runs (endUserId); uploads
    // are not end-user-scoped. Run-workspace per-document keys aren't enumerated
    // (needs each run's manifest) — bundle + manifest keys are enqueued per run,
    // worker treats a missing object as success.
    const docRows = await tx
      .select({ storageKey: documents.storageKey })
      .from(documents)
      .where(eq(documents.endUserId, endUserId));
    const runRows = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.endUserId, endUserId));

    const storageJobs: StorageDeletionJobInput[] = [];
    for (const r of docRows) {
      const [bucket, ...rest] = r.storageKey.split("/");
      if (bucket && rest.length > 0)
        storageJobs.push({ bucket, storageKey: rest.join("/"), reason: "end_user_deleted" });
    }
    for (const r of runRows) {
      storageJobs.push({
        bucket: RUN_WORKSPACE_BUCKET,
        storageKey: runWorkspaceBundleKey(r.id),
        reason: "end_user_deleted",
      });
      storageJobs.push({
        bucket: RUN_WORKSPACE_BUCKET,
        storageKey: runWorkspaceManifestKey(r.id),
        reason: "end_user_deleted",
      });
    }
    await enqueueStorageDeletion(tx, storageJobs);

    await tx
      .delete(notifications)
      .where(
        and(
          eq(notifications.recipientType, "end_user"),
          eq(notifications.recipientId, endUserId),
          eq(notifications.orgId, scope.orgId),
          eq(notifications.applicationId, scope.applicationId),
        ),
      );

    // Delete end-user — cascades handle connections, runs
    await tx
      .delete(endUsers)
      .where(
        and(
          eq(endUsers.id, endUserId),
          eq(endUsers.orgId, scope.orgId),
          eq(endUsers.applicationId, scope.applicationId),
        ),
      );
  });

  logger.info("End-user deleted via API", {
    endUserId,
    orgId: scope.orgId,
    applicationId: scope.applicationId,
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a keyset cursor (an end-user id) to its `(createdAt, id)` tuple,
 * scoped to the app for tenant safety. Returns `null` when the id is unknown
 * in this scope, so the caller can drop the boundary clause instead of paging
 * against a phantom cursor.
 */
async function getEndUserCursor(
  scope: AppScope,
  id: string,
): Promise<{ createdAt: Date; id: string } | null> {
  const [row] = await db
    .select({ createdAt: endUsers.createdAt, id: endUsers.id })
    .from(endUsers)
    .where(
      and(
        eq(endUsers.id, id),
        eq(endUsers.orgId, scope.orgId),
        eq(endUsers.applicationId, scope.applicationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

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
): Promise<import("@appstrate/core/module").EndUserContext | null> {
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
  if (!row) return null;
  return {
    id: row.id,
    applicationId: row.applicationId,
    ...(row.name != null ? { name: row.name } : {}),
    ...(row.email != null ? { email: row.email } : {}),
  };
}
