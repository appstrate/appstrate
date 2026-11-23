// SPDX-License-Identifier: Apache-2.0

/**
 * `useConversationSkills` mounted for real over a real `QueryClient` and a fake server: a change
 * to an existing conversation is a PATCH of the full set, written into the cached detail before it
 * lands and rolled back on a failure; concurrent changes are sent one after the other, each over
 * the previous; a new conversation keeps its selection locally and its first turn carries it, and
 * a change made before the row that turn created is read reaches the row by a PATCH.
 * There is no DOM harness in this repo; a hook rendering nothing needs only the few globals
 * react-dom's client touches, installed for this file and removed after it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PinnedSkill } from "../src/skills.ts";
import { pinIds } from "../src/ui/chat-skills.ts";
import { sessionQueryKey, type SessionHistory } from "../src/ui/sessions.ts";
import {
  useConversationSkills,
  type ConversationSkillsState,
} from "../src/ui/use-conversation-skills.ts";
import { transportOver } from "./fake-request.ts";

const globals = globalThis as { window?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean };
const saved = { window: globals.window, act: globals.IS_REACT_ACT_ENVIRONMENT };
const noop = () => {};
const doc: Record<string, unknown> = {
  addEventListener: noop,
  removeEventListener: noop,
  activeElement: null,
};
/** A fresh root container: one per mount, as `createRoot` wants. */
function container() {
  const node = {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    addEventListener: noop,
    removeEventListener: noop,
    ownerDocument: doc,
  };
  doc.documentElement = doc.body = node;
  return node as unknown as HTMLElement;
}

beforeAll(() => {
  globals.window = { HTMLIFrameElement: class {}, document: doc };
  globals.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  if (saved.window === undefined) delete globals.window;
  else globals.window = saved.window;
  globals.IS_REACT_ACT_ENVIRONMENT = saved.act;
});

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
    patches: [] as { pins: string[]; skill_discovery: boolean }[],
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
        skill_discovery: body.skill_discovery,
        pins: body.pins.map(
          (id) => row.pins.find((pin) => pin.id === id) ?? { id, status: null, chars: null },
        ),
      };
      return Response.json({ id: ID, title: null, ...server.row });
    }
    server.reads += 1;
    if (!server.row) throw new Problem(404);
    return Response.json({ id: ID, title: null, messages: [], ...server.row });
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
  return { result, cached, signal, unmount: () => act(async () => root.unmount()) };
}

const pin = (id: string, status: PinnedSkill["status"] = "injected"): PinnedSkill => ({
  id,
  status,
  chars: status === "injected" ? 100 : null,
});

describe("useConversationSkills on a conversation the server holds", () => {
  it("writes a change into the cached detail before the PATCH answers, the full set sent", async () => {
    const { server, transport } = fakeServer({ skill_discovery: true, pins: [pin("@a/kept")] });
    const { result, cached, unmount } = await mount(transport, true);
    expect(result.current.held).toBe(true);
    server.hold = true;
    await act(async () => result.current.setPin("@a/new", true));
    await settle();
    // Optimistic: shown and cached at once, the new pin with no verdict yet.
    expect(result.current.skills.pins).toEqual([pin("@a/kept"), pin("@a/new", null)]);
    expect(cached()?.pins.map((p) => p.id)).toEqual(["@a/kept", "@a/new"]);
    expect(server.patches).toEqual([{ pins: ["@a/kept", "@a/new"], skill_discovery: true }]);
    server.hold = false;
    await act(async () => server.held.splice(0).forEach((go) => go()));
    await settle();
    expect(pinIds(result.current.skills)).toEqual(["@a/kept", "@a/new"]);
    // Settled: the detail is read again, the server's word last.
    expect(server.reads).toBe(2);
    await unmount();
  });

  it("rolls the cached detail back when the PATCH fails", async () => {
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

  it("sends concurrent changes one after the other, each over the previous: none is lost", async () => {
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
    expect(server.patches.map((p) => p.pins)).toEqual([["@a/one"], ["@a/one", "@a/two"]]);
    expect(server.row?.pins.map((p) => p.id)).toEqual(["@a/one", "@a/two"]);
    expect(pinIds(result.current.skills)).toEqual(["@a/one", "@a/two"]);
    await unmount();
  });

  it("pins the skills a message cites before it resolves, and sends nothing when all are pinned", async () => {
    const { server, transport } = fakeServer({ skill_discovery: true, pins: [pin("@a/kept")] });
    const { result, unmount } = await mount(transport, true);
    await act(async () => result.current.pinCited(["@a/kept"]));
    expect(server.patches).toEqual([]);
    let resolved = false;
    server.hold = true;
    let sent: Promise<void> = Promise.resolve();
    await act(async () => {
      sent = result.current.pinCited(["@a/cited", "@a/kept"]).then(() => void (resolved = true));
    });
    await settle();
    expect(resolved).toBe(false);
    await act(async () => server.held.splice(0).forEach((go) => go()));
    await act(async () => sent);
    expect(resolved).toBe(true);
    expect(server.patches).toEqual([{ pins: ["@a/cited", "@a/kept"], skill_discovery: true }]);
    await unmount();
  });

  it("pins cited skills however many are pinned, and nothing where the panel is not offered", async () => {
    const many = Array.from({ length: 12 }, (_, i) => pin(`@a/${String(i).padStart(2, "0")}`));
    const { server, transport } = fakeServer({ skill_discovery: true, pins: many });
    const { result, unmount } = await mount(transport, true);
    await act(async () => result.current.pinCited(["@a/extra"]));
    expect(server.patches).toEqual([
      { pins: [...many.map((p) => p.id), "@a/extra"], skill_discovery: true },
    ]);
    await unmount();
    const off = await mount(fakeServer({ skill_discovery: true, pins: [] }).transport, true, false);
    await act(async () => off.result.current.setPin("@a/x", true));
    expect(pinIds(off.result.current.skills)).toEqual([]);
    expect(off.result.current.takeForTurn()).toBeUndefined();
    await off.unmount();
  });

  it("takes no selection for a turn: the server holds its pins", async () => {
    const { transport } = fakeServer({ skill_discovery: false, pins: [pin("@a/kept")] });
    const { result, unmount } = await mount(transport, true);
    expect(result.current.takeForTurn()).toBeUndefined();
    await unmount();
  });
});

describe("useConversationSkills on a new conversation", () => {
  it("keeps the selection locally, and the first turn carries it with the cited skills", async () => {
    const { server, transport } = fakeServer(null);
    const { result, unmount } = await mount(transport, false);
    expect(server.reads).toBe(0);
    await act(async () => {
      result.current.setPin("@a/picked", true);
      result.current.setDiscovery(false);
    });
    await act(async () => result.current.pinCited(["@a/cited"]));
    expect(server.patches).toEqual([]);
    expect(result.current.held).toBe(false);
    expect(pinIds(result.current.skills)).toEqual(["@a/cited", "@a/picked"]);
    let taken: ReturnType<ConversationSkillsState["takeForTurn"]>;
    await act(async () => void (taken = result.current.takeForTurn()));
    expect(taken).toEqual({ skillDiscovery: false, pins: ["@a/cited", "@a/picked"] });
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
    expect(server.patches).toEqual([{ pins: ["@a/later", "@a/picked"], skill_discovery: true }]);
    expect(server.row?.pins.map((p) => p.id)).toEqual(["@a/later", "@a/picked"]);
    expect(result.current.held).toBe(true);
    expect(pinIds(result.current.skills)).toEqual(["@a/later", "@a/picked"]);
    expect(result.current.takeForTurn()).toBeUndefined();
    await unmount();
  });

  it("PATCHes a later message's cited skills once the first turn created the row", async () => {
    const { server, transport } = fakeServer(null);
    const { result, unmount } = await mount(transport, false);
    await act(async () => void result.current.takeForTurn());
    await settle();
    expect(result.current.held).toBe(false);
    server.row = { skill_discovery: true, pins: [] };
    await act(async () => result.current.pinCited(["@a/cited"]));
    // Held by the server before the message leaves: the turn reads it.
    expect(server.patches).toEqual([{ pins: ["@a/cited"], skill_discovery: true }]);
    expect(server.row?.pins.map((p) => p.id)).toEqual(["@a/cited"]);
    // The turn carries no pins, which the server would ignore.
    expect(result.current.takeForTurn()).toBeUndefined();
    await unmount();
  });

  it("keeps a change locally when the first turn created no row: the next turn carries it", async () => {
    const { server, transport } = fakeServer(null);
    const { result, unmount } = await mount(transport, false);
    await act(async () => void result.current.takeForTurn());
    await settle();
    await act(async () => result.current.setPin("@a/later", true));
    await act(async () => void (await result.current.pinCited(["@a/cited"])));
    await settle();
    expect(server.patches).toEqual([]);
    expect(pinIds(result.current.skills)).toEqual(["@a/cited", "@a/later"]);
    let taken: ReturnType<ConversationSkillsState["takeForTurn"]>;
    await act(async () => void (taken = result.current.takeForTurn()));
    expect(taken?.pins).toEqual(["@a/cited", "@a/later"]);
    await unmount();
  });
});
