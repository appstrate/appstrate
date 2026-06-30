// SPDX-License-Identifier: Apache-2.0

/**
 * System skills served by the platform MCP server. The scan is the whitelist:
 * `loadAssistantSkill` only ever reads a SKILL.md (or a `references/*.md`) that
 * belongs to a scanned skill, so a path-traversal value can never escape the
 * `skills/` folder. The `load_skill` tool wraps it for MCP consumers.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateRequestExtra } from "@appstrate/mcp-transport";
import {
  listAssistantSkills,
  loadAssistantSkill,
  renderAssistantSkillsIndex,
  resetAssistantSkillsCache,
} from "../../assistant-skills.ts";
import { buildMcpTools } from "../../tools.ts";

const noExtra = {} as unknown as AppstrateRequestExtra;

function parseResult(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text) as Record<string, unknown>;
}

function loadSkillTool() {
  const tools = buildMcpTools({
    origin: "https://test.local",
    authHeaders: new Headers(),
    permissions: new Set(["mcp:read"]),
    dispatch: async () => new Response("{}", { status: 200 }),
  });
  const t = tools.find((x) => x.descriptor.name === "load_skill");
  if (!t) throw new Error("load_skill tool not built");
  return t;
}

beforeEach(() => resetAssistantSkillsCache());

describe("listAssistantSkills", () => {
  it("indexes the skills shipped with the mcp module", () => {
    const names = listAssistantSkills().map((s) => s.name);
    expect(names).toContain("copilot");
    expect(names).toContain("web-search");
    expect(names).toContain("connector-choice");
  });

  it("gives every skill a non-empty single-line description", () => {
    for (const s of listAssistantSkills()) {
      expect(s.description.trim().length).toBeGreaterThan(0);
      expect(s.description).not.toContain("\n");
    }
  });
});

describe("renderAssistantSkillsIndex", () => {
  it("renders a '## Assistant skills' block naming each skill and the load_skill tool", () => {
    const block = renderAssistantSkillsIndex();
    expect(block).toContain("## Assistant skills");
    expect(block).toContain("`copilot`");
    expect(block).toContain("load_skill");
  });
});

describe("loadAssistantSkill", () => {
  it("returns the SKILL.md body for a known skill", () => {
    const loaded = loadAssistantSkill("copilot");
    expect(loaded).not.toBeNull();
    expect(loaded!.content).toContain("Copilote de création d'agents");
  });

  it("returns a reference doc when asked", () => {
    const loaded = loadAssistantSkill("copilot", "piloter-appstrate");
    expect(loaded).not.toBeNull();
    expect(loaded!.content.length).toBeGreaterThan(0);
  });

  it("returns null for unknown skill / reference", () => {
    expect(loadAssistantSkill("does-not-exist")).toBeNull();
    expect(loadAssistantSkill("copilot", "nope")).toBeNull();
  });

  it("rejects path-traversal in name and reference", () => {
    expect(loadAssistantSkill("../../../../etc/passwd")).toBeNull();
    expect(loadAssistantSkill("copilot", "../../../../../../etc/passwd")).toBeNull();
    expect(loadAssistantSkill("copilot/../web-search")).toBeNull();
  });
});

describe("load_skill MCP tool", () => {
  it("is read-only and built without mcp:invoke", () => {
    const t = loadSkillTool();
    expect(t.descriptor.annotations?.readOnlyHint).toBe(true);
  });

  it("returns the skill content for a valid name", async () => {
    const res = await loadSkillTool().handler({ name: "copilot" }, noExtra);
    expect(res.isError).toBeFalsy();
    const body = parseResult(res);
    expect(String(body.content)).toContain("Copilote de création d'agents");
  });

  it("returns an isError result for an unknown skill", async () => {
    const res = await loadSkillTool().handler({ name: "nope" }, noExtra);
    expect(res.isError).toBe(true);
    expect(String(parseResult(res).error)).toContain("No skill named");
  });
});
