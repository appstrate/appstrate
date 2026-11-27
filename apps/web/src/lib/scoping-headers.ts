// SPDX-License-Identifier: Apache-2.0

import { VIEW_AS_HEADER } from "@appstrate/core/permissions";
import { getCurrentOrgId } from "../stores/org-store";
import { getCurrentSpaceId } from "../stores/space-store";
import { getViewAsHeader } from "../stores/view-as-store";

/**
 * The org/space/persona headers for hand-rolled fetches that bypass the typed
 * client. A hook caller passes the persona and space it read reactively, so a
 * callback built on them changes identity when either does.
 */
export function buildScopingHeaders(
  viewAs = getViewAsHeader(),
  spaceId = getCurrentSpaceId(),
): Record<string, string> {
  const headers: Record<string, string> = {};
  const orgId = getCurrentOrgId();
  if (orgId) headers["X-Org-Id"] = orgId;
  if (spaceId) headers["X-Space-Id"] = spaceId;
  if (viewAs) headers[VIEW_AS_HEADER] = viewAs;
  return headers;
}

/**
 * The scoping headers a request still lacks. One that names another org (a reader
 * link) leaves the previewed context, so it carries no persona: the server judges
 * the persona per org, so another space of the same org keeps it.
 */
export function missingScopingHeaders(
  present: Headers,
  scoping: Record<string, string> = buildScopingHeaders(),
): Record<string, string> {
  const otherOrg = present.has("X-Org-Id") && present.get("X-Org-Id") !== scoping["X-Org-Id"];
  return Object.fromEntries(
    Object.entries(scoping).filter(([k]) => !present.has(k) && !(otherOrg && k === VIEW_AS_HEADER)),
  );
}

/**
 * The request options naming the space a typed-client request acts in (spread into the
 * options): none without `spaceId`, so the middleware scopes it to the working space.
 */
export function spaceHeader(spaceId?: string | null): { headers?: { "X-Space-Id": string } } {
  return spaceId ? { headers: { "X-Space-Id": spaceId } } : {};
}

/** The org/space header params of a typed-client query: scope is part of its React Query key. */
export function scopeHeader(orgId: string | null, spaceId: string | null) {
  return { "X-Org-Id": orgId ?? undefined, "X-Space-Id": spaceId ?? undefined };
}
