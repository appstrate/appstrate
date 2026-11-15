// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { recentAgentsFirst } from "../recent-agents.ts";

const agent = (id: string, spaceId = "spc_a") => ({ id, spaceId });
const run = (packageId: string | null, spaceId = "spc_a") => ({ packageId, spaceId });
const keys = (list: { id: string; spaceId: string }[]) => list.map((a) => `${a.spaceId}:${a.id}`);

describe("recentAgentsFirst", () => {
  it("puts the agents of the latest runs first, most recent first, then the rest", () => {
    const agents = [agent("@a/one"), agent("@a/two"), agent("@a/three")];
    expect(
      keys(recentAgentsFirst([run("@a/three"), run("@a/one"), run("@a/three")], agents)),
    ).toEqual(["spc_a:@a/three", "spc_a:@a/one", "spc_a:@a/two"]);
  });

  it("holds an agent once per space: the same agent in two spaces is two placements", () => {
    const agents = [agent("@a/one", "spc_a"), agent("@a/one", "spc_b")];
    expect(
      keys(recentAgentsFirst([run("@a/one", "spc_b"), run("@a/one", "spc_b")], agents)),
    ).toEqual(["spc_b:@a/one", "spc_a:@a/one"]);
  });

  it("skips a run whose agent is not listed (deleted, inline), and stops at the limit", () => {
    const agents = [agent("@a/one"), agent("@a/two"), agent("@a/three")];
    expect(
      keys(recentAgentsFirst([run(null), run("@a/gone"), run("@a/two"), run("@a/one")], agents, 1)),
    ).toEqual(["spc_a:@a/two", "spc_a:@a/one", "spc_a:@a/three"]);
  });
});
