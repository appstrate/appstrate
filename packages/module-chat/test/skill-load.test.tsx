// SPDX-License-Identifier: Apache-2.0

/**
 * A skill the assistant reads (`read_resource`, or the forwarded `read`, on its `SKILL.md`) is
 * drawn with the user's skill chip, said loaded only when the result carries `skillPinned`; a read
 * the server did not pin, a running one and a failed one each say so. Any other read keeps the
 * generic tool row. SSR only.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import { skillLoadOf, skillLoadState } from "../src/ui/chat-skills.ts";
import { ResourceReadTool } from "../src/ui/skill-load.tsx";
import { testHost } from "./test-host.ts";

const SKILL_MD = "skill://spc_a/acme/tone/brand-tone/SKILL.md";
const host = testHost({
  t: (key, options) => (options?.name ? `${key} name=${String(options.name)}` : key),
});

function render(part: {
  toolName?: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  status: { type: string };
}): string {
  const props = { type: "tool-call", toolCallId: "call_1", toolName: "read_resource", ...part };
  return renderToStaticMarkup(
    <ChatHostProvider value={host}>
      <ResourceReadTool {...(props as unknown as Parameters<typeof ResourceReadTool>[0])} />
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
  it("claims a load only for a successful read the server pinned", () => {
    expect(skillLoadState("success", { content: [], skillPinned: true })).toBe("loaded");
    expect(skillLoadState("success", { content: [{ type: "text", text: "Body" }] })).toBe(
      "readOnly",
    );
    expect(skillLoadState("success", { content: [], skillPinned: "true" })).toBe("readOnly");
    expect(skillLoadState("success", undefined)).toBe("readOnly");
    expect(skillLoadState("error", { skillPinned: true })).toBe("refused");
    expect(skillLoadState("running", undefined)).toBe("running");
    expect(skillLoadState("pending", undefined)).toBe("running");
  });
});

describe("ResourceReadTool", () => {
  const chip = (html: string) => html.match(/<span[^>]*data-testid="directive-chip"[^>]*>/)?.[0];
  const live = (html: string) =>
    html.match(/<span[^>]*data-testid="skill-load-live"[^>]*>([^<]*)</);
  const caption = (html: string) =>
    html.match(/<span[^>]*data-testid="skill-load-state"[^>]*>([^<]*)</);
  const receipt = JSON.stringify({ uri: SKILL_MD, skill: "@acme/tone", loaded: true });

  it("draws a pinned load as the user's skill chip, naming it in the live region", () => {
    const html = render({
      args: { uri: SKILL_MD },
      result: { content: [{ type: "text", text: receipt }], skillPinned: true },
      status: { type: "complete" },
    });
    expect(html).toContain('data-phase="success"');
    expect(html).toContain('data-state="loaded"');
    expect(chip(html)).toContain('data-directive-type="skill"');
    expect(chip(html)).not.toContain("border-dashed");
    expect(html).toContain(">brand-tone<");
    expect(html).not.toContain("animate-pulse");
    const region = live(html)!;
    expect(region[0]).toContain('aria-live="polite"');
    expect(region[0]).toContain("sr-only");
    expect(region[1]).toBe("skills.load.live.loaded name=brand-tone");
    expect(caption(html)).toBeNull();
  });

  it("never says loaded for a read the server did not pin: read, not pinned", () => {
    const note =
      "The skill `@acme/tone` was read for this turn but not pinned to the conversation.";
    const html = render({
      args: { uri: SKILL_MD },
      result: {
        content: [
          { type: "text", text: "---\nname: brand-tone\n---\nBody" },
          { type: "text", text: note },
        ],
      },
      status: { type: "complete" },
    });
    expect(html).toContain('data-phase="success"');
    expect(html).toContain('data-state="readOnly"');
    expect(chip(html)).toContain("border-dashed");
    expect(live(html)![1]).toBe("skills.load.live.readOnly name=brand-tone");
    const shown = caption(html)!;
    expect(shown[1]).toBe("skills.load.readOnly");
    expect(shown[0]).toContain('aria-hidden="true"');
    expect(html).not.toContain("skills.load.live.loaded");
    expect(html).not.toContain(note);
  });

  it("marks a load still running as pending", () => {
    const html = render({ args: { uri: SKILL_MD }, status: { type: "running" } });
    expect(html).toContain('data-phase="running"');
    expect(chip(html)).toContain("motion-safe:animate-pulse");
    expect(live(html)![1]).toBe("skills.load.live.running name=brand-tone");
    expect(caption(html)).toBeNull();
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
    expect(live(html)![1]).toBe("skills.load.live.refused name=brand-tone");
    expect(caption(html)![1]).toBe("skills.load.refused");
    expect(html).not.toContain(refusal);
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
      result: { content: [{ type: "text", text: "meta" }], skillPinned: true },
      status: { type: "complete" },
    });
    expect(skill).toContain('data-state="loaded"');
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
