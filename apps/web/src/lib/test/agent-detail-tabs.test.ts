// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { AGENT_DETAIL_TABS } from "../agent-detail-tabs";

describe("agent detail tabs", () => {
  it("keeps the installed Agent boundary to its five primary destinations", () => {
    expect(AGENT_DETAIL_TABS).toEqual(["overview", "runs", "configuration", "memory", "bundle"]);
  });
});
