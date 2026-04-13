// SPDX-License-Identifier: Apache-2.0

/**
 * Org-membership mapping service.
 *
 * Mirror of `enduser-mapping.ts` for org-level OAuth clients: when a user
 * authenticates through a client pinned to an organization, this service
 * either returns their existing `organization_members` role, or — when the
 * client's signup policy allows it — auto-provisions a fresh membership row
 * with the configured role.
 *
 * Resolution order:
 *   1. `SELECT role FROM org_members WHERE user_id = ? AND org_id = ?` — if
 *      the user is already a member, return their current role (happy path,
 *      idempotent, zero writes).
 *   2. If not a member AND `policy.allowSignup === false` → throw
 *      `OrgSignupClosedError`. The caller renders a clear error page (server
 *      side) or short-circuits the OAuth redirect chain with a
 *      `signup_disabled` error.
 *   3. `INSERT … ON CONFLICT DO NOTHING RETURNING role` with the configured
 *      `signupRole`. If the INSERT lost the race (another concurrent login
 *      won), re-fetch via step 1. The returning row is authoritative.
 *
 * The OAuth client itself stores the mutable policy (`allow_signup`,
 * `signup_role`) in dedicated SQL columns — NOT in the frozen `metadata` JSON
 * column that `@better-auth/oauth-provider` reads at client-registration
 * time. This lets admins toggle the policy without touching immutable client
 * state; the short-TTL cache in `oauth-admin.ts::getClientCached` propagates
 * changes within 30s (invalidated synchronously on `updateClient`).
 *
 * ## Race-safety invariant (matches `resolveOrCreateEndUser`)
 *
 * Two concurrent token-mint closures for the same `(authUser.id, orgId)` are
 * race-safe because each step is individually atomic:
 *
 *   1. `findMembership` — single SELECT on the PK `(org_id, user_id)`.
 *      Idempotent.
 *   2. Policy check — pure function, no I/O.
 *   3. `INSERT ... ON CONFLICT DO NOTHING RETURNING role` — only one caller
 *      wins; the loser re-runs step 1 and sees the winner's committed row.
 *
 * ## Double-call safety
 *
 * This function is called twice on the happy path for org-level clients:
 *   - Proactively in `routes.ts::POST /api/oauth/login` (and
 *     `POST /api/oauth/register` after signup) — catches
 *     `OrgSignupClosedError` and renders a 403 page with a clear message.
 *   - Again at token mint in `auth/plugins.ts::buildOrgLevelClaims` — this
 *     call is a no-op when the proactive call already created the row (step 1
 *     short-circuits with SELECT-only).
 *
 * WARNING: do NOT add observable side effects (events, webhooks, audit logs)
 * inside `resolveOrCreateOrgMembership`. They would fire TWICE. If you need
 * a "first-join" hook, return a `created: boolean` flag and gate side effects
 * on it in the caller.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { organizationMembers } from "@appstrate/db/schema";
import { logger } from "../../../lib/logger.ts";
import type { OrgRole } from "../../../types/index.ts";
import type { AuthIdentity } from "../auth/types.ts";
import { getClientCached } from "./oauth-admin.ts";

export interface OrgSignupPolicy {
  /** When false, non-members are rejected with `OrgSignupClosedError`. */
  allowSignup: boolean;
  /** Role assigned on auto-join. `owner` is disallowed by the schema. */
  signupRole: Exclude<OrgRole, "owner">;
}

export interface ResolvedOrgMembership {
  userId: string;
  orgId: string;
  role: OrgRole;
}

/**
 * Thrown when the OIDC flow cannot safely add `user` to `orgId` because the
 * OAuth client's signup policy is closed. The caller is expected to render a
 * rendered error page (server side) or emit a structured OAuth `access_denied`
 * so the downstream client can display a clear message to the end-user.
 */
export class OrgSignupClosedError extends Error {
  readonly orgId: string;
  readonly userId: string;
  readonly email: string;
  constructor(userId: string, orgId: string, email: string) {
    super(
      `OIDC: user '${userId}' (${email}) is not a member of organization '${orgId}' ` +
        `and the OAuth client's signup policy is closed. Refusing to auto-provision.`,
    );
    this.name = "OrgSignupClosedError";
    this.userId = userId;
    this.orgId = orgId;
    this.email = email;
  }
}

/**
 * Resolve (or create) the org membership for an authenticated Better Auth
 * identity against a specific organization, subject to the provided signup
 * policy. See the file header for the full contract and invariants.
 */
export async function resolveOrCreateOrgMembership(
  authUser: AuthIdentity,
  orgId: string,
  policy: OrgSignupPolicy,
): Promise<ResolvedOrgMembership> {
  // Step 1: SELECT-only lookup. Happy path for existing members; second call
  // after `buildOrgLevelClaims` is a no-op here.
  const existing = await findMembership(authUser.id, orgId);
  if (existing) return existing;

  // Step 2: not a member — gate on signup policy.
  if (!policy.allowSignup) {
    throw new OrgSignupClosedError(authUser.id, orgId, authUser.email);
  }

  // Step 3: auto-provision. ON CONFLICT DO NOTHING handles the race between
  // two concurrent logins; if we lose, re-read via step 1.
  const [inserted] = await db
    .insert(organizationMembers)
    .values({
      orgId,
      userId: authUser.id,
      role: policy.signupRole,
    })
    .onConflictDoNothing({
      target: [organizationMembers.orgId, organizationMembers.userId],
    })
    .returning({ role: organizationMembers.role });

  if (inserted) {
    logger.info("oidc: auto-joined user to organization", {
      module: "oidc",
      userId: authUser.id,
      orgId,
      role: inserted.role,
    });
    return { userId: authUser.id, orgId, role: inserted.role };
  }

  // Lost the race — the winning transaction is now committed, re-fetch.
  const afterRace = await findMembership(authUser.id, orgId);
  if (afterRace) return afterRace;

  // Extremely defensive: we successfully ON CONFLICT'd but the re-read
  // returns null. Can only happen if the row was deleted between the INSERT
  // and the SELECT. Fail loud.
  throw new Error(
    `oidc: failed to provision org membership for user '${authUser.id}' in org '${orgId}' (race + disappearing row)`,
  );
}

async function findMembership(
  userId: string,
  orgId: string,
): Promise<ResolvedOrgMembership | null> {
  const [row] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.orgId, orgId)))
    .limit(1);
  return row ? { userId, orgId, role: row.role } : null;
}

/**
 * Load the auto-provisioning policy for an org-level OAuth client, reusing
 * the short-TTL cache from `oauth-admin.ts`. Returns `null` if the client
 * does not exist, is disabled, or is not org-level (policy is meaningful only
 * for org-level clients — application-level clients go through the end-user
 * mapping path instead).
 *
 * This helper is the single entry point for `buildOrgLevelClaims` so the
 * plugin closure does not need to know how the policy is stored or cached.
 */
export async function loadOrgClientPolicy(clientId: string): Promise<{
  orgId: string;
  allowSignup: boolean;
  signupRole: Exclude<OrgRole, "owner">;
} | null> {
  const client = await getClientCached(clientId);
  if (!client || client.disabled) return null;
  if (client.level !== "org" || !client.referencedOrgId) return null;
  return {
    orgId: client.referencedOrgId,
    allowSignup: client.allowSignup,
    signupRole: client.signupRole,
  };
}
