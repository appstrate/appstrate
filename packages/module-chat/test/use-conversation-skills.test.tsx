// SPDX-License-Identifier: Apache-2.0

/**
 * `useConversationSkills` mounted for real over a real `QueryClient`: what an accepted turn shows
 * before the conversation's detail was ever read, and the re-read an unanswered turn triggers.
 * There is no DOM harness in this repo; a hook rendering nothing needs only the few globals
 * react-dom's client touches, installed for this file and removed after it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PinnedSkill } from "../src/skills.ts";
import { skillRowState } from "../src/ui/chat-skills.ts";
import type { ChatTransport } from "../src/ui/runtime-context.ts";
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

/** A detail request held until `release`, answering the server's state at that moment. */
function heldDetails() {
  const server = { pins: [] as PinnedSkill[] };
  const held: (() => void)[] = [];
  const transport: ChatTransport = transportOver(
    (path) =>
      new Promise<Response>((resolve) =>
        held.push(() =>
          resolve(
            Response.json({
              id: path.split("/").pop(),
              title: null,
              messages: [],
              skill_discovery: true,
              skills: server.pins,
            }),
          ),
        ),
      ),
  );
  const release = () =>
    act(async () => {
      for (const answer of held.splice(0)) answer();
      // The response body, then the query's batched notification.
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  return { server, transport, release, reads: () => held.length };
}

async function mount(transport: ChatTransport, persisted: boolean) {
  const result = { current: undefined as unknown as ConversationSkillsState };
  function Probe() {
    result.current = useConversationSkills({ transport, id: "chs_c", persisted, enabled: true });
    return null;
  }
  const root: Root = createRoot(container());
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Probe />
      </QueryClientProvider>,
    ),
  );
  return { result, unmount: () => act(async () => root.unmount()) };
}

/** The transport's take, which settles the store: inside `act` like any update. */
async function take(state: { current: ConversationSkillsState }) {
  let taken: ReturnType<ConversationSkillsState["takeChanges"]>;
  await act(async () => void (taken = state.current.takeChanges()));
  return taken;
}

const row = (state: ConversationSkillsState, id: string) =>
  skillRowState(state.skills, id, new Set());

describe("useConversationSkills", () => {
  it("accepted on an uncached detail shows the sent pin, then reads the detail's verdict", async () => {
    const { server, transport, release, reads } = heldDetails();
    const { result, unmount } = await mount(transport, false);
    // A conversation new in this mount: nothing is read before a turn may have created it.
    expect(reads()).toBe(0);
    await act(async () => result.current.actions.togglePin("@a/new"));
    expect(await take(result)).toEqual({ pin: ["@a/new"], unpin: [] });
    server.pins = [{ id: "@a/new", source: "user", status: "over_budget" }];
    await act(async () => result.current.answered("accepted"));
    expect(row(result.current, "@a/new")).toEqual({ kind: "next" });
    expect(await take(result)).toBeUndefined();
    expect(reads()).toBe(1);
    await release();
    expect(row(result.current, "@a/new")).toEqual({ kind: "refused", reason: "over_budget" });
    await unmount();
  });

  it("unanswered drops the changes and reads the detail again", async () => {
    const { server, transport, release, reads } = heldDetails();
    const { result, unmount } = await mount(transport, true);
    expect(reads()).toBe(1);
    await release();
    await act(async () => result.current.actions.togglePin("@a/new"));
    await take(result);
    // The server applied the claim, but the turn's answer never arrived.
    server.pins = [{ id: "@a/new", source: "user", status: "injected" }];
    await act(async () => result.current.answered("unanswered"));
    expect(reads()).toBe(1);
    expect(row(result.current, "@a/new")).toEqual({ kind: "off" });
    await release();
    expect(row(result.current, "@a/new")).toEqual({ kind: "loaded", source: "user" });
    expect(await take(result)).toBeUndefined();
    await unmount();
  });
});
