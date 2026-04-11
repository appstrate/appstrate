// SPDX-License-Identifier: Apache-2.0

/**
 * End-user mapping service.
 *
 * When an end-user authenticates via the OIDC flow for a specific application,
 * this service maps the global Better Auth `user` identity to an application-
 * scoped `end_users` row — creating both the `end_users` record and the
 * module-owned `oidc_end_user_profiles` shadow row on first sight.
 *
 * Resolution order (mirrors the Google Accounts → per-service profile model):
 *   1. Join `end_users ⋈ oidc_end_user_profiles` on `authUserId` within the
 *      target `applicationId`. If a profile already links this auth identity
 *      to an end-user in this app, return it.
 *   2. If the auth identity's email is strictly verified, look for an API-
 *      created `end_users` row in this app with the same email AND no profile
 *      row yet (or a profile row with `authUserId IS NULL`). If found, link it.
 *   3. Otherwise create a fresh `end_users` row + companion profile row.
 *
 * All linking steps handle the race where two concurrent token issuances hit
 * the same auth identity simultaneously. On unique-constraint violation we
 * re-fetch rather than propagate the error.
 *
 * Phase 1 note: the core `end_users` table is NEVER widened — `authUserId`,
 * `status`, and `emailVerified` live on `oidc_end_user_profiles`, keyed by
 * `end_user_id`. Phase 0's invariant (core `end_users` has no OIDC vocabulary)
 * is preserved.
 */

import { eq, and, isNull, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { endUsers, applications } from "@appstrate/db/schema";
import { logger } from "../../../lib/logger.ts";
import { prefixedId } from "../../../lib/ids.ts";
import { oidcEndUserProfiles } from "../schema.ts";

export interface AuthIdentity {
  /** Better Auth `user.id`. */
  id: string;
  /** Better Auth `user.email` — lowercased + trimmed before use. */
  email: string;
  name?: string | null;
  /** `true` only when Better Auth explicitly verified the email (strict). */
  emailVerified?: boolean;
}

export interface ResolvedEndUser {
  endUserId: string;
  applicationId: string;
  orgId: string;
  email: string | null;
  name: string | null;
}

/**
 * Thrown when the OIDC flow cannot safely create / adopt an end-user because
 * a row with the same email already exists in the application and the auth
 * identity has not strictly verified ownership of that email. Bubbling up an
 * explicit error (rather than silently adopting or raw-crashing on the unique
 * index) prevents account-takeover via unverified login.
 */
export class UnverifiedEmailConflictError extends Error {
  readonly applicationId: string;
  readonly email: string;
  constructor(applicationId: string, email: string) {
    super(
      `OIDC: an end-user with email '${email}' already exists in application '${applicationId}' ` +
        `and the authenticating identity has not verified the email address. Refusing to link.`,
    );
    this.name = "UnverifiedEmailConflictError";
    this.applicationId = applicationId;
    this.email = email;
  }
}

export async function resolveOrCreateEndUser(
  authUser: AuthIdentity,
  applicationId: string,
): Promise<ResolvedEndUser> {
  // Step 1: already linked via oidc_end_user_profiles → return existing end-user.
  const linked = await findLinkedEndUser(authUser.id, applicationId);
  if (linked) return linked;

  // Step 2: API-created end-user with matching email, not yet linked to any auth identity.
  // Strict === true guard: reject undefined / null / false to prevent takeover when
  // SMTP verification is disabled or the auth provider reports an unverified address.
  const email = authUser.email ? authUser.email.toLowerCase().trim() : null;
  if (email && authUser.emailVerified === true) {
    const adopted = await adoptEndUserByEmail(authUser, applicationId);
    if (adopted) return adopted;
  } else if (email) {
    // Email is known but not strictly verified — if a row with this email already
    // exists in the app, we MUST NOT silently create a duplicate or adopt.
    // Refuse and let the caller surface a "verify your email" prompt.
    const clash = await db
      .select({ id: endUsers.id })
      .from(endUsers)
      .where(and(eq(endUsers.applicationId, applicationId), eq(endUsers.email, email)))
      .limit(1);
    if (clash.length > 0) {
      throw new UnverifiedEmailConflictError(applicationId, email);
    }
  }

  // Step 3: create fresh end_users + oidc_end_user_profiles rows.
  return createEndUser(authUser, applicationId);
}

async function findLinkedEndUser(
  authUserId: string,
  applicationId: string,
): Promise<ResolvedEndUser | null> {
  const [row] = await db
    .select({
      endUserId: endUsers.id,
      applicationId: endUsers.applicationId,
      orgId: endUsers.orgId,
      email: endUsers.email,
      name: endUsers.name,
    })
    .from(oidcEndUserProfiles)
    .innerJoin(endUsers, eq(endUsers.id, oidcEndUserProfiles.endUserId))
    .where(
      and(
        eq(oidcEndUserProfiles.authUserId, authUserId),
        eq(endUsers.applicationId, applicationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function adoptEndUserByEmail(
  authUser: AuthIdentity,
  applicationId: string,
): Promise<ResolvedEndUser | null> {
  const email = authUser.email.toLowerCase().trim();

  // LEFT JOIN so we pick up end_users with no profile row yet (orphaned API-created).
  const [candidate] = await db
    .select({
      endUserId: endUsers.id,
      applicationId: endUsers.applicationId,
      orgId: endUsers.orgId,
      email: endUsers.email,
      name: endUsers.name,
      existingAuthUserId: oidcEndUserProfiles.authUserId,
    })
    .from(endUsers)
    .leftJoin(oidcEndUserProfiles, eq(oidcEndUserProfiles.endUserId, endUsers.id))
    .where(
      and(
        eq(endUsers.applicationId, applicationId),
        eq(endUsers.email, email),
        // Not already linked to a DIFFERENT auth identity.
        // (Either no profile row at all, or profile row with null authUserId.)
        sql`(${oidcEndUserProfiles.authUserId} IS NULL OR ${oidcEndUserProfiles.authUserId} = ${authUser.id})`,
      ),
    )
    .limit(1);

  if (!candidate) return null;

  // If a profile row already exists and already links to this auth identity, we're done.
  if (candidate.existingAuthUserId === authUser.id) {
    return {
      endUserId: candidate.endUserId,
      applicationId: candidate.applicationId,
      orgId: candidate.orgId,
      email: candidate.email,
      name: candidate.name,
    };
  }

  // Otherwise upsert the profile row with this auth identity.
  const linked = await linkProfileAtomic(candidate.endUserId, authUser.id);
  if (!linked) {
    // Lost the race — re-fetch via step 1.
    return findLinkedEndUser(authUser.id, applicationId);
  }

  logger.info("Linked existing end-user to OIDC auth identity", {
    module: "oidc",
    endUserId: candidate.endUserId,
    authUserId: authUser.id,
    applicationId,
  });
  return {
    endUserId: candidate.endUserId,
    applicationId: candidate.applicationId,
    orgId: candidate.orgId,
    email: candidate.email,
    name: candidate.name,
  };
}

/**
 * Atomically upsert the profile row so the link only succeeds if no other
 * auth identity has claimed this end-user in the meantime.
 *
 * Returns `true` if we won the race, `false` if somebody else did.
 */
async function linkProfileAtomic(endUserId: string, authUserId: string): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .insert(oidcEndUserProfiles)
    .values({
      endUserId,
      authUserId,
      emailVerified: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: oidcEndUserProfiles.endUserId,
      set: { authUserId, emailVerified: true, updatedAt: now },
      where: isNull(oidcEndUserProfiles.authUserId),
    })
    .returning({ endUserId: oidcEndUserProfiles.endUserId });
  return rows.length > 0;
}

async function createEndUser(
  authUser: AuthIdentity,
  applicationId: string,
): Promise<ResolvedEndUser> {
  const [app] = await db
    .select({ orgId: applications.orgId })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);
  if (!app) {
    throw new Error(`OIDC: application '${applicationId}' not found`);
  }

  const endUserId = prefixedId("eu");
  const email = authUser.email ? authUser.email.toLowerCase().trim() : null;
  const now = new Date();

  try {
    const inserted = await db
      .insert(endUsers)
      .values({
        id: endUserId,
        applicationId,
        orgId: app.orgId,
        externalId: email, // OIDC-created end-users use email as externalId by default
        email,
        name: authUser.name ?? email,
        createdAt: now,
        updatedAt: now,
      })
      .returning({
        endUserId: endUsers.id,
        applicationId: endUsers.applicationId,
        orgId: endUsers.orgId,
        email: endUsers.email,
        name: endUsers.name,
      });
    if (inserted.length === 0) {
      throw new Error("OIDC: failed to create end-user row");
    }
    const row = inserted[0]!;
    await db.insert(oidcEndUserProfiles).values({
      endUserId,
      authUserId: authUser.id,
      emailVerified: authUser.emailVerified === true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    logger.info("Created end-user via OIDC", {
      module: "oidc",
      endUserId,
      authUserId: authUser.id,
      applicationId,
    });
    return row;
  } catch (err) {
    // Unique-constraint race on the email index → re-run step 1, then step 2.
    if (isUniqueViolation(err)) {
      const linked = await findLinkedEndUser(authUser.id, applicationId);
      if (linked) return linked;
      if (authUser.email && authUser.emailVerified === true) {
        const adopted = await adoptEndUserByEmail(authUser, applicationId);
        if (adopted) return adopted;
      }
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code?: string }).code === "23505";
}

/**
 * Light-weight lookup used by the auth strategy when the incoming JWT already
 * carries `endUserId` + `applicationId` claims — skip the full resolve path and
 * just pull the owning org.
 */
export async function lookupEndUser(
  endUserId: string,
): Promise<(ResolvedEndUser & { status: string }) | null> {
  const [row] = await db
    .select({
      endUserId: endUsers.id,
      applicationId: endUsers.applicationId,
      orgId: endUsers.orgId,
      email: endUsers.email,
      name: endUsers.name,
      status: oidcEndUserProfiles.status,
    })
    .from(endUsers)
    .leftJoin(oidcEndUserProfiles, eq(oidcEndUserProfiles.endUserId, endUsers.id))
    .where(eq(endUsers.id, endUserId))
    .limit(1);
  if (!row) return null;
  return { ...row, status: row.status ?? "active" };
}
