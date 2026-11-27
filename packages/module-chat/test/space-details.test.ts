// SPDX-License-Identifier: Apache-2.0

/**
 * What the engaged spaces hold, as the caller-context block renders it: by resource, each line
 * naming the spaces where it stands, deterministic, within its budget, ranking nothing.
 */

import { fullAgent, meBody } from "./me-context-body.ts";
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

/** A space as read, its totals those of its lists unless `over` says `get_me` capped one. */
const detail = (space: DetailSpace, over: Partial<SpaceDetail> = {}): SpaceDetail => {
  const read = { space, integrations: [], connectable: [], agents: [], ...over };
  return {
    connectableTotal: read.connectable.length,
    agentsTotal: read.agents?.length ?? 0,
    ...read,
  };
};

describe("formatSpaceDetails", () => {
  it("renders one line per integration and per agent, naming every space where it stands", () => {
    const gmail = (connectionId: string, label: string, owned: boolean, active = true) => ({
      id: "@appstrate/gmail",
      name: "Gmail",
      active,
      needsReconnection: false,
      connections: [{ id: connectionId, label, owned }],
    });
    const { text, shown } = formatSpaceDetails([
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
          agent("@acme/sync", { inactiveRequired: ["@appstrate/gmail", "@appstrate/slack"] }),
        ],
        agentsTotal: 4,
      }),
    ]);
    expect(shown).toEqual(["spc_p", "spc_v"]);
    expect(text.split("\n")).toEqual([
      SPACE_DETAILS_HEADING,
      "As read at the start of this turn, for Perso, Ventes.",
      "",
      "Integrations:",
      '- `@appstrate/gmail` (Gmail) — usable in Perso; switched off in Ventes. Connections: "Pro" (yours), "Équipe" (a colleague\'s)',
      "- `@appstrate/slack` — not connected in Ventes",
      "",
      "Agents:",
      "- `@acme/brief` (brief) — in Ventes (draft only: launch it with version=draft)",
      "- `@acme/digest` (digest) — in Perso, Ventes. Daily digest.",
      "- `@acme/post` (post) — in Ventes (refused until `@appstrate/slack` is switched on)",
      "- `@acme/sync` (sync) — in Ventes (refused until `@appstrate/gmail`, `@appstrate/slack` are switched on)",
    ]);
  });

  it("shows the entries of a space that has some, and an empty one shows none", () => {
    const { shown } = formatSpaceDetails([
      detail(PERSO, { connectable: ["@appstrate/slack"] }),
      detail(VENTES),
    ]);
    // An absence discloses nothing of Ventes: only Perso puts data into the conversation.
    expect(shown).toEqual(["spc_p"]);
  });

  it("is the same text for the same reads, whatever order the entries came in", () => {
    const a = agent("@acme/a");
    const b = agent("@acme/b");
    const once = formatSpaceDetails([detail(PERSO, { agents: [a, b], agentsTotal: 2 })]);
    const again = formatSpaceDetails([detail(PERSO, { agents: [b, a], agentsTotal: 2 })]);
    expect(again).toEqual(once);
  });

  it("counts a list get_me capped instead of listing its first entries, and says what the role does not read", () => {
    const { text, shown } = formatSpaceDetails([
      detail(PERSO, {
        agents: [agent("@acme/a")],
        agentsTotal: 40,
        connectable: ["@appstrate/slack"],
        connectableTotal: 30,
      }),
      detail({ ...VENTES, integrations: false }, { integrations: null }),
    ]);
    expect(shown).toEqual(["spc_p"]);
    // The entries get_me happened to list first are not put before the others.
    expect(text).not.toContain("@acme/a");
    expect(text).not.toContain("@appstrate/slack");
    expect(text).toContain(
      "Integrations to connect are only counted where they outnumber what `get_me` lists: Perso (30); `search` with the space's `space_id` finds them, and an integration listed above may also be to connect there.",
    );
    expect(text).toContain(
      "Agents are only counted where they outnumber what `get_me` lists: Perso (40); `search` with the space's `space_id` finds them, and an agent listed above may also be active there.",
    );
    expect(text).toContain("Your role does not read the integrations of Ventes.");
    expect(text).not.toContain("- none");
    // An empty list is said, never left for the model to guess.
    expect(formatSpaceDetails([detail(PERSO)]).text).toContain("- none connected or to connect");
  });

  it("is the same text whatever order the spaces came in, sorted by name", () => {
    const one = detail(VENTES, { agents: [agent("@acme/b")] });
    const two = detail(PERSO, { agents: [agent("@acme/a")] });
    const { text } = formatSpaceDetails([one, two]);
    expect(formatSpaceDetails([two, one]).text).toBe(text);
    expect(text).toContain("for Perso, Ventes.");
  });

  describe("at a scale the budget cannot hold in full", () => {
    const LAB: DetailSpace = { id: "spc_l", name: "Lab", integrations: true, agents: true };
    const many = (space: DetailSpace) =>
      detail(space, {
        integrations: Array.from({ length: 10 }, (_, i) => ({
          id: `@${space.id}/int-${i}`,
          name: `Int ${i}`,
          active: true,
          needsReconnection: false,
          connections: [{ id: `${space.id}-c${i}`, label: "y".repeat(60), owned: true }],
        })),
        agents: Array.from({ length: 15 }, (_, i) =>
          agent(`@${space.id}/agent-${i}`, { description: "x".repeat(400) }),
        ),
      });
    const three = [many(VENTES), many(LAB), many(PERSO)];

    it("leaves the same detail out of every space, never a space or an entry", () => {
      const { text, shown } = formatSpaceDetails(three);
      expect(text.length).toBeLessThanOrEqual(CHAT_CONTEXT_DETAILS_BUDGET_CHARS);
      expect(shown).toEqual(["spc_l", "spc_p", "spc_v"]);
      expect(text).toContain("for Lab, Perso, Ventes.");
      expect(text).toContain(
        "Descriptions and connection labels are left out for room: `get_me` with a space's `space_id` gives them.",
      );
      expect(text).not.toContain("xxxxxxxxxx");
      expect(text).not.toContain("yyyyyyyyyy");
      for (const space of three) {
        for (const entry of [...space.integrations!, ...space.agents!]) {
          expect(text).toContain(`\`${entry.id}\``);
        }
      }
    });

    it("counts every space alike when even the names do not fit", () => {
      const { text, shown } = formatSpaceDetails(three, 1_000);
      expect(shown).toEqual(["spc_l", "spc_p", "spc_v"]);
      expect(text.split("\n")).toEqual([
        SPACE_DETAILS_HEADING,
        "As read at the start of this turn, only counted for room: `get_me` with a space's `space_id` lists them.",
        "- Lab: 10 usable integrations, 0 to connect; 15 agents",
        "- Perso: 10 usable integrations, 0 to connect; 15 agents",
        "- Ventes: 10 usable integrations, 0 to connect; 15 agents",
      ]);
    });

    it("counts the usable integrations alone: a switched-off one or one to reconnect is not usable", () => {
      const integration = (id: string, active: boolean, needsReconnection: boolean) => ({
        id,
        name: id,
        active,
        needsReconnection,
        connections: [],
      });
      const { text } = formatSpaceDetails(
        [
          detail(PERSO, {
            integrations: [
              integration("@a/ok", true, false),
              integration("@a/off", false, false),
              integration("@a/stale", true, true),
            ],
          }),
        ],
        200,
      );
      expect(text).toContain("- Perso: 1 usable integration, 0 to connect; 0 agents");
    });

    it("details no space when not even the counts fit", () => {
      const named = formatSpaceDetails(three, 200);
      expect(named.shown).toEqual([]);
      expect(named.text.split("\n")).toEqual([
        SPACE_DETAILS_HEADING,
        "Not detailed here, for room: `get_me` with a space's `space_id` lists what it holds.",
      ]);
      expect(formatSpaceDetails(three, 10)).toEqual({ text: "", shown: [] });
    });
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
    structuredContent: { status: 200, body: meBody(body) },
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
            source: "own",
            active: true,
            via: "home",
            connections: [
              {
                id: "c1",
                label: "Pro",
                account_id: "a1",
                owned_by_actor: true,
                needs_reconnection: false,
              },
            ],
          },
        ],
        connectable_integrations: { data: ["@appstrate/slack"], truncated: false, total: 1 },
        agents: {
          data: [fullAgent("@acme/a", "A")],
          truncated: false,
          total: 1,
        },
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
        connectableTotal: 1,
        agents: [agent("@acme/a", { name: "A" })],
        agentsTotal: 1,
      },
    ]);
  });

  it("reads a few spaces at a time and keeps the order of the spaces", async () => {
    const spaces = Array.from({ length: 12 }, (_, i) => ({
      id: `spc_${i}`,
      name: `S${i}`,
      integrations: false,
      agents: true,
    }));
    let inFlight = 0;
    let peak = 0;
    const slow: SpaceDetailsClient = {
      callTool: async (args) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        // The first spaces answer last: the order of the result is the order of `spaces`.
        const id = String(args.arguments?.space_id);
        await new Promise((resolve) => setTimeout(resolve, 30 - Number(id.slice(4))));
        inFlight--;
        return ok({ space: { id } }) as never;
      },
    };
    const read = await readSpaceDetails(slow, AbortSignal.timeout(5000), spaces);
    expect(read.map((detail) => detail.space.id)).toEqual(spaces.map((space) => space.id));
    expect(peak).toBe(4);
  });

  it("reads no list the turn may not read there, whatever get_me answers", async () => {
    const fake = client({
      spc_p: ok({
        space: { id: "spc_p" },
        connections: [
          {
            integration_package_id: "@appstrate/gmail",
            name: "Gmail",
            source: "own",
            active: true,
            via: "home",
            connections: [],
          },
        ],
        connectable_integrations: { data: ["@appstrate/slack"], truncated: false, total: 1 },
        agents: { data: [fullAgent("@acme/a", "A")], truncated: false, total: 1 },
      }),
    });
    const [read] = await readSpaceDetails(fake, AbortSignal.timeout(1000), [
      { ...PERSO, integrations: false },
    ]);
    expect(read?.integrations).toBeNull();
    expect(read?.connectable).toEqual([]);
    expect(read?.agents).toHaveLength(1);
  });

  it("leaves out a space whose context does not match the schema", async () => {
    const fake = client({
      spc_p: {
        content: [],
        structuredContent: {
          status: 200,
          body: { ...meBody({ space: { id: "spc_p" } }), agents: [] },
        },
      },
    });
    expect(await readSpaceDetails(fake, AbortSignal.timeout(1000), [PERSO])).toEqual([]);
  });

  it("keeps a field the server adds", async () => {
    const fake = client({ spc_p: ok({ space: { id: "spc_p", added: 1 }, added_list: [] }) });
    expect(await readSpaceDetails(fake, AbortSignal.timeout(1000), [PERSO])).toHaveLength(1);
  });
});
