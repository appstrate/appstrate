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
