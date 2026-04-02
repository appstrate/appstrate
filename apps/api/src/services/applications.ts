// SPDX-License-Identifier: Apache-2.0

import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "@appstrate/db/client";
import { applications } from "@appstrate/db/schema";
import { invalidRequest, notFound } from "../lib/errors.ts";
import { prefixedId } from "../lib/ids.ts";

export const appSettingsSchema = z.object({
  allowedRedirectDomains: z.array(z.string()).optional(),
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
    .where(and(eq(applications.orgId, orgId), eq(applications.isDefault, true)))
    .limit(1);

  if (existing[0]) return existing[0];

  return createApplication(orgId, { name: "Default", isDefault: true }, createdBy);
}

/** Get the default application for an organization. Throws 404 if not found. */
export async function getDefaultApplication(orgId: string) {
  const [app] = await db
    .select()
    .from(applications)
    .where(and(eq(applications.orgId, orgId), eq(applications.isDefault, true)))
    .limit(1);

  if (!app) throw notFound("Default application not found");
  return app;
}

/** List all applications for an organization, ordered by creation date (newest first). */
export async function listApplications(orgId: string) {
  return db
    .select()
    .from(applications)
    .where(eq(applications.orgId, orgId))
    .orderBy(desc(applications.createdAt));
}

/** Get a single application by ID, verifying org ownership. Throws 404 if not found. */
export async function getApplication(orgId: string, appId: string) {
  const [app] = await db
    .select()
    .from(applications)
    .where(and(eq(applications.id, appId), eq(applications.orgId, orgId)))
    .limit(1);

  if (!app) throw notFound("Application not found");
  return app;
}

/** Update an application. Throws 404 if not found. */
export async function updateApplication(
  orgId: string,
  appId: string,
  params: { name?: string; settings?: AppSettings },
) {
  const [app] = await db
    .update(applications)
    .set({
      ...(params.name !== undefined && { name: params.name }),
      ...(params.settings !== undefined && { settings: params.settings }),
      updatedAt: new Date(),
    })
    .where(and(eq(applications.id, appId), eq(applications.orgId, orgId)))
    .returning();

  if (!app) throw notFound("Application not found");
  return app;
}

/** Delete an application. Throws 400 if default, 404 if not found. */
export async function deleteApplication(orgId: string, appId: string) {
  // Check existence and default status first
  const [app] = await db
    .select({ id: applications.id, isDefault: applications.isDefault })
    .from(applications)
    .where(and(eq(applications.id, appId), eq(applications.orgId, orgId)))
    .limit(1);

  if (!app) throw notFound("Application not found");
  if (app.isDefault) throw invalidRequest("Cannot delete default application");

  await db
    .delete(applications)
    .where(and(eq(applications.id, appId), eq(applications.orgId, orgId)));
}
