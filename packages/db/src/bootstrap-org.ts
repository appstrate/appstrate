// SPDX-License-Identifier: Apache-2.0

// Shared bootstrap-org creation logic. Single source of truth for
// auto-creating the root organization for `AUTH_BOOTSTRAP_OWNER_EMAIL`.
//
// Two callers:
//   1. `auth.ts` after-hook  — fires when the bootstrap owner signs up via
//      `/api/auth/sign-up/email`. Errors are logged, never thrown (we do not
//      want a transient DB failure to break signup).
//   2. `apps/api/scripts/bootstrap-org.ts` — explicit ops bootstrap (IaC /
//      recovery). Errors propagate to the caller which decides exit code.
//
// Both paths are idempotent: a second call for an owner that already owns an
// organization returns `{ created: false, reason: "already_owner" }` without
// inserting anything.

import { and, eq } from "drizzle-orm";
import { toSlug } from "@appstrate/core/naming";
import { db } from "./client.ts";
import { organizations } from "./schema.ts";
import { organizationMembers } from "./schema/organizations.ts";

export type CreateBootstrapOrgResult =
  | {
      created: true;
      orgId: string;
      slug: string;
    }
  | {
      created: false;
      reason: "already_owner";
      orgId: string;
      slug: string;
    };

/**
 * Idempotent root-org creation for the bootstrap owner.
 *
 * - Bails with `already_owner` if `userId` already owns any organization.
 * - Otherwise inserts the org + owner membership atomically (per-row;
 *   Better Auth enforces email-uniqueness on the parent user row, so two
 *   concurrent signups of the same bootstrap email cannot both reach this
 *   path — the second BA insert fails on the unique constraint first).
 * - Suffixes the slug on collision (`-2`, `-3`, … up to `-6`) so the
 *   bootstrap never fails halfway through signup. After 5 attempts, the
 *   final insert is allowed to surface the unique-constraint error to the
 *   caller — at that point the operator's slug strategy is unrecoverable.
 *
 * `slugOverride`, when truthy, takes precedence over the name-derived slug.
 */
export async function createBootstrapOrg(
  userId: string,
  orgName: string,
  slugOverride?: string,
): Promise<CreateBootstrapOrgResult> {
  const [existingOwnership] = await db
    .select({ orgId: organizationMembers.orgId, slug: organizations.slug })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.role, "owner")))
    .limit(1);
  if (existingOwnership) {
    return {
      created: false,
      reason: "already_owner",
      orgId: existingOwnership.orgId,
      slug: existingOwnership.slug,
    };
  }

  const baseSlug = (slugOverride && slugOverride.trim()) || toSlug(orgName, 50) || "default";
  let slug = baseSlug;
  for (let attempt = 0; attempt < 5; attempt++) {
    const [collision] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);
    if (!collision) break;
    slug = `${baseSlug}-${attempt + 2}`;
  }

  const [org] = await db
    .insert(organizations)
    .values({ name: orgName, slug, createdBy: userId })
    .returning({ id: organizations.id, slug: organizations.slug });
  if (!org) {
    throw new Error("createBootstrapOrg: organizations insert returned no row");
  }
  await db.insert(organizationMembers).values({
    orgId: org.id,
    userId,
    role: "owner",
  });

  return { created: true, orgId: org.id, slug: org.slug };
}
