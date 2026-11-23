// SPDX-License-Identifier: Apache-2.0

/**
 * `useConversationSkills` mounted for real over a real `QueryClient` and a fake server: a change
 * to an existing conversation sends the named setting, projected over the latest confirmed row
 * while its PATCH is pending; a new conversation keeps its selection locally and its first turn carries it, and
 * a change made before the row that turn created is read reaches the row by a PATCH.
 * The DOM globals come from `dom-shim.ts`.
 */

import { describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PinnedSkill, SkillSettingsPatch } from "../src/skills.ts";
import { pinIds } from "../src/ui/chat-skills.ts";
import { sessionQueryKey, type SessionHistory } from "../src/ui/sessions.ts";
import {
  useConversationSkills,
  type ConversationSkillsState,
} from "../src/ui/use-conversation-skills.ts";
import { transportOver } from "./fake-request.ts";
import { container, installDomShim } from "./dom-shim.ts";

installDomShim();

const ID = "chs_c";

class Problem extends Error {
  constructor(readonly status: number) {
    super(`API Error: ${status}`);
  }
}

interface Row {
  skill_discovery: boolean;
  pins: PinnedSkill[];
}

/**
 * The session routes over `row` (`null`: no session yet). A PATCH waits while `hold` is on, until
 * `release`; `fail` makes the next PATCH answer 500.
 */
function fakeServer(initial: Row | null) {
  const server = {
    row: initial,
    patches: [] as SkillSettingsPatch[],
    title: "original",
    holdReads: false,
    waitingReads: [] as (() => void)[],
    reads: 0,
    hold: false,
    fail: false,
    held: [] as (() => void)[],
  };
  const transport = transportOver(async (_path, init) => {
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as (typeof server.patches)[number];
      server.patches.push(body);
      if (server.hold) await new Promise<void>((resolve) => server.held.push(resolve));
      if (server.fail) {
        server.fail = false;
        throw new Problem(500);
      }
      const row = server.row;
      if (!row) throw new Problem(404);
      server.row = {
        skill_discovery: body.skill_discovery ?? row.skill_discovery,
        pins: (
          body.pins ??
          (body.pin
            ? [
                ...row.pins.map((p) => p.id).filter((id) => id !== body.pin!.id),
                ...(body.pin.pinned ? [body.pin.id] : []),
              ].sort()
            : row.pins.map((p) => p.id))
        ).map((id) => row.pins.find((pin) => pin.id === id) ?? { id, status: null, chars: null }),
      };
      return Response.json({ id: ID, title: null, ...server.row });
    }
    server.reads += 1;
    if (server.holdReads) await new Promise<void>((resolve) => server.waitingReads.push(resolve));
    if (!server.row) throw new Problem(404);
    return Response.json({ id: ID, title: server.title, messages: [], ...server.row });
  });
  return { server, transport };
}

/** Lets the requests, the query notifications and the mutation queue run. */
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 15))));

async function mount(
  transport: ReturnType<typeof fakeServer>["transport"],
  persisted: boolean,
  enabled = true,
) {
  const client = new QueryClient();
  const result = { current: undefined as unknown as ConversationSkillsState };
  function Probe() {
    result.current = useConversationSkills({ transport, id: ID, persisted, enabled });
    return null;
  }
  const root: Root = createRoot(container());
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    ),
  );
  await settle();
  const cached = () =>
    client.getQueryData<SessionHistory | null>(sessionQueryKey("org_1", ID))?.skills;
  /** The host's realtime on the conversation's session signal. */
  const signal = () =>
    act(
      async () => void (await client.invalidateQueries({ queryKey: sessionQueryKey("org_1", ID) })),
    );
  const title = () => client.getQueryData<SessionHistory>(sessionQueryKey("org_1", ID))?.title;
  return { result, cached, signal, title, unmount: () => act(async () => root.unmount()) };
}

const pin = (id: string, status: PinnedSkill["status"] = "injected"): PinnedSkill => ({
  id,
  status,
  chars: status === "injected" ? 100 : null,
});

describe("useConversationSkills on a conversation the server holds", () => {
  it("shows a pending pin over the confirmed detail, sending just that pin", async () => {
    const { server, transport } = fakeServer({ skill_discovery: true, pins: [pin("@a/kept")] });
    const { result, cached, unmount } = await mount(transport, true);
    expect(result.current.held).toBe(true);
    server.hold = true;
    await act(async () => result.current.setPin("@a/new", true));
    await settle();
    // The pending pin is visible while the detail still holds the confirmed settings.
    expect(result.current.skills.pins).toEqual([pin("@a/kept"), pin("@a/new", null)]);
    expect(cached()?.pins.map((p) => p.id)).toEqual(["@a/kept"]);
    expect(server.patches).toEqual([{ pin: { id: "@a/new", pinned: true } }]);
    server.hold = false;
    await act(async () => server.held.splice(0).forEach((go) => go()));
    await settle();
    expect(pinIds(result.current.skills)).toEqual(["@a/kept", "@a/new"]);
    // Settled: the detail is read again, the server's word last.
    expect(server.reads).toBe(2);
    await unmount();
  });

  it("drops the pending selection when the PATCH fails", async () => {
    const { server, transport } = fakeServer({ skill_discovery: true, pins: [pin("@a/kept")] });
    const { result, cached, unmount } = await mount(transport, true);
    server.fail = true;
    await act(async () => result.current.setDiscovery(false));
    await settle();
    expect(result.current.skills.skillDiscovery).toBe(true);
    expect(cached()?.skillDiscovery).toBe(true);
    expect(server.row?.skill_discovery).toBe(true);
    await unmount();
  });

  it("sends concurrent changes in their original order", async () => {
    const { server, transport } = fakeServer({ skill_discovery: true, pins: [] });
    const { result, unmount } = await mount(transport, true);
    server.hold = true;
    await act(async () => {
      result.current.setPin("@a/one", true);
      result.current.setPin("@a/two", true);
    });
    await settle();
    // The second waits for the first; both show meanwhile.
    expect(server.patches).toHaveLength(1);
    expect(pinIds(result.current.skills)).toEqual(["@a/one", "@a/two"]);
    for (let i = 0; i < 2; i += 1) {
      await act(async () => server.held.splice(0).forEach((go) => go()));
      await settle();
    }
    expect(server.patches.map((p) => p.pin?.id)).toEqual(["@a/one", "@a/two"]);
    expect(server.row?.pins.map((p) => p.id)).toEqual(["@a/one", "@a/two"]);
    expect(pinIds(result.current.skills)).toEqual(["@a/one", "@a/two"]);
    await unmount();
  });

  it("retains a realtime title after a failed pin while the final read is pending", async () => {
    const { server, transport } = fakeServer({ skill_discovery: true, pins: [] });
    const { result, signal, title, unmount } = await mount(transport, true);
    server.hold = true;
    server.fail = true;
    await act(async () => result.current.setPin("@a/new", true));
    await settle();
    server.title = "updated in another tab";
    await signal();
    expect(title()).toBe(server.title);
    server.holdReads = true;
    await act(async () => server.held.splice(0).forEach((go) => go()));
    await settle();
    expect(server.waitingReads).toHaveLength(1);
    expect(title()).toBe(server.title);
    expect(result.current.skills.pins).toEqual([]);
    server.holdReads = false;
    await act(async () => server.waitingReads.splice(0).forEach((go) => go()));
    await unmount();
  });

  it("pins nothing where the panel is not offered", async () => {
    const off = await mount(fakeServer({ skill_discovery: true, pins: [] }).transport, true, false);
    await act(async () => off.result.current.setPin("@a/x", true));
    expect(pinIds(off.result.current.skills)).toEqual([]);
    expect(off.result.current.takeForTurn()).toBeUndefined();
    await off.unmount();
  });
});

describe("useConversationSkills on a new conversation", () => {
  it("keeps the selection locally, and the first turn carries it", async () => {
    const { server, transport } = fakeServer(null);
    const { result, unmount } = await mount(transport, false);
    expect(server.reads).toBe(0);
    await act(async () => {
      result.current.setPin("@a/picked", true);
      result.current.setDiscovery(false);
    });
    expect(server.patches).toEqual([]);
    expect(result.current.held).toBe(false);
    expect(pinIds(result.current.skills)).toEqual(["@a/picked"]);
    let taken: ReturnType<ConversationSkillsState["takeForTurn"]>;
    await act(async () => void (taken = result.current.takeForTurn()));
    expect(taken).toEqual({ skillDiscovery: false, pinnedSkills: ["@a/picked"] });
    await unmount();
  });

  it("reads the detail once the first turn left; from then on the detail is the truth", async () => {
    const { server, transport } = fakeServer(null);
    const { result, signal, unmount } = await mount(transport, false);
    await act(async () => result.current.setPin("@a/picked", true));
    await act(async () => void result.current.takeForTurn());
    await settle();
    // Read before the turn created the row: the local selection still shows.
    expect(server.reads).toBe(1);
    expect(result.current.held).toBe(false);
    expect(pinIds(result.current.skills)).toEqual(["@a/picked"]);
    // The turn creates the row with what it carried, the server judges it and signals it.
    server.row = { skill_discovery: true, pins: [pin("@a/picked", "over_budget")] };
    await signal();
    await settle();
    expect(result.current.held).toBe(true);
    expect(result.current.skills.pins).toEqual([pin("@a/picked", "over_budget")]);
    expect(result.current.takeForTurn()).toBeUndefined();
    await unmount();
  });

  it("PATCHes a change made before the row the first turn created is read", async () => {
    const { server, transport } = fakeServer(null);
    const { result, unmount } = await mount(transport, false);
    await act(async () => result.current.setPin("@a/picked", true));
    await act(async () => void result.current.takeForTurn());
    await settle();
    // Read before the turn created the row: nothing to PATCH yet.
    expect(server.reads).toBe(1);
    expect(result.current.held).toBe(false);
    server.row = { skill_discovery: true, pins: [pin("@a/picked", null)] };
    await act(async () => result.current.setPin("@a/later", true));
    await settle();
    // The change reads the row again and is sent over it: the turn's selection is not kept.
    expect(server.patches).toEqual([{ pin: { id: "@a/later", pinned: true } }]);
    expect(server.row?.pins.map((p) => p.id)).toEqual(["@a/later", "@a/picked"]);
    expect(result.current.held).toBe(true);
    expect(pinIds(result.current.skills)).toEqual(["@a/later", "@a/picked"]);
    expect(result.current.takeForTurn()).toBeUndefined();
    await unmount();
  });

  it("keeps a change locally when the first turn created no row: the next turn carries it", async () => {
    const { server, transport } = fakeServer(null);
    const { result, unmount } = await mount(transport, false);
    await act(async () => void result.current.takeForTurn());
    await settle();
    await act(async () => result.current.setPin("@a/later", true));
    await settle();
    expect(server.patches).toEqual([]);
    expect(pinIds(result.current.skills)).toEqual(["@a/later"]);
    let taken: ReturnType<ConversationSkillsState["takeForTurn"]>;
    await act(async () => void (taken = result.current.takeForTurn()));
    expect(taken?.pinnedSkills).toEqual(["@a/later"]);
    await unmount();
  });
});
