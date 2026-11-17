// SPDX-License-Identifier: Apache-2.0

/** The sidebar's active entry reads where the header trail roots the page, so the two agree. */

import { describe, expect, it } from "bun:test";
import { navEntryActive, navLocation } from "../nav-active.ts";

const ENTRIES = ["/", "/files", "/runs", "/agents", "/skills", "/integrations", "/schedules"];
const active = (input: Parameters<typeof navLocation>[0]) =>
  ENTRIES.filter((path) => navEntryActive(path, navLocation(input)));

describe("the sidebar's active entry", () => {
  it("follows the trail's root: an inline run under « Tous les runs », an agent's run under Agents", () => {
    const pathname = "/agents/@inline/x/runs/run_1";
    expect(active({ overlayPath: null, trailRootHref: "/runs", pathname })).toEqual(["/runs"]);
    expect(
      active({ overlayPath: null, trailRootHref: "/agents", pathname: "/agents/@a/b/runs/run_1" }),
    ).toEqual(["/agents"]);
  });

  it("reads only the root crumb's path, not its hash or query", () => {
    expect(
      active({ overlayPath: null, trailRootHref: "/agents/@a/b#runs", pathname: "/x" }),
    ).toEqual(["/agents"]);
  });

  it("falls back to the address on a page rooting its own trail (a list), the dashboard exactly", () => {
    expect(active({ overlayPath: null, trailRootHref: undefined, pathname: "/runs" })).toEqual([
      "/runs",
    ]);
    expect(active({ overlayPath: null, trailRootHref: undefined, pathname: "/" })).toEqual(["/"]);
    // Segment by segment: `/runsX` is not under `/runs`.
    expect(active({ overlayPath: null, trailRootHref: undefined, pathname: "/runsX" })).toEqual([]);
  });

  it("marks nothing behind an open overlay", () => {
    expect(
      active({ overlayPath: "/catalogue/agent", trailRootHref: "/agents", pathname: "/agents" }),
    ).toEqual([]);
  });
});
