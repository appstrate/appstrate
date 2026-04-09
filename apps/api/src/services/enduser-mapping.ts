// SPDX-License-Identifier: Apache-2.0

/**
 * End-User Mapping Service
 *
 * Resolves or creates per-application end-user profiles from Better Auth users.
 * When an end-user authenticates via OIDC for a specific application (client_id),
 * this service maps the global auth identity to the application-scoped end_users row.
 *
 * Pattern: global auth identity (user table) → per-app profile (end_users table)
 * Same model as Google Accounts → per-service data.
 */

import { eq, and, isNull } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { endUsers, applications, connectionProfiles } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { prefixedId } from "../lib/ids.ts";

interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
}

interface ResolvedEndUser {
  id: string;
  applicationId: string;
  email: string | null;
  name: string | null;
  role: string;
}

/**
 * Resolve or create a per-application end-user from a Better Auth user.
 *
 * Resolution order:
 * 1. Find end_users where authUserId matches (already linked)
 * 2. Find end_users where email matches AND authUserId is NULL (API-created, link it)
 * 3. Create a new end_users row with authUserId set
 */
export async function resolveOrCreateEndUser(
  authUser: AuthUser,
  applicationId: string,
): Promise<ResolvedEndUser> {
  // 1. Already linked by authUserId
  const [linked] = await db
    .select({
      id: endUsers.id,
      applicationId: endUsers.applicationId,
      email: endUsers.email,
      name: endUsers.name,
      role: endUsers.role,
    })
    .from(endUsers)
    .where(and(eq(endUsers.authUserId, authUser.id), eq(endUsers.applicationId, applicationId)))
    .limit(1);

  if (linked) return linked;

  // 2. API-created end-user with matching email — link it
  if (authUser.email) {
    const [unlinked] = await db
      .select({
        id: endUsers.id,
        applicationId: endUsers.applicationId,
        email: endUsers.email,
        name: endUsers.name,
        role: endUsers.role,
      })
      .from(endUsers)
      .where(
        and(
          eq(endUsers.applicationId, applicationId),
          eq(endUsers.email, authUser.email.toLowerCase().trim()),
          isNull(endUsers.authUserId),
        ),
      )
      .limit(1);

    if (unlinked) {
      await linkEndUserToAuthUser(unlinked.id, authUser.id);
      logger.info("Linked existing end-user to auth user", {
        endUserId: unlinked.id,
        authUserId: authUser.id,
        applicationId,
      });
      return unlinked;
    }
  }

  // 3. Create new end-user for this application
  // Resolve orgId from the application
  const [app] = await db
    .select({ orgId: applications.orgId })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);

  if (!app) {
    throw new Error(`Application '${applicationId}' not found`);
  }

  const endUserId = prefixedId("eu");
  const now = new Date();
  const email = authUser.email?.toLowerCase().trim() ?? null;

  const [created] = await db
    .insert(endUsers)
    .values({
      id: endUserId,
      applicationId,
      orgId: app.orgId,
      authUserId: authUser.id,
      email,
      name: authUser.name ?? email,
      externalId: email, // Use email as externalId for OIDC-created end-users
      status: "active",
      emailVerified: true, // Inherited from Better Auth user (already verified there)
      createdAt: now,
      updatedAt: now,
    })
    .returning({
      id: endUsers.id,
      applicationId: endUsers.applicationId,
      email: endUsers.email,
      name: endUsers.name,
      role: endUsers.role,
    });

  // Create default connection profile
  await db.insert(connectionProfiles).values({
    endUserId,
    name: "Default",
    isDefault: true,
  });

  logger.info("Created end-user via OIDC authentication", {
    endUserId,
    authUserId: authUser.id,
    applicationId,
  });

  return created!;
}

/**
 * Get an end-user's role by ID. Used as fallback when the JWT token
 * doesn't contain a role claim (legacy tokens pre-role feature).
 */
export async function getEndUserRole(endUserId: string): Promise<string | null> {
  const [row] = await db
    .select({ role: endUsers.role })
    .from(endUsers)
    .where(eq(endUsers.id, endUserId))
    .limit(1);
  return row?.role ?? null;
}

/**
 * Link an existing API-created end-user to a Better Auth user.
 * Called when an end-user with matching email first authenticates via OIDC.
 */
export async function linkEndUserToAuthUser(endUserId: string, authUserId: string): Promise<void> {
  await db
    .update(endUsers)
    .set({
      authUserId,
      emailVerified: true,
      updatedAt: new Date(),
    })
    .where(and(eq(endUsers.id, endUserId), isNull(endUsers.authUserId)));
}
