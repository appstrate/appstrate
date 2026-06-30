// SPDX-License-Identifier: Apache-2.0

/**
 * Discover the run a blocking `run_and_wait` just launched, BEFORE the tool
 * returns. `run_and_wait` blocks until the run is terminal, so its result (which
 * carries the run id) only arrives after the run is already done — too late to
 * stream logs live. To follow the run while it executes, we listen to the
 * org-wide realtime stream and pick up the run id from the `run_update` frame
 * the new run emits, then hand it to the per-run log stream.
 *
 * Auth mirrors the OAuth connect card: relative URL, `credentials: "include"`,
 * org/app ids forwarded as query params (EventSource can't send headers).
 */

import { useEffect, useState } from "react";
import { useChatHeaders } from "./runtime-context.ts";
import {
  buildOrgRunsSseUrl,
  matchesLaunchedRun,
  orgAppFromHeaders,
  parseRunUpdateDiscovery,
} from "./run-events.ts";

/**
 * @param active true while we still need to discover the id (the tool is
 *               running and its result hasn't surfaced a run id yet).
 * @param correlationId exact id stamped by `run_and_wait` into run metadata.
 */
export function useDiscoverRunId(
  active: boolean,
  correlationId: string | undefined,
): string | undefined {
  const getHeaders = useChatHeaders();
  const [runId, setRunId] = useState<string>();

  useEffect(() => {
    if (!active || !correlationId || runId || typeof EventSource === "undefined") return;
    const { orgId, applicationId } = orgAppFromHeaders(getHeaders?.() ?? {});
    const url = buildOrgRunsSseUrl({ orgId, applicationId });
    if (!url) return;

    const es = new EventSource(url, { withCredentials: true });
    let found = false;

    es.addEventListener("run_update", (e) => {
      if (found) return;
      const update = parseRunUpdateDiscovery((e as MessageEvent).data);
      if (update && matchesLaunchedRun(update, correlationId)) {
        found = true;
        setRunId(update.id); // setState from an SSE callback — allowed by the rules-of-react gate
        es.close();
      }
    });

    return () => es.close();
  }, [active, correlationId, runId, getHeaders]);

  return runId;
}
