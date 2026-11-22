// SPDX-License-Identifier: Apache-2.0

/**
 * A skill the assistant loads (`read_resource`, or the forwarded `read`, on its `SKILL.md`) is drawn with the user's skill
 * chip: live, after a reload (the persisted receipt), still running, and refused. Any other read
 * keeps the generic tool row. SSR only.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import { skillLoadOf } from "../src/ui/chat-skills.ts";
import { ResourceReadTool } from "../src/ui/skill-load.tsx";
import { testHost } from "./test-host.ts";

const SKILL_MD = "skill://spc_a/acme/tone/brand-tone/SKILL.md";

function render(part: {
  toolName?: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  status: { type: string };
}): string {
  const props = { type: "tool-call", toolCallId: "call_1", toolName: "read_resource", ...part };
  return renderToStaticMarkup(
    <ChatHostProvider value={testHost()}>
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

describe("ResourceReadTool", () => {
  const chip = (html: string) => html.match(/<span[^>]*data-testid="directive-chip"[^>]*>/)?.[0];

  it("draws a loaded skill as the user's skill chip", () => {
    const html = render({
      args: { uri: SKILL_MD },
      result: { content: [{ type: "text", text: "---\nname: brand-tone\n---\nBody" }] },
      status: { type: "complete" },
    });
    expect(html).toContain('data-phase="success"');
    expect(chip(html)).toContain('data-directive-type="skill"');
    expect(html).toContain(">brand-tone<");
    expect(html).toContain("skills.load.done");
    expect(html).not.toContain("animate-pulse");
    expect(html).not.toContain("skill-load-refusal");
  });

  it("draws the same chip after a reload, from the persisted receipt", () => {
    const receipt = JSON.stringify({ uri: SKILL_MD, skill: "@acme/tone", pinned: true });
    const html = render({
      args: { uri: SKILL_MD },
      result: { content: [{ type: "text", text: receipt }] },
      status: { type: "complete" },
    });
    expect(html).toContain('data-phase="success"');
    expect(html).toContain(">brand-tone<");
  });

  it("marks a load still running as pending", () => {
    const html = render({ args: { uri: SKILL_MD }, status: { type: "running" } });
    expect(html).toContain('data-phase="running"');
    expect(chip(html)).toContain("animate-pulse");
    expect(html).toContain("skills.load.running");
  });

  it("mutes a refused load and gives the refusal", () => {
    const refusal = "This conversation already pins 5 skills; the user can unpin one.";
    const html = render({
      args: { uri: SKILL_MD },
      result: { error: refusal },
      isError: true,
      status: { type: "incomplete" },
    });
    expect(html).toContain('data-phase="error"');
    expect(chip(html)).toContain("border-dashed");
    expect(html).toContain("skills.load.refused");
    expect(html).toContain(refusal);
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
      result: { content: [{ type: "text", text: "loaded" }] },
      status: { type: "complete" },
    });
    expect(skill).toContain('data-phase="success"');
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
