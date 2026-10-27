// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { realtimeRunsUrl } from "../src/realtime-url.ts";

describe("realtimeRunsUrl", () => {
  it("builds the org-wide stream with only the channels asked for", () => {
    expect(
      realtimeRunsUrl({ orgId: "org_1", spaceId: "spc_1", channels: ["connection_update"] }),
    ).toBe("/api/realtime/runs?orgId=org_1&spaceId=spc_1&channels=connection_update");
  });

  it("builds one run's stream, encoding the run id and joining channels", () => {
    expect(
      realtimeRunsUrl({
        orgId: "org_1",
        spaceId: "spc_1",
        runId: "run/1",
        verbose: true,
        channels: ["run_update", "run_log"],
      }),
    ).toBe(
      "/api/realtime/runs/run%2F1?orgId=org_1&spaceId=spc_1&verbose=true&channels=run_update%2Crun_log",
    );
  });

  it("carries a role preview as view_as and nothing when there is none", () => {
    const base = { orgId: "org_1", spaceId: "spc_1" };
    expect(realtimeRunsUrl({ ...base, viewAs: "org_role=guest" })).toBe(
      "/api/realtime/runs?orgId=org_1&spaceId=spc_1&view_as=org_role%3Dguest",
    );
    expect(realtimeRunsUrl({ ...base, viewAs: null })).toBe(
      "/api/realtime/runs?orgId=org_1&spaceId=spc_1",
    );
  });
});
