// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Holder for the two organization queries this module reads off its init context.
 *
 * "Who owns this org" and "is this user id one of its members" are answers the platform
 * owns, so they are asked through `ModuleInitContext` rather than through SQL of our own
 * — this module's pool reaches its `ee_*` tables, never a platform one. The `Pick` keeps
 * the shape core's to define; a redeclaration would compile against a moved contract.
 */

import type { ModuleInitContext } from "@appstrate/core/module";

/** The slice of the platform's init context this module keeps after `init()`. */
export type EeOrgQueries = Pick<ModuleInitContext, "getOrgOwnerEmails" | "getOrgMembers">;

let _queries: EeOrgQueries | null = null;

export function setOrgQueries(queries: EeOrgQueries): void {
  _queries = queries;
}

export function getOrgQueries(): EeOrgQueries {
  if (!_queries) throw new Error("EE not initialized. Call init() first.");
  return _queries;
}
