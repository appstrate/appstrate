// SPDX-License-Identifier: Apache-2.0

/**
 * A skill the assistant reads (`read_resource`, or the forwarded `read`, on its `SKILL.md`) is
 * drawn with the user's skill chip, read for that message only, with an « Épingler » action while
 * the conversation can take the pin; a running read and a failed one each say so. The chip stays
 * in view under its activity group's line; any other read keeps nothing there. SSR only.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MessageProvider, type ThreadMessage } from "@assistant-ui/react";

import { CHAT_SKILLS_CONTENT_BUDGET_CHARS } from "../src/skills.ts";
import { ChatHostProvider, ChatTransportProvider } from "../src/ui/runtime-context.ts";
import { skillLoadOf, type StoredSkills } from "../src/ui/chat-skills.ts";
import { SkillReadBreakout } from "../src/ui/skill-load.tsx";
import {
  ConversationSkillsProvider,
  type ConversationSkillsState,
} from "../src/ui/use-conversation-skills.ts";
import { transportOf } from "./fake-request.ts";
import { testHost } from "./test-host.ts";

/** The conversation's skills as the thread reads them: `held`, pins of `ids` loaded at `chars`. */
function conversationOf(ids: string[], held = true, chars = 100): ConversationSkillsState {
  const skills: StoredSkills = {
    skillDiscovery: true,
    pins: ids.map((id) => ({ id, status: "injected", chars })),
  };
  return {
    skills,
    held,
    setPin: () => {},
    setDiscovery: () => {},
    reset: () => {},
    pinCited: async () => {},
    takeForTurn: () => undefined,
  };
}

const SKILL_MD = "skill://spc_a/acme/tone/brand-tone/SKILL.md";
const transport = transportOf(() => ({ "X-Org-Id": "org_1" }), null);
const host = testHost({
  t: (key, options) => (options?.name ? `${key} name=${String(options.name)}` : key),
});

/** The assistant message a card sits in, as the thread mounts it. */
const MESSAGE = {
  id: "msg_1",
  role: "assistant",
  content: [],
  status: { type: "complete", reason: "stop" },
  metadata: {
    unstable_state: null,
    unstable_annotations: [],
    unstable_data: [],
    steps: [],
    custom: {},
  },
  createdAt: new Date(0),
} as unknown as ThreadMessage;

function render(
  part: {
    toolName?: string;
    args: Record<string, unknown>;
    result?: unknown;
    isError?: boolean;
    status: { type: string };
  },
  conversation: ConversationSkillsState | null = conversationOf([]),
  /** The read skill's listed size in the commands catalogue; `undefined`: not listed. */
  bytes?: number | null,
): string {
  const props = { type: "tool-call", toolCallId: "call_1", toolName: "read_resource", ...part };
  const qc = new QueryClient();
  if (bytes !== undefined) {
    qc.setQueryData(["packages", "chat-commands", "org_1", null, true], {
      skills: [{ id: "@acme/tone", name: "brand-tone", description: "", version: null, bytes }],
      agents: [],
    });
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ChatHostProvider value={host}>
        <ChatTransportProvider value={transport}>
          <ConversationSkillsProvider value={conversation}>
            <MessageProvider message={MESSAGE} index={0}>
              <SkillReadBreakout
                {...(props as unknown as Parameters<typeof SkillReadBreakout>[0])}
              />
            </MessageProvider>
          </ConversationSkillsProvider>
        </ChatTransportProvider>
      </ChatHostProvider>
    </QueryClientProvider>,
  );
}

describe("skillLoadOf", () => {
  it("names the skill a SKILL.md read loads, published or draft", () => {
    expect(skillLoadOf({ uri: SKILL_MD })).toEqual({ packageId: "@acme/tone", name: "brand-tone" });
    expect(skillLoadOf({ uri: "skill://spc_a/acme/tone@draft/brand-tone/SKILL.md" })).toEqual({
      packageId: "@acme/tone",
      name: "brand-tone",
    });
  });

  it("is null for a file of a skill, another resource, or a malformed input", () => {
    expect(skillLoadOf({ uri: "skill://spc_a/acme/tone/brand-tone/refs/guide.md" })).toBeNull();
    expect(skillLoadOf({ uri: "appfile://spc_a/fil_1" })).toBeNull();
    expect(skillLoadOf({ uri: 42 })).toBeNull();
    expect(skillLoadOf(undefined)).toBeNull();
  });
});

describe("SkillReadBreakout", () => {
  const chip = (html: string) => html.match(/<span[^>]*data-testid="directive-chip"[^>]*>/)?.[0];
  const live = (html: string) =>
    html.match(/<span[^>]*data-testid="skill-load-live"[^>]*>([^<]*)</);
  const caption = (html: string) =>
    html.match(/<span[^>]*data-testid="skill-load-state"[^>]*>([^<]*)</);
  const read = { args: { uri: SKILL_MD }, result: { content: [{ type: "text", text: "Body" }] } };
  const done = { ...read, status: { type: "complete" } };

  it("draws a read as the user's skill chip, read for this message, named in the live region", () => {
    const html = render(done);
    expect(html).toContain('data-phase="success"');
    expect(html).toContain('data-state="read"');
    expect(chip(html)).toContain('data-directive-type="skill"');
    expect(chip(html)).not.toContain("border-dashed");
    expect(html).toContain(">brand-tone<");
    expect(html).not.toContain("animate-pulse");
    const region = live(html)!;
    expect(region[0]).toContain('aria-live="polite"');
    expect(region[0]).toContain("sr-only");
    expect(region[1]).toBe("skills.load.live.read name=brand-tone");
    const shown = caption(html)!;
    expect(shown[1]).toBe("skills.load.read");
    expect(shown[0]).toContain('aria-hidden="true"');
  });

  it("offers to pin the skill, named in the action's label", () => {
    const html = render(done);
    const action = html.match(/<button[^>]*data-testid="skill-load-pin"[^>]*>/)![0];
    expect(action).toContain('aria-label="skills.load.pinLabel name=brand-tone"');
    expect(action).not.toContain("aria-disabled");
  });

  it("offers no pin for a skill already pinned, a conversation the server does not hold, or no panel", () => {
    expect(render(done, conversationOf(["@acme/tone"]))).not.toContain("skill-load-pin");
    expect(render(done, conversationOf([], false))).not.toContain("skill-load-pin");
    expect(render(done, null)).not.toContain("skill-load-pin");
  });

  it("an estimate past the budget leaves the action available with a warning", () => {
    const action = (html: string) =>
      html.match(/<button[^>]*data-testid="skill-load-pin"[^>]*>/)![0];
    // One pin leaves 1 000 characters of the budget.
    const near = conversationOf(["@x/1"], true, CHAT_SKILLS_CONTENT_BUDGET_CHARS - 1_000);
    const html = render(done, near, 1_001);
    expect(action(html)).not.toContain("aria-disabled");
    expect(action(html)).toContain('title="skills.budget.wouldExceed"');
    const describedBy = action(html).match(/aria-describedby="([^"]+)"/)![1];
    expect(html).toMatch(new RegExp(`id="${describedBy}"[^>]*>skills.budget.wouldExceed<`));
    // A size that fits, an unknown one, or a skill the catalogue does not list: it pins.
    expect(action(render(done, near, 1_000))).not.toContain("aria-disabled");
    expect(action(render(done, near, null))).not.toContain("aria-disabled");
    expect(action(render(done, near))).not.toContain("aria-disabled");
  });

  it("marks a load still running as pending", () => {
    const html = render({ args: { uri: SKILL_MD }, status: { type: "running" } });
    expect(html).toContain('data-phase="running"');
    expect(html).toContain('data-state="running"');
    expect(chip(html)).toContain("motion-safe:animate-pulse");
    expect(live(html)![1]).toBe("skills.load.live.running name=brand-tone");
    expect(caption(html)).toBeNull();
    expect(html).not.toContain("skill-load-pin");
  });

  it("mutes a failed read and says so in the user's language, never the model's error", () => {
    const refusal = "The skill could not be read.";
    const html = render({
      args: { uri: SKILL_MD },
      result: { error: refusal },
      isError: true,
      status: { type: "incomplete" },
    });
    expect(html).toContain('data-phase="error"');
    expect(html).toContain('data-state="error"');
    expect(chip(html)).toContain("border-dashed");
    expect(live(html)![1]).toBe("skills.load.live.error name=brand-tone");
    expect(caption(html)![1]).toBe("skills.load.error");
    expect(html).not.toContain(refusal);
    expect(html).not.toContain("skill-load-pin");
  });

  it("draws a skill loaded through the forwarded `read` the same way; any other read keeps nothing in view", () => {
    const skill = render({
      toolName: "read",
      args: { uri: SKILL_MD, space_id: "spc_a" },
      result: { content: [{ type: "text", text: "meta" }] },
      status: { type: "complete" },
    });
    expect(skill).toContain('data-state="read"');
    expect(skill).toContain(">brand-tone<");
    const file = render({
      toolName: "read",
      args: { uri: "appfile://spc_a/fil_1" },
      result: { content: [{ type: "text", text: "file" }] },
      status: { type: "complete" },
    });
    expect(file).toBe("");
    const guide = render({
      args: { uri: "skill://spc_a/acme/tone/brand-tone/refs/guide.md" },
      result: { content: [{ type: "text", text: "guide" }] },
      status: { type: "complete" },
    });
    expect(guide).toBe("");
  });
});
