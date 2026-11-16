// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { recentAgentsFirst } from "../recent-agents.ts";

const agent = (id: string, spaceId = "spc_a") => ({ id, spaceId });
const run = (packageId: string | null, spaceId = "spc_a") => ({ packageId, spaceId });
const ids = (list: { id: string }[]) => list.map((a) => a.id);

describe("recentAgentsFirst", () => {
  it("puts the agents of the latest runs first, most recent first, then the rest", () => {
    const agents = [agent("@a/one"), agent("@a/two"), agent("@a/three")];
    expect(
      ids(recentAgentsFirst([run("@a/three"), run("@a/one"), run("@a/three")], agents)),
    ).toEqual(["@a/three", "@a/one", "@a/two"]);
  });

  it("puts first an agent run in another space than the one its row is listed under", () => {
    const agents = [agent("@a/one", "spc_a"), agent("@a/two", "spc_a")];
    expect(ids(recentAgentsFirst([run("@a/two", "spc_b")], agents))).toEqual(["@a/two", "@a/one"]);
  });

  it("skips a run whose agent is not listed (deleted, inline), and stops at the limit", () => {
    const agents = [agent("@a/one"), agent("@a/two"), agent("@a/three")];
    expect(
      ids(recentAgentsFirst([run(null), run("@a/gone"), run("@a/two"), run("@a/one")], agents, 1)),
    ).toEqual(["@a/two", "@a/one", "@a/three"]);
  });
});
