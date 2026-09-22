// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the run-detail connection grouping.
 *
 * `connections_used` went from "one entry per integration" to "one entry per
 * BOUND connection", so the panel can no longer key a card on
 * `integration_id` — two entries would collide. This pins the regrouping, and
 * the orders it must not disturb.
 */

import { describe, it, expect } from "bun:test";
import { groupByIntegration, type ConnectionUsed } from "../run-connections";

const used = (integration_id: string, label: string, source = "member_pin"): ConnectionUsed => ({
  integration_id,
  label,
  account_id: `${label}@acme.com`,
  source,
});

describe("groupByIntegration", () => {
  it("collects every connection bound to one integration under a single key", () => {
    const rows = [used("@o/ssh", "web-1"), used("@o/ssh", "db")];
    expect(groupByIntegration(rows)).toEqual([["@o/ssh", rows]]);
  });

  it("keeps a single-connection integration a group of one", () => {
    // Control: the degenerate case must read exactly as it did before sets.
    const rows = [used("@o/gmail", "work")];
    expect(groupByIntegration(rows)).toEqual([["@o/gmail", rows]]);
  });

  it("preserves first-seen integration order and snapshot order inside a group", () => {
    const rows = [used("@o/ssh", "web-1"), used("@o/gmail", "work"), used("@o/ssh", "db")];
    expect(groupByIntegration(rows).map(([id, g]) => [id, g.map((c) => c.label)])).toEqual([
      ["@o/ssh", ["web-1", "db"]],
      ["@o/gmail", ["work"]],
    ]);
  });

  it("returns nothing for an empty snapshot", () => {
    expect(groupByIntegration([])).toEqual([]);
  });
});
