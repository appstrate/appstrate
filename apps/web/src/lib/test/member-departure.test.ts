// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { departureFixHref, departureFixSection } from "../member-departure.ts";

const space = { id: "spc_team", name: "Sales" };

describe("departureFixSection", () => {
  it("sends a schedule of the member naming none of their connections to its identity", () => {
    expect(departureFixSection({ cause: "actor_left_org", lost_integrations: [] })).toBe(
      "identity",
    );
  });

  it("sends a schedule of the member naming one of their connections to its connections", () => {
    expect(departureFixSection({ cause: "actor_left_org", lost_integrations: ["@a/gmail"] })).toBe(
      "connections",
    );
  });

  it("sends a schedule of another actor on a shared connection to its connections", () => {
    expect(departureFixSection({ cause: "connection_unshared", lost_integrations: [] })).toBe(
      "connections",
    );
  });
});

describe("departureFixHref", () => {
  const item = { id: "sch_1", cause: "actor_left_org" as const, lost_integrations: [], space };

  it("stays in the current space", () => {
    const href = departureFixHref(item, "spc_team");
    expect(href).toStartWith("/schedules/sch_1");
    expect(href).not.toContain("enterSpace");
  });

  it("enters the schedule's space from another one", () => {
    expect(departureFixHref(item, "spc_other")).toContain("enterSpace=spc_team");
  });
});
