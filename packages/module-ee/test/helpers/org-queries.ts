/**
 * Test double for the two organization queries cloud narrows its init context
 * with (`src/platform-org-queries.ts`). Cloud runs its own database and has no
 * access to the platform's members table, so tests seed an in-memory org
 * directory instead of a platform DB — the same posture as `mock-platform.ts`
 * for the usage ledger.
 */

import type { CloudOrgQueries, PlatformOrgMember } from "../../src/platform-org-queries.ts";

/** `orgId` → the org's members, as the platform would resolve them. */
const directory = new Map<string, PlatformOrgMember[]>();

export function resetOrgDirectory(): void {
  directory.clear();
}

/** Seed one org's membership. Replaces whatever was there. */
export function seedOrgMembers(orgId: string, members: PlatformOrgMember[]): void {
  directory.set(orgId, members);
}

export const orgQueries: CloudOrgQueries = {
  getOrgOwnerEmails: async (orgId) =>
    (directory.get(orgId) ?? []).filter((m) => m.role === "owner").map((m) => m.email),
  // Mirrors the contract's one load-bearing detail: an id that is not a member
  // of this org is ABSENT from the result rather than reported as an error.
  getOrgMembers: async (orgId, userIds) =>
    (directory.get(orgId) ?? []).filter((m) => userIds.includes(m.userId)),
};
