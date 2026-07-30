// SPDX-License-Identifier: Apache-2.0

/**
 * Run-cache invalidation reach (#1046).
 *
 * The bug this pins is invisible at the call site and silent at runtime: a
 * `queryKey` prefix that matches nothing still resolves happily, so a cache that
 * is never refetched looks exactly like a cache that is always fresh. Asserting
 * it against a REAL `QueryClient` — not a stub — is the point: the matching rule
 * under test is React Query's, not ours.
 */

import { describe, it, expect } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { runKeys, invalidateRunLogs } from "../query-keys.ts";

const ORG = "org_1";
const APP = "app_1";
const RUN = "run_1";

function seededClient() {
  const qc = new QueryClient();
  qc.setQueryData(runKeys.detail(ORG, APP, RUN), { id: RUN });
  qc.setQueryData(runKeys.logs(ORG, APP, RUN), []);
  return qc;
}

const isInvalidated = (qc: QueryClient, key: readonly unknown[]) =>
  qc.getQueryState(key)?.isInvalidated;

describe("run log cache invalidation", () => {
  it("is NOT reachable from `runKeys.all`, which the global terminal invalidation fires", async () => {
    // `["run"]` vs `["run-logs", …]`: React Query compares element 0, and those
    // two strings are simply different — so `invalidateRunAndNotificationQueries`
    // refetches the run row and leaves its logs untouched. This is the premise
    // the helper below exists for; if it ever stops holding (say the logs family
    // is re-keyed under `["run", …]`), the helper is redundant and this fails.
    const qc = seededClient();
    await qc.invalidateQueries({ queryKey: runKeys.all });
    expect(isInvalidated(qc, runKeys.detail(ORG, APP, RUN))).toBe(true);
    expect(isInvalidated(qc, runKeys.logs(ORG, APP, RUN))).toBe(false);
  });

  it("marks the run's logs stale so the terminal transition refetches them", async () => {
    const qc = seededClient();
    await invalidateRunLogs(qc, ORG, APP, RUN);
    expect(isInvalidated(qc, runKeys.logs(ORG, APP, RUN))).toBe(true);
  });

  it("touches only the run it was given", async () => {
    const qc = seededClient();
    qc.setQueryData(runKeys.logs(ORG, APP, "run_2"), []);
    await invalidateRunLogs(qc, ORG, APP, RUN);
    expect(isInvalidated(qc, runKeys.logs(ORG, APP, "run_2"))).toBe(false);
  });
});
