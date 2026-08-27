// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { AGENT_DETAIL_TABS } from "../agent-detail-tabs";

describe("agent detail tabs", () => {
  it("keeps the six Agent destinations in one stable top-level order", () => {
    expect(AGENT_DETAIL_TABS).toEqual([
      "overview",
      "runs",
      "memory",
      "map",
      "configuration",
      "files",
    ]);
  });
});
