// SPDX-License-Identifier: Apache-2.0

/**
 * The `/` menu in the composer, SSR only: the listbox it draws and what the input's key handler
 * does with it. The handler is called during a render (no DOM here), so the keys exercised are the
 * ones that act through callbacks; arrows and Escape are `slashKey`'s, tested apart.
 */

import { describe, expect, it } from "bun:test";
import type { KeyboardEvent, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MAX_PINNED_SKILLS } from "../src/skills.ts";
import type { ChatCommands } from "../src/commands.ts";
import { ConversationScopeProvider } from "../src/ui/conversation-scope.ts";
import { ChatHostProvider, ChatTransportProvider } from "../src/ui/runtime-context.ts";
import { SlashMenuList } from "../src/ui/slash-menu.tsx";
import {
  SkillSelectionProvider,
  useSlashMenu,
  type SkillSelectionControl,
} from "../src/ui/use-slash-menu.ts";
import { slashEntries } from "../src/ui/slash-menu.ts";
import type { AgentChip } from "../src/ui/agent-prompt-part.ts";
import { transportOf } from "./fake-request.ts";
import { conversationScope, testHost } from "./test-host.ts";

const commands: ChatCommands = {
  skills: [
    { id: "@acme/tone", name: "tone", description: "Adjusts tone", version: "1.2.0" },
    { id: "@acme/pdf", name: "pdf", description: "Reads PDF files", version: null },
  ],
  agents: [{ name: "run-report", title: "Weekly report", description: "Builds the report" }],
};
const transport = transportOf(() => ({}));

function Providers({
  children,
  control,
  can = () => true,
}: {
  children: ReactNode;
  control: SkillSelectionControl | null;
  can?: (permission: string) => boolean;
}) {
  const qc = new QueryClient();
  qc.setQueryData(["packages", "chat-commands", "org_1", null], commands);
  return (
    <QueryClientProvider client={qc}>
      <ChatHostProvider value={testHost({ can })}>
        <ChatTransportProvider value={transport}>
          <ConversationScopeProvider value={conversationScope()}>
            <SkillSelectionProvider value={control}>{children}</SkillSelectionProvider>
          </ConversationScopeProvider>
        </ChatTransportProvider>
      </ChatHostProvider>
    </QueryClientProvider>
  );
}

interface Probed {
  open: boolean;
  names: string[];
  handled: boolean | null;
  prevented: boolean;
  pinned: SkillSelectionControl["selection"][];
  texts: string[];
  agents: AgentChip[];
  input: Record<string, unknown>;
}

/** Renders the menu's hook for `text` and presses `key` once; reports what it did. */
function press(
  text: string,
  key: string | null,
  options: {
    pinned?: string[];
    running?: boolean;
    control?: boolean;
    can?: (permission: string) => boolean;
  } = {},
): Probed {
  const out: Probed = {
    open: false,
    names: [],
    handled: null,
    prevented: false,
    pinned: [],
    texts: [],
    agents: [],
    input: {},
  };
  const selection = { skillDiscovery: true, pinnedSkills: options.pinned ?? [] };
  const control =
    options.control === false
      ? null
      : { selection, onChange: (next: typeof selection) => out.pinned.push(next) };
  function Probe() {
    const menu = useSlashMenu({
      text,
      setText: (next) => out.texts.push(next),
      running: options.running ?? false,
      setAgent: (agent) => out.agents.push(agent),
    });
    out.open = menu.open;
    out.input = menu.inputProps;
    out.names = menu.entries.map((e) => (e.kind === "skill" ? e.skill.name : e.agent.name));
    if (key) {
      out.handled = menu.onKeyDown({
        key,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: () => (out.prevented = true),
      } as unknown as KeyboardEvent<HTMLTextAreaElement>);
    }
    return null;
  }
  renderToStaticMarkup(
    <Providers control={control} can={options.can}>
      <Probe />
    </Providers>,
  );
  return out;
}

describe("the / menu", () => {
  it("opens on a /token and lists what the route returned, filtered by the text after the slash", () => {
    const all = press("/", null);
    expect(all.open).toBe(true);
    expect(all.names).toEqual(["tone", "pdf", "run-report"]);
    expect(press("/to", null).names).toEqual(["tone"]);
    expect(press("/ZZ", null).names).toEqual([]);
  });

  it("names the listbox and its active option on the input while open, nothing while closed", () => {
    const open = press("/", null);
    expect(open.input["aria-haspopup"]).toBe("listbox");
    expect(open.input["aria-controls"]).toBeString();
    expect(String(open.input["aria-activedescendant"])).toStartWith(
      String(open.input["aria-controls"]),
    );
    expect(press("hello", null).input).toEqual({});
  });

  it("closes on a draft with no match, and Enter is then left to send the text as typed", () => {
    const none = press("/foo", "Enter");
    expect(none.open).toBe(false);
    expect(none.handled).toBe(false);
    expect(none.prevented).toBe(false);
    expect(none.texts).toEqual([]);
  });

  it("is closed once the first token has whitespace", () => {
    expect(press("/tone make it shorter", "Enter").open).toBe(false);
  });

  it("takes Enter while open: it selects, the key is consumed and nothing is sent", () => {
    const out = press("/to", "Enter");
    expect(out.handled).toBe(true);
    expect(out.prevented).toBe(true);
    expect(out.pinned).toHaveLength(1);
  });

  it("selects on Tab as on Enter", () => {
    const out = press("/to", "Tab");
    expect(out.handled).toBe(true);
    expect(out.pinned).toHaveLength(1);
  });

  it("pins the skill through the selection change, keeps the other pins, and strips the token", () => {
    const out = press("/to", "Enter", { pinned: ["@x/a"] });
    expect(out.pinned).toEqual([{ skillDiscovery: true, pinnedSkills: ["@x/a", "@acme/tone"] }]);
    expect(out.texts).toEqual([""]);
    expect(out.agents).toEqual([]);
  });

  it("closes on an already pinned skill: nothing changes, the token goes", () => {
    const out = press("/to", "Enter", { pinned: ["@acme/tone"] });
    expect(out.pinned).toEqual([]);
    expect(out.texts).toEqual([""]);
  });

  it("refuses a skill at the cap, with no eviction, the menu open and the draft kept", () => {
    const full = Array.from({ length: MAX_PINNED_SKILLS }, (_, i) => `@x/s${i}`);
    const out = press("/to", "Enter", { pinned: full });
    expect(out.handled).toBe(true);
    expect(out.open).toBe(true);
    expect(out.pinned).toEqual([]);
    expect(out.texts).toEqual([]);
  });

  it("makes an agent the composer's chip and strips the token", () => {
    const out = press("/run", "Enter");
    expect(out.names).toEqual(["run-report"]);
    expect(out.agents).toEqual([{ name: "run-report", title: "Weekly report" }]);
    expect(out.texts).toEqual([""]);
    expect(out.pinned).toEqual([]);
  });

  it("offers no agent while a turn runs", () => {
    expect(press("/", null, { running: true }).names).toEqual(["tone", "pdf"]);
    expect(press("/run", "Enter", { running: true }).open).toBe(false);
  });

  it("lists no skill where the selection cannot be changed", () => {
    expect(press("/", null, { control: false }).names).toEqual(["run-report"]);
  });

  it("is never open for a caller who may not write the chat", () => {
    const reader = press("/", "Enter", { can: (permission) => permission !== "chat:write" });
    expect(reader.open).toBe(false);
    expect(reader.handled).toBe(false);
  });
});

function list(active: number, pinned: string[] = []): string {
  const entries = slashEntries(commands, "", { pinned, running: false, canPin: true });
  return renderToStaticMarkup(
    <ChatHostProvider value={testHost()}>
      <SlashMenuList
        entries={entries}
        active={active}
        listId="menu"
        onChoose={() => {}}
        onHover={() => {}}
      />
    </ChatHostProvider>,
  );
}

describe("SlashMenuList", () => {
  it("is a listbox of options in two named sections, skills then agents", () => {
    const html = list(0);
    expect(html).toContain('role="listbox"');
    expect(html.match(/role="option"/g)).toHaveLength(3);
    expect(html.match(/role="group"/g)).toHaveLength(2);
    expect(html.indexOf("slash.skills")).toBeLessThan(html.indexOf("slash.agents"));
    expect(html.indexOf("tone")).toBeLessThan(html.indexOf("slash.agents"));
  });

  it("marks the active option, and ids every option for aria-activedescendant", () => {
    const html = list(2);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain('id="menu-0"');
    expect(html).toContain('id="menu-2"');
    expect(html.match(/<div id="menu-2" role="option" aria-selected="true"/)).not.toBeNull();
  });

  it("says that an agent starts a billed run, and a skill does not", () => {
    const html = list(0);
    expect(html.match(/slash\.agentRun/g)).toHaveLength(1);
    expect(html).toContain("v1.2.0");
  });

  it("shows a pinned skill as added, and disables the unpinned ones at the cap with the cap message", () => {
    expect(list(0, ["@acme/tone"])).toContain("slash.pinned");
    const full = Array.from({ length: MAX_PINNED_SKILLS - 1 }, (_, i) => `@x/s${i}`);
    const capped = list(0, [...full, "@acme/pdf"]);
    expect(capped.match(/aria-disabled="true"/g)).toHaveLength(1);
    expect(capped).toContain("skills.chosenMax");
    expect(capped).toContain("slash.pinned");
  });
});
