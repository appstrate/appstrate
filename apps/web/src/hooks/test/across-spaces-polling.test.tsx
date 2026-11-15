// SPDX-License-Identifier: Apache-2.0

/**
 * A run or schedule list spanning spaces polls while mounted: the SSE stream carries the current
 * space only, so a new row of another space would otherwise never appear. A list of the current
 * space alone does not poll (the stream keeps it live).
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { render } = await import("../../test/render.tsx");
const { usePaginatedRuns } = await import("../use-paginated-runs.ts");
const { useAllSchedules } = await import("../use-schedules.ts");
const { ACROSS_SPACES_POLL_MS } = await import("../../lib/across-spaces.ts");

/** The `refetchInterval` the hook's query was built with, keyed under `root`. */
function intervalOf(useHook: () => unknown, root: string): unknown {
  const queryClient = new QueryClient();
  function Probe() {
    useHook();
    return null;
  }
  render(<Probe />, { queryClient });
  const query = queryClient.getQueryCache().findAll({ queryKey: [root] })[0];
  expect(query).toBeDefined();
  return (query!.options as { refetchInterval?: unknown }).refetchInterval;
}

describe("polling a list spanning spaces", () => {
  it("polls the runs list across spaces, not the current space's", () => {
    const runs = (spaceIds?: string[]) => () =>
      usePaginatedRuns({ spaceIds, limit: 15, offset: 0 });
    expect(intervalOf(runs(["spc_a", "spc_b"]), "paginated-runs")).toBe(ACROSS_SPACES_POLL_MS);
    expect(intervalOf(runs(), "paginated-runs")).toBeUndefined();
  });

  it("polls the schedules list across spaces, not the current space's", () => {
    expect(intervalOf(() => useAllSchedules(["spc_a", "spc_b"]), "schedules")).toBe(
      ACROSS_SPACES_POLL_MS,
    );
    expect(intervalOf(() => useAllSchedules(), "schedules")).toBeUndefined();
  });
});
