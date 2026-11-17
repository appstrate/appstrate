// SPDX-License-Identifier: Apache-2.0

/**
 * The diagnostics name schedules, versions and the model as what to fix: a
 * write to any of them has to mark them stale, or the health section keeps
 * pointing at a fix already made.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api } from "../../api/client.ts";
import { invalidateAgentDiagnostics } from "../use-agent-diagnostics.ts";
import { invalidateSchedules } from "../use-schedules.ts";

const header = { "X-Org-Id": "org_a", "X-Space-Id": "spc_a" };
const diagnostics = $api.queryOptions("get", "/api/agents/{scope}/{name}/diagnostics", {
  params: { path: { scope: "@acme", name: "worker" }, header },
}).queryKey;
const spaces = $api.queryOptions("get", "/api/spaces", { params: { header } }).queryKey;

function seeded() {
  const qc = new QueryClient();
  qc.setQueryData(diagnostics, { status: "warning", diagnostics: [] });
  qc.setQueryData(spaces, { object: "list", data: [], hasMore: false });
  return qc;
}

describe("agent diagnostics invalidation", () => {
  it("marks every agent's diagnostics stale, and nothing else", async () => {
    const qc = seeded();
    await invalidateAgentDiagnostics(qc);
    expect(qc.getQueryState(diagnostics)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(spaces)?.isInvalidated).toBe(false);
  });

  it("follows a schedule write", () => {
    const qc = seeded();
    invalidateSchedules(qc);
    expect(qc.getQueryState(diagnostics)?.isInvalidated).toBe(true);
  });
});
