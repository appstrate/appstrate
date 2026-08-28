// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { AGENT_DETAIL_TABS } from "../agent-detail-tabs";

describe("agent detail tabs", () => {
  it("keeps operational destinations before the consolidated settings destination", () => {
    expect(AGENT_DETAIL_TABS).toEqual(["overview", "runs", "memory", "settings"]);
  });
});
