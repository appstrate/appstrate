// SPDX-License-Identifier: Apache-2.0

/**
 * A run, schedule, file or agent list spanning spaces polls while mounted: the SSE stream carries
 * the current space only, so a new row (or an agent's running and unread counts) of another space
 * would otherwise never appear. A list of the current space alone does not poll (the stream keeps
 * it live), nor does a package index, which carries nothing a run moves.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { render } = await import("../../test/render.tsx");
const { useRuns } = await import("../use-paginated-runs.ts");
const { useAllSchedules } = await import("../use-schedules.ts");
const { useFiles, useFilesPaged } = await import("../use-files.ts");
const { useAgents, usePackageList } = await import("../use-packages.ts");
const { ACROSS_SPACES_POLL_MS } = await import("../../lib/across-spaces.ts");

/** The `refetchInterval` the hook's query was built with, keyed under `prefix`. */
function intervalOf(useHook: () => unknown, ...prefix: string[]): unknown {
  const queryClient = new QueryClient();
  function Probe() {
    useHook();
    return null;
  }
  render(<Probe />, { queryClient });
  const query = queryClient.getQueryCache().findAll({ queryKey: prefix })[0];
  expect(query).toBeDefined();
  return (query!.options as { refetchInterval?: unknown }).refetchInterval;
}

describe("polling a list spanning spaces", () => {
  it("polls the runs list across spaces, not the current space's", () => {
    const runs = (spanning: boolean) => () => useRuns({ spanning, limit: 15 });
    expect(intervalOf(runs(true), "paginated-runs")).toBe(ACROSS_SPACES_POLL_MS);
    expect(intervalOf(runs(false), "paginated-runs")).toBeUndefined();
  });

  it("polls the schedules list across spaces, not the current space's", () => {
    expect(intervalOf(() => useAllSchedules(true), "schedules")).toBe(ACROSS_SPACES_POLL_MS);
    expect(intervalOf(() => useAllSchedules(), "schedules")).toBeUndefined();
  });

  it("polls the agent index across spaces, not the current space's", () => {
    expect(intervalOf(() => useAgents(true), "agents")).toBe(ACROSS_SPACES_POLL_MS);
    expect(intervalOf(() => useAgents(), "agents")).toBeUndefined();
  });

  it("does not poll a package index across spaces", () => {
    expect(intervalOf(() => usePackageList("skill", true), "packages")).toBeUndefined();
  });

  it("polls the files list across spaces, not the current space's", () => {
    expect(
      intervalOf(() => useFilesPaged({ spanning: true }), "get", "/api/orgs/{orgId}/files"),
    ).toBe(ACROSS_SPACES_POLL_MS);
    expect(intervalOf(() => useFilesPaged(), "get", "/api/files")).toBeUndefined();
  });

  it("polls a conversation's files across spaces, not the current space's", () => {
    expect(intervalOf(() => useFiles({ spanning: true }), "get", "/api/orgs/{orgId}/files")).toBe(
      ACROSS_SPACES_POLL_MS,
    );
    expect(intervalOf(() => useFiles(), "get", "/api/files")).toBeUndefined();
  });
});
