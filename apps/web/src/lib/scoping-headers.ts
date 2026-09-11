// SPDX-License-Identifier: Apache-2.0

import { VIEW_AS_HEADER, VIEW_AS_QUERY } from "@appstrate/core/permissions";
import { getCurrentOrgId } from "../stores/org-store";
import { getCurrentSpaceId } from "../stores/space-store";
import { getViewAsHeader } from "../stores/view-as-store";

/**
 * The org/space/persona scoping headers, for the hand-rolled fetches that
 * bypass the typed client (uploads, module shells' `getHeaders` prop). Shared
 * with the client middleware in `api/client.ts` so the names cannot drift.
 */
export function buildScopingHeaders(viewAs = getViewAsHeader()): Record<string, string> {
  const headers: Record<string, string> = {};
  const orgId = getCurrentOrgId();
  if (orgId) headers["X-Org-Id"] = orgId;
  const spaceId = getCurrentSpaceId();
  if (spaceId) headers["X-Space-Id"] = spaceId;
  if (viewAs) headers[VIEW_AS_HEADER] = viewAs;
  return headers;
}

/**
 * Add the persona to a `/api/realtime/*` URL: those routes refuse the header,
 * and `EventSource` sends none anyway. `viewAs` is passed in rather than read
 * from the store so an effect can depend on it — a stream reads its URL once,
 * at connect, and would otherwise keep streaming the caller's real authority
 * into a previewed page.
 */
export function withViewAsParam(url: string, viewAs: string | null): string {
  if (!viewAs) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${VIEW_AS_QUERY}=${encodeURIComponent(viewAs)}`;
}
