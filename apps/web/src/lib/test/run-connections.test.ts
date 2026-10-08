// SPDX-License-Identifier: Apache-2.0

/**
 * `connections_used` holds one entry per BOUND connection, so the panel cannot
 * key a card on `integration_package_id` — two entries would collide. This pins the
 * grouping, the orders it must not disturb, and the rows of the integrations the
 * run started without.
 */

import { describe, it, expect } from "bun:test";
import type { EnrichedRun } from "@appstrate/shared-types";
import { groupByIntegration, unboundIntegrationIds, type ConnectionUsed } from "../run-connections";

const used = (
  integration_package_id: string,
  label: string,
  source: ConnectionUsed["source"] = "member_pin",
): ConnectionUsed => ({
  integration_package_id,
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

describe("groupByIntegration — integrations the run started without", () => {
  it("lists each after the bound ones, with no connection", () => {
    const rows = [used("@o/gmail", "work")];
    expect(groupByIntegration(rows, ["@o/slack", "@o/notion"])).toEqual([
      ["@o/gmail", rows],
      ["@o/slack", []],
      ["@o/notion", []],
    ]);
  });

  it("lists them alone when nothing was bound", () => {
    expect(groupByIntegration([], ["@o/slack"])).toEqual([["@o/slack", []]]);
  });

  it("never turns a bound integration into an unbound row", () => {
    const rows = [used("@o/gmail", "work")];
    expect(groupByIntegration(rows, ["@o/gmail"])).toEqual([["@o/gmail", rows]]);
  });
});

describe("unboundIntegrationIds", () => {
  const run = (over: Record<string, unknown>) => ({ ...over }) as unknown as EnrichedRun;

  it("reads the run's unbound integrations", () => {
    expect(unboundIntegrationIds(run({ integrations_unbound: ["@o/slack"] }))).toEqual([
      "@o/slack",
    ]);
  });

  it("is empty when the run carries none", () => {
    expect(unboundIntegrationIds(run({ integrations_unbound: null }))).toEqual([]);
    expect(unboundIntegrationIds(run({}))).toEqual([]);
  });
});
