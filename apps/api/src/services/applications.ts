// SPDX-License-Identifier: Apache-2.0

import { eq, asc, desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "@appstrate/db/client";
import { applications, documents, uploads, runs, organizations } from "@appstrate/db/schema";
import { invalidRequest, notFound } from "../lib/errors.ts";
import { prefixedId } from "../lib/ids.ts";
import { scopedWhere } from "../lib/db-helpers.ts";
import type { AppScope } from "../lib/scope.ts";
import { enqueueStorageDeletion, type StorageDeletionJobInput } from "./storage-deletion.ts";
import { decrementOrgDocumentBytes, storageKeyToDeletionJob } from "./documents.ts";
import {
  RUN_WORKSPACE_BUCKET,
  runWorkspaceBundleKey,
  runWorkspaceManifestKey,
} from "./run-workspace-storage.ts";

export const appSettingsSchema = z.object({
  allowedRedirectDomains: z.array(z.string()).max(20).optional(),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

/** Create a new application for an organization. */
export async function createApplication(
  orgId: string,
  params: { name: string; settings?: AppSettings; isDefault?: boolean },
  createdBy?: string,
) {
  const id = prefixedId("app");
  const [app] = await db
    .insert(applications)
    .values({
      id,
      orgId,
      name: params.name,
      isDefault: params.isDefault ?? false,
      settings: params.settings ?? {},
      createdBy: createdBy ?? null,
    })
    .returning();

  return app!;
}

/**
 * Create the default application for an organization.
 * Returns the existing default if one already exists (idempotent).
 */
export async function createDefaultApplication(orgId: string, createdBy?: string) {
  const existing = await db
    .select()
    .from(applications)
    .where(scopedWhere(applications, { orgId, extra: [eq(applications.isDefault, true)] }))
    .limit(1);

  if (existing[0]) return existing[0];

  return createApplication(orgId, { name: "Default", isDefault: true }, createdBy);
}

/** List all applications for an organization, ordered by creation date (newest first). */
export async function listApplications(orgId: string) {
  return db
    .select()
    .from(applications)
    .where(eq(applications.orgId, orgId))
    .orderBy(desc(applications.isDefault), asc(applications.createdAt));
}

/** Get a single application by ID, verifying org ownership. Throws 404 if not found. */
export async function getApplication(orgId: string, applicationId: string) {
  const [app] = await db
    .select()
    .from(applications)
    .where(scopedWhere(applications, { orgId, extra: [eq(applications.id, applicationId)] }))
    .limit(1);

  if (!app) throw notFound("Application not found");
  return app;
}

/** Verify an application id belongs to the current org-scoped request. */
export async function assertApplicationInScope(scope: AppScope): Promise<void> {
  const [app] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(
      scopedWhere(applications, {
        orgId: scope.orgId,
        extra: [eq(applications.id, scope.applicationId)],
      }),
    )
    .limit(1);

  if (!app) {
    throw notFound(`Application '${scope.applicationId}' not found in this organization`);
  }
}

/** Update an application. Throws 404 if not found. */
export async function updateApplication(
  orgId: string,
  applicationId: string,
  params: { name?: string; settings?: AppSettings },
) {
  const [app] = await db
    .update(applications)
    .set({
      ...(params.name !== undefined && { name: params.name }),
      ...(params.settings !== undefined && { settings: params.settings }),
      updatedAt: new Date(),
    })
    .where(scopedWhere(applications, { orgId, extra: [eq(applications.id, applicationId)] }))
    .returning();

  if (!app) throw notFound("Application not found");
  return app;
}

/** Delete an application. Throws 400 if default, 404 if not found. */
export async function deleteApplication(orgId: string, applicationId: string) {
  await db.transaction(async (tx) => {
    // Use the same org-first lock order as document/upload writes, then lock the
    // parent application before enumerating its children. The parent lock
    // prevents a concurrent FK insert from being cascade-deleted without a
    // matching outbox job.
    const [org] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)
      .for("update");
    if (!org) throw notFound("Application not found");

    const [app] = await tx
      .select({ id: applications.id, isDefault: applications.isDefault })
      .from(applications)
      .where(scopedWhere(applications, { orgId, extra: [eq(applications.id, applicationId)] }))
      .limit(1)
      .for("update");
    if (!app) throw notFound("Application not found");
    if (app.isDefault) throw invalidRequest("Cannot delete default application");

    const docRows = await tx
      .select({ storageKey: documents.storageKey, size: documents.size })
      .from(documents)
      .where(eq(documents.applicationId, applicationId));
    const uploadRows = await tx
      .select({ storageKey: uploads.storageKey })
      .from(uploads)
      .where(eq(uploads.applicationId, applicationId));
    const runRows = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.applicationId, applicationId));

    const storageJobs: StorageDeletionJobInput[] = [];
    for (const r of [...docRows, ...uploadRows]) {
      const job = storageKeyToDeletionJob(r.storageKey, "application_deleted");
      if (job) storageJobs.push(job);
    }
    for (const r of runRows) {
      storageJobs.push({
        bucket: RUN_WORKSPACE_BUCKET,
        storageKey: runWorkspaceBundleKey(r.id),
        reason: "application_deleted",
      });
      storageJobs.push({
        bucket: RUN_WORKSPACE_BUCKET,
        storageKey: runWorkspaceManifestKey(r.id),
        reason: "application_deleted",
      });
    }
    await enqueueStorageDeletion(tx, storageJobs);

    const bytes = docRows.reduce((sum, row) => sum + row.size, 0);
    if (bytes > 0) await decrementOrgDocumentBytes(tx, orgId, bytes);

    const deleted = await tx
      .delete(applications)
      .where(scopedWhere(applications, { orgId, extra: [eq(applications.id, applicationId)] }))
      .returning({ id: applications.id });
    if (deleted.length === 0) throw notFound("Application not found");
  });
}
