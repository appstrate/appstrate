// SPDX-License-Identifier: Apache-2.0

/**
 * A skill the assistant reads (`read_resource`, or the forwarded `read`, on its `SKILL.md`) is
 * drawn with the user's skill chip, read for that message only, with an « Épingler » action while
 * the conversation can take the pin; a running read and a failed one each say so. Any other read
 * keeps the generic tool row. SSR only.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import { skillLoadOf, skillLoadState, type StoredSkills } from "../src/ui/chat-skills.ts";
import { ResourceReadTool } from "../src/ui/skill-load.tsx";
import {
  ConversationSkillsProvider,
  type ConversationSkillsState,
} from "../src/ui/use-conversation-skills.ts";
import { testHost } from "./test-host.ts";

/** The conversation's skills as the thread reads them: `held`, pins of `ids`. */
function conversationOf(ids: string[], held = true): ConversationSkillsState {
  const skills: StoredSkills = {
    skillDiscovery: true,
    pins: ids.map((id) => ({ id, status: "injected", chars: 100 })),
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
const host = testHost({
  t: (key, options) => (options?.name ? `${key} name=${String(options.name)}` : key),
});

function render(
  part: {
    toolName?: string;
    args: Record<string, unknown>;
    result?: unknown;
    isError?: boolean;
    status: { type: string };
  },
  conversation: ConversationSkillsState | null = conversationOf([]),
): string {
  const props = { type: "tool-call", toolCallId: "call_1", toolName: "read_resource", ...part };
  return renderToStaticMarkup(
    <ChatHostProvider value={host}>
      <ConversationSkillsProvider value={conversation}>
        <ResourceReadTool {...(props as unknown as Parameters<typeof ResourceReadTool>[0])} />
      </ConversationSkillsProvider>
    </ChatHostProvider>,
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

describe("skillLoadState", () => {
  it("is read once the read succeeds, whatever its result; a failure is an error", () => {
    expect(skillLoadState("success")).toBe("read");
    expect(skillLoadState("error")).toBe("error");
    expect(skillLoadState("running")).toBe("running");
    expect(skillLoadState("pending")).toBe("running");
  });
});

describe("ResourceReadTool", () => {
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

  it("at the cap keeps the action focusable and says why it cannot pin", () => {
    const full = conversationOf(["@x/1", "@x/2", "@x/3", "@x/4", "@x/5"]);
    const html = render(done, full);
    const action = html.match(/<button[^>]*data-testid="skill-load-pin"[^>]*>/)![0];
    expect(action).toContain('aria-disabled="true"');
    expect(action).toContain('title="skills.chosenMax"');
    const describedBy = action.match(/aria-describedby="([^"]+)"/)![1];
    expect(html).toContain(`id="${describedBy}"`);
  });

  it("marks a load still running as pending", () => {
    const html = render({ args: { uri: SKILL_MD }, status: { type: "running" } });
    expect(html).toContain('data-phase="running"');
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
    expect(chip(html)).toContain("border-dashed");
    expect(live(html)![1]).toBe("skills.load.live.error name=brand-tone");
    expect(caption(html)![1]).toBe("skills.load.error");
    expect(html).not.toContain(refusal);
    expect(html).not.toContain("skill-load-pin");
  });

  it("keeps the generic tool row for any other resource", () => {
    const html = render({
      args: { uri: "skill://spc_a/acme/tone/brand-tone/refs/guide.md" },
      result: { content: [{ type: "text", text: "guide" }] },
      status: { type: "complete" },
    });
    expect(html).not.toContain("directive-chip");
    expect(html).not.toContain("skill-load");
    expect(html).toContain("read_resource");
  });

  it("draws a skill loaded through the forwarded `read` the same way, its other reads generic", () => {
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
    expect(file).not.toContain("directive-chip");
    expect(file).toContain(">read<");
  });
});
