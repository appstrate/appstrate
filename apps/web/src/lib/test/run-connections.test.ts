// SPDX-License-Identifier: Apache-2.0

/**
 * `connections_used` holds one entry per BOUND connection, so the panel cannot
 * key a card on `integration_package_id` — two entries would collide. This pins the
 * grouping, the orders it must not disturb, and the rows of the integrations the
 * run started without.
 */

import { describe, it, expect } from "bun:test";
import { CONNECTION_RESOLUTION_WARNING_CODES } from "@appstrate/core/integration";
import type { EnrichedRun } from "@appstrate/shared-types";
import i18n, { i18nReady } from "../../i18n.ts";
import { causeSentence } from "../launch-warnings";
import { groupByIntegration, runConnectionRows, type ConnectionUsed } from "../run-connections";

await i18nReady;
await i18n.changeLanguage("fr");

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

describe("runConnectionRows", () => {
  const SLACK_UNBOUND = {
    integration_package_id: "@acme/slack",
    code: "not_connected",
    source: null,
  } as const;
  const rowsOf = (run: Partial<Pick<EnrichedRun, "connections_used" | "integrations_unbound">>) =>
    runConnectionRows({ connections_used: null, integrations_unbound: null, ...run });

  it("lists an integration the run started without, beside the bound ones", () => {
    const rows = rowsOf({
      connections_used: [used("@acme/gmail", "Travail")],
      integrations_unbound: [SLACK_UNBOUND],
    });
    expect(rows.map((r) => [r.integrationId, r.bound.length, r.unboundCause !== null])).toEqual([
      ["@acme/gmail", 1, false],
      ["@acme/slack", 0, true],
    ]);
  });

  it("has a row for a run that bound nothing but started without an integration", () => {
    expect(rowsOf({ integrations_unbound: [SLACK_UNBOUND] })).toHaveLength(1);
  });

  it("says why each integration started without a connection, as the launch toast did", () => {
    for (const code of CONNECTION_RESOLUTION_WARNING_CODES) {
      const [row] = rowsOf({ integrations_unbound: [{ ...SLACK_UNBOUND, code }] });
      expect(row?.unboundCause).toBe(causeSentence({ code }));
    }
    const [chosen] = rowsOf({
      integrations_unbound: [
        { ...SLACK_UNBOUND, code: "integration_unbound", source: "schedule_override" },
      ],
    });
    expect(chosen?.unboundCause).toBe(
      i18n.t("agents:launchWarnings.cause.chosenNoneBy", {
        count: 1,
        by: i18n.t("agents:noneChosenBy.scheduleOverride"),
      }),
    );
  });

  it("has no row when the run declared nothing to bind", () => {
    expect(rowsOf({ integrations_unbound: null })).toEqual([]);
  });
});
