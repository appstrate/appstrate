// SPDX-License-Identifier: Apache-2.0

/**
 * What the engaged spaces hold, as the caller-context block renders it: by resource, each line
 * naming the spaces where it stands, deterministic, within its budget.
 */

import { describe, expect, it } from "bun:test";
import {
  CHAT_CONTEXT_DETAILS_BUDGET_CHARS,
  SPACE_DETAILS_HEADING,
  formatSpaceDetails,
  readSpaceDetails,
  type DetailSpace,
  type SpaceDetail,
  type SpaceDetailsClient,
} from "../src/space-details.ts";

const PERSO: DetailSpace = { id: "spc_p", name: "Perso", integrations: true, agents: true };
const VENTES: DetailSpace = { id: "spc_v", name: "Ventes", integrations: true, agents: true };

const agent = (id: string, over: Partial<NonNullable<SpaceDetail["agents"]>[number]> = {}) => ({
  id,
  name: id.split("/")[1]!,
  description: "",
  published: true,
  homeWritable: false,
  takesInput: false,
  inactiveRequired: [],
  ...over,
});

const detail = (space: DetailSpace, over: Partial<SpaceDetail> = {}): SpaceDetail => ({
  space,
  integrations: [],
  connectable: [],
  connectableTruncated: false,
  agents: [],
  agentsTotal: 0,
  ...over,
});

describe("formatSpaceDetails", () => {
  it("renders one line per integration and per agent, naming every space where it stands", () => {
    const gmail = (connectionId: string, label: string, owned: boolean, active = true) => ({
      id: "@appstrate/gmail",
      name: "Gmail",
      active,
      needsReconnection: false,
      connections: [{ id: connectionId, label, owned }],
    });
    const { text, covered } = formatSpaceDetails([
      detail(PERSO, {
        integrations: [gmail("c1", "Pro", true)],
        agents: [agent("@acme/digest", { description: "Daily\n  digest." })],
        agentsTotal: 1,
      }),
      detail(VENTES, {
        integrations: [gmail("c2", "Équipe", false, false)],
        connectable: ["@appstrate/slack"],
        agents: [
          agent("@acme/digest", { takesInput: true }),
          agent("@acme/brief", { published: false, homeWritable: true }),
          agent("@acme/post", { inactiveRequired: ["@appstrate/slack"] }),
        ],
        agentsTotal: 3,
      }),
    ]);
    expect(covered).toEqual(["spc_p", "spc_v"]);
    expect(text.split("\n")).toEqual([
      SPACE_DETAILS_HEADING,
      "As read at the start of this turn, for Perso, Ventes. For another space, call `get_me` with its `space_id`; after a connection or an activation during the turn, call it again.",
      "",
      "Integrations:",
      '- `@appstrate/gmail` (Gmail) — usable in Perso; switched off in Ventes. Connections: "Pro" (yours), "Équipe" (a colleague\'s)',
      "- `@appstrate/slack` — not connected in Ventes",
      "",
      "Agents you can run:",
      "- `@acme/brief` (brief) — in Ventes (draft only: launch it with version=draft)",
      "- `@acme/digest` (digest) — in Perso, Ventes. Daily digest.",
      "- `@acme/post` (post) — in Ventes (refused until `@appstrate/slack` is switched on)",
    ]);
  });

  it("is the same text for the same reads, whatever order the entries came in", () => {
    const a = agent("@acme/a");
    const b = agent("@acme/b");
    const once = formatSpaceDetails([detail(PERSO, { agents: [a, b], agentsTotal: 2 })]);
    const again = formatSpaceDetails([detail(PERSO, { agents: [b, a], agentsTotal: 2 })]);
    expect(again).toEqual(once);
  });

  it("says where a list was capped and what the role does not read", () => {
    const { text } = formatSpaceDetails([
      detail(PERSO, { agents: [agent("@acme/a")], agentsTotal: 40, connectableTruncated: true }),
      detail({ ...VENTES, integrations: false }, { integrations: null }),
    ]);
    expect(text).toContain(
      "Only the first agents are listed for Perso (1 of 40): `search` finds the others.",
    );
    expect(text).toContain("More integrations to connect in Perso: `search` lists them.");
    expect(text).toContain("Your role does not read the integrations of Ventes.");
    // An empty list is said, never left for the model to guess.
    expect(text).toContain("- none connected or to connect");
  });

  it("keeps the first spaces that fit the budget and covers only those", () => {
    const many = (space: DetailSpace) =>
      detail(space, {
        agents: Array.from({ length: 15 }, (_, i) =>
          agent(`@${space.id}/agent-${i}`, { description: "x".repeat(400) }),
        ),
        agentsTotal: 15,
      });
    const LAB: DetailSpace = { id: "spc_l", name: "Lab", integrations: true, agents: true };
    // Two spaces listing the 15 agents get_me caps at fit; a third does not.
    const three = [many(PERSO), many(VENTES), many(LAB)];
    const { text, covered } = formatSpaceDetails(three);
    expect(text.length).toBeLessThanOrEqual(CHAT_CONTEXT_DETAILS_BUDGET_CHARS);
    expect(covered).toEqual(["spc_p", "spc_v"]);
    expect(text).toContain("for Perso, Ventes.");
    expect(text).not.toContain("spc_l");
    // Nothing fits: nothing is rendered.
    expect(formatSpaceDetails(three, 10)).toEqual({ text: "", covered: [] });
  });
});

describe("readSpaceDetails", () => {
  const client = (answers: Record<string, unknown>): SpaceDetailsClient & { calls: unknown[] } => {
    const calls: unknown[] = [];
    return {
      calls,
      callTool: async (args) => {
        calls.push(args);
        const answer = answers[String(args.arguments?.space_id)];
        if (answer instanceof Error) throw answer;
        return answer as never;
      },
    };
  };
  const ok = (body: Record<string, unknown>) => ({
    content: [],
    structuredContent: { status: 200, body },
  });

  it("reads get_me in each space and leaves out one that fails, refuses or answers another space", async () => {
    const LAB: DetailSpace = { id: "spc_l", name: "Lab", integrations: true, agents: false };
    const OTHER: DetailSpace = { id: "spc_o", name: "Other", integrations: true, agents: true };
    const fake = client({
      spc_p: ok({
        space: { id: "spc_p" },
        connections: [
          {
            integration_package_id: "@appstrate/gmail",
            name: "Gmail",
            active: true,
            connections: [{ id: "c1", label: "Pro", owned_by_actor: true }],
          },
        ],
        connectable_integrations: ["@appstrate/slack"],
        agents: [{ packageId: "@acme/a", display_name: "A", published: true }],
        agents_total: 1,
      }),
      spc_v: new Error("timeout"),
      spc_l: { isError: true, structuredContent: { status: 403, body: {} } },
      spc_o: ok({ space: { id: "spc_x" } }),
    });
    const read = await readSpaceDetails(fake, AbortSignal.timeout(1000), [
      PERSO,
      VENTES,
      LAB,
      OTHER,
    ]);
    expect(fake.calls).toEqual([
      { name: "get_me", arguments: { space_id: "spc_p" } },
      { name: "get_me", arguments: { space_id: "spc_v" } },
      { name: "get_me", arguments: { space_id: "spc_l" } },
      { name: "get_me", arguments: { space_id: "spc_o" } },
    ]);
    expect(read).toEqual([
      {
        space: PERSO,
        integrations: [
          {
            id: "@appstrate/gmail",
            name: "Gmail",
            active: true,
            needsReconnection: false,
            connections: [{ id: "c1", label: "Pro", owned: true }],
          },
        ],
        connectable: ["@appstrate/slack"],
        connectableTruncated: false,
        agents: [agent("@acme/a", { name: "A" })],
        agentsTotal: 1,
      },
    ]);
  });

  it("reads no list the turn may not read there, whatever get_me answers", async () => {
    const fake = client({
      spc_p: ok({
        space: { id: "spc_p" },
        connections: [
          { integration_package_id: "@appstrate/gmail", active: true, connections: [] },
        ],
        connectable_integrations: ["@appstrate/slack"],
        agents: [{ packageId: "@acme/a" }],
      }),
    });
    const [read] = await readSpaceDetails(fake, AbortSignal.timeout(1000), [
      { ...PERSO, integrations: false },
    ]);
    expect(read?.integrations).toBeNull();
    expect(read?.connectable).toEqual([]);
    expect(read?.agents).toHaveLength(1);
  });
});
