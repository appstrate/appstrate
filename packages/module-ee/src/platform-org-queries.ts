// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * The two organization queries EE needs from the platform, and the holder
 * that keeps the handle captured at `init(ctx)`.
 *
 * EE runs its own database and never joins a platform-owned table, so
 * "who owns this org" and "is this user id one of its members" can only be
 * answered by the platform. Both used to hide behind a single
 * `getOrgAdminEmails(orgId)` on `ModuleInitContext` — a fan-out to every admin
 * that answered neither question: it could not name a specific user, and it
 * addressed people who are not the billing contact. It is replaced here by two
 * narrower lookups, each one indexed query.
 *
 * They are declared in EE rather than read off `ModuleInitContext` verbatim
 * because EE is the consumer that defines them; the platform satisfies the
 * shape through {@link EeInitContext}, which is what the module's `init`
 * signature actually asks for. Nothing at runtime checks that the platform
 * provides them: the module is a `workspace:*` package typechecked against the
 * workspace `ModuleInitContext`, so `tsc` is the guarantee.
 */

import type { ModuleInitContext } from "@appstrate/core/module";
import type { OrgRole } from "./types.ts";

/** One organization member, as {@link EeOrgQueries.getOrgMembers} resolves it. */
export interface PlatformOrgMember {
  userId: string;
  email: string;
  role: OrgRole;
}

export interface EeOrgQueries {
  /**
   * Email addresses of the org's `owner`s, in no guaranteed order. The live
   * fallback for an account with no billing contact set — owners, not admins:
   * an invoice is addressed to whoever answers for the organization, and
   * widening that to every admin is how a receipt ends up in six inboxes.
   * Empty when the org has no owner (or no longer exists).
   */
  getOrgOwnerEmails(orgId: string): Promise<string[]>;
  /**
   * Resolve `userIds` to org members. A id that is not a member of `orgId` —
   * or not a user at all — is simply ABSENT from the result, which is what
   * makes this one call both the membership check for a billing-manager write
   * and the address book for the resulting recipients.
   */
  getOrgMembers(orgId: string, userIds: readonly string[]): Promise<PlatformOrgMember[]>;
}

/**
 * The init context EE requires: the platform contract plus the two queries
 * above. `AppstrateModule.init` is a method, so declaring the parameter as
 * this narrower type is accepted — and it states the requirement where a
 * reader of `init()` sees it, instead of in a comment.
 */
export type EeInitContext = ModuleInitContext & EeOrgQueries;

let _queries: EeOrgQueries | null = null;

export function setOrgQueries(queries: EeOrgQueries): void {
  _queries = queries;
}

export function getOrgQueries(): EeOrgQueries {
  if (!_queries) throw new Error("EE not initialized. Call init() first.");
  return _queries;
}
