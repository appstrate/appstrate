// SPDX-License-Identifier: Apache-2.0

// Scoping headers for hand-rolled fetches that bypass the typed API client
// (SSE streams, uploads) — mirrors the `X-Org-Id` / `X-Space-Id`
// injection the client middleware performs (see `api/client.ts`). Module
// shells hand this to their packaged UI as the `getHeaders` prop.

import { VIEW_AS_HEADER, VIEW_AS_QUERY } from "@appstrate/core/permissions";
import { getCurrentOrgId } from "../stores/org-store";
import { getCurrentSpaceId } from "../stores/space-store";
import { getViewAsHeader } from "../stores/view-as-store";

/**
 * Single source of truth for the org/space scoping-header wire contract.
 * The typed API client middleware (`api/client.ts`) and the hand-rolled
 * fetches both consume this so the header names can never drift apart.
 *
 * `viewAs` defaults to the store and is only ever passed explicitly by a
 * React caller that needs the persona to be a real dependency — see
 * {@link withViewAsParam}.
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
 * Add the persona to a `/api/realtime/*` URL. Those routes REFUSE the header
 * (a header there is a client bug, since the browser client is an
 * `EventSource`), so the query parameter is the only carrier — and a stream
 * left header-less would keep pushing the caller's real authority into a
 * previewed page.
 *
 * `viewAs` is a parameter rather than a store read because a stream reads its
 * URL exactly once, at connect: the caller must hold the value reactively
 * (`useViewAsHeader()`) and list it in the effect's dependencies, or entering
 * and leaving a preview would leave the open connection on the other authority.
 */
export function withViewAsParam(url: string, viewAs = getViewAsHeader()): string {
  if (!viewAs) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${VIEW_AS_QUERY}=${encodeURIComponent(viewAs)}`;
}
