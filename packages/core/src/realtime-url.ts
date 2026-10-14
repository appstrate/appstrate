// SPDX-License-Identifier: Apache-2.0

import { VIEW_AS_QUERY } from "./permissions.ts";

/**
 * URL of the realtime SSE stream: the org-wide one (`/api/realtime/runs`), or
 * one run's (`/api/realtime/runs/:id`) when `runId` is given.
 *
 * `EventSource` cannot send headers, so the scope (`orgId`, `spaceId`) and a
 * role preview (`viewAs`, which the realtime routes refuse as a header) travel
 * in the query. `channels` narrows what the stream carries to the events the
 * caller reads — an undeclared stream also delivers every other channel the
 * caller may see; `verbose` keeps `run_log.data` in the payload.
 */
export function realtimeRunsUrl(args: {
  orgId: string;
  spaceId: string;
  runId?: string;
  channels?: readonly string[];
  verbose?: boolean;
  viewAs?: string | null | undefined;
}): string {
  const qs = new URLSearchParams({ orgId: args.orgId, spaceId: args.spaceId });
  if (args.verbose) qs.set("verbose", "true");
  if (args.channels?.length) qs.set("channels", args.channels.join(","));
  if (args.viewAs) qs.set(VIEW_AS_QUERY, args.viewAs);
  const path = args.runId ? `/${encodeURIComponent(args.runId)}` : "";
  return `/api/realtime/runs${path}?${qs.toString()}`;
}
