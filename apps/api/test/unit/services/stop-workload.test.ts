// SPDX-License-Identifier: Apache-2.0

/**
 * `stopWorkloadAndWait` is the bounded stop that runs BEFORE a run is
 * finalized (cancel route + stall watchdog). Its whole value is in the two
 * unhappy paths: a wedged runtime must not hold the finalize open, and a
 * failing stop must not turn into a rejection the caller never catches.
 *
 * Neither path is exercised anywhere else — every other orchestrator stub in
 * the suite resolves `stopByRunId` immediately, so the `Promise.race` and the
 * `.catch` arm are both dead weight as far as the rest of the tests can tell.
 * Collapse the race to a bare `await` and the watchdog's sequential sweep
 * blocks forever on the first wedged host; drop the `.catch` and a stop
 * failure rejects out of a helper documented as never rejecting.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { createFakeOrchestrator } from "../../helpers/run-connection-fixtures.ts";
import {
  _setOrchestratorForTesting,
  type RunOrchestrator,
  type StopResult,
} from "../../../src/services/orchestrator/index.ts";
import { stopWorkloadAndWait } from "../../../src/services/stop-workload.ts";

/** The shared inert orchestrator with ONE method swapped for this test. */
function withStop(stopByRunId: RunOrchestrator["stopByRunId"]): void {
  _setOrchestratorForTesting({ ...createFakeOrchestrator(), stopByRunId });
}

describe("stopWorkloadAndWait", () => {
  afterEach(() => {
    _setOrchestratorForTesting(null);
  });

  it("reports success when the workload stop acks", async () => {
    withStop(async (): Promise<StopResult> => "stopped");
    expect(await stopWorkloadAndWait("run_ack", 1_000)).toBe(true);
  });

  it("gives up on a wedged runtime instead of blocking the caller forever", async () => {
    // A stop that never settles — a wedged Docker daemon / unreachable remote
    // runner. Without the timeout race this call never returns and the
    // watchdog's sequential sweep stops finalizing ANY run behind it.
    withStop(() => new Promise<StopResult>(() => {}));
    expect(await stopWorkloadAndWait("run_wedged", 25)).toBe(false);
  });

  it("reports failure rather than rejecting when the stop throws", async () => {
    // The callers do not try/catch: a rejection here escapes into the cancel
    // route / the watchdog tick and skips the finalize entirely.
    withStop(async (): Promise<StopResult> => {
      throw new Error("daemon refused the stop");
    });
    expect(await stopWorkloadAndWait("run_throws", 1_000)).toBe(false);
  });
});
