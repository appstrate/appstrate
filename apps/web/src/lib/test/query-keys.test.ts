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
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  runKeys,
  packageKeys,
  invalidateAfterDelete,
  invalidateRunDetails,
  invalidateRunLogs,
} from "../query-keys.ts";

const ORG = "org_1";
const SPACE = "spc_1";
const RUN = "run_1";

function seededClient() {
  const qc = new QueryClient();
  qc.setQueryData(runKeys.detail(ORG, SPACE, RUN), { id: RUN });
  qc.setQueryData(runKeys.logs(ORG, SPACE, RUN), []);
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
    expect(isInvalidated(qc, runKeys.detail(ORG, SPACE, RUN))).toBe(true);
    expect(isInvalidated(qc, runKeys.logs(ORG, SPACE, RUN))).toBe(false);
  });

  it("marks the run's logs stale so the terminal transition refetches them", async () => {
    const qc = seededClient();
    await invalidateRunLogs(qc, ORG, SPACE, RUN);
    expect(isInvalidated(qc, runKeys.logs(ORG, SPACE, RUN))).toBe(true);
  });

  it("touches only the run it was given", async () => {
    const qc = seededClient();
    qc.setQueryData(runKeys.logs(ORG, SPACE, "run_2"), []);
    await invalidateRunLogs(qc, ORG, SPACE, RUN);
    expect(isInvalidated(qc, runKeys.logs(ORG, SPACE, "run_2"))).toBe(false);
  });
});

describe("run detail cache invalidation", () => {
  it("marks a cached run stale when deleting one of its files", async () => {
    const qc = seededClient();
    await invalidateRunDetails(qc);
    expect(isInvalidated(qc, runKeys.detail(ORG, SPACE, RUN))).toBe(true);
  });

  it("does not invalidate the separate run-log family", async () => {
    const qc = seededClient();
    await invalidateRunDetails(qc);
    expect(isInvalidated(qc, runKeys.logs(ORG, SPACE, RUN))).toBe(false);
  });
});

describe("invalidation after a delete (#1678)", () => {
  const list = packageKeys.list("skills", ORG, SPACE);
  const deleted = packageKeys.detail("skills", ORG, SPACE, "@acme/gone");
  const kept = packageKeys.detail("skills", ORG, SPACE, "@acme/kept");

  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** A client with all three reads MOUNTED, counting the requests each one issues. */
  async function mounted() {
    const qc = new QueryClient();
    const fetches = new Map<string, number>();
    for (const queryKey of [list, deleted, kept]) {
      const id = JSON.stringify(queryKey);
      const observer = new QueryObserver(qc, {
        queryKey,
        queryFn: () => {
          fetches.set(id, (fetches.get(id) ?? 0) + 1);
          return Promise.resolve(id);
        },
        staleTime: Infinity,
      });
      observer.subscribe(() => {});
    }
    await settled();
    return { qc, count: (key: readonly unknown[]) => fetches.get(JSON.stringify(key)) };
  }

  it("refetches the family but not the reads of the deleted resource", async () => {
    const { qc, count } = await mounted();
    expect([count(list), count(deleted), count(kept)]).toEqual([1, 1, 1]);

    invalidateAfterDelete(qc, packageKeys.family("skills"), (key) =>
      packageKeys.isDetailOf(key, "@acme/gone"),
    );
    await settled();

    // The page still mounted on the deleted package would only fetch a 404.
    expect([count(list), count(deleted), count(kept)]).toEqual([2, 1, 2]);
    // …but its cached answer is stale: the next visit asks the server.
    expect(isInvalidated(qc, deleted)).toBe(true);
  });
});
