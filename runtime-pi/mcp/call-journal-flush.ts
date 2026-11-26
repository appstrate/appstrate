// SPDX-License-Identifier: Apache-2.0

import { getErrorMessage } from "@appstrate/core/errors";
import { SIDECAR_AUTH_HEADER } from "@appstrate/core/sidecar-types";
import type { EventSink } from "@appstrate/afps-runtime/interfaces";

/** Above the sidecar's journal POST timeout (3 s), so a flush that is landing is not cut short. */
const FLUSH_TIMEOUT_MS = 5_000;

/**
 * Ask the sidecar to send its queued call journal (`POST /calls/flush`) and wait until it has.
 * The platform takes the journal only while the run is `running`, and the finalize POST ends that,
 * so this runs first. Best-effort and bounded: a failure costs the queued records, never the run.
 */
export async function flushSidecarCallJournal(
  sidecarUrl: string,
  authToken: string,
  fetchFn: typeof fetch = fetch,
  log: (line: string) => void = (line) => process.stderr.write(line),
): Promise<void> {
  try {
    const res = await fetchFn(`${sidecarUrl.replace(/\/$/, "")}/calls/flush`, {
      method: "POST",
      headers: { [SIDECAR_AUTH_HEADER]: authToken },
      signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
    });
    if (!res.ok) log(`[call-journal] flush answered HTTP ${res.status}\n`);
  } catch (err) {
    log(`[call-journal] flush failed: ${getErrorMessage(err)}\n`);
  }
}

/** `sink`, with every finalize preceded by `flush`. */
export function flushBeforeFinalize(sink: EventSink, flush: () => Promise<void>): EventSink {
  return {
    handle: (event) => sink.handle(event),
    finalize: async (result) => {
      await flush();
      await sink.finalize(result);
    },
  };
}
