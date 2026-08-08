// SPDX-License-Identifier: Apache-2.0

/**
 * Server-instructions assembly — the `## Assistant skills` index (issue #848).
 *
 * The index must sit BEFORE the operation index: the chat's
 * `applyOperationIndexPolicy` trims everything from `OPERATION_INDEX_HEADING`
 * onward for providers without a prompt cache, and the skills index has to
 * survive that trim. Skills come from the real `system-packages/` archives, so
 * this also pins that the shipped assistant skills reach the MCP surface.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { OPERATION_INDEX_HEADING } from "@appstrate/core/chat-contract";
import { initSystemPackages } from "../../../../services/system-packages.ts";
import { buildServerInstructions } from "../../router.ts";

const SKILLS_HEADING = "## Assistant skills";
const EXPECTED_ASSISTANT_SKILLS = [
  "@appstrate/agent-authoring",
  "@appstrate/connector-choice",
  "@appstrate/copilot",
  "@appstrate/skill-authoring",
  "@appstrate/web-search",
];

describe("buildServerInstructions — assistant skills index", () => {
  beforeAll(async () => {
    await initSystemPackages();
  });

  it("injects the assistant-skills index BEFORE the operation index", () => {
    const instructions = buildServerInstructions();
    const skillsAt = instructions.indexOf(SKILLS_HEADING);
    const indexAt = instructions.indexOf(OPERATION_INDEX_HEADING);
    expect(skillsAt).toBeGreaterThan(-1);
    expect(indexAt).toBeGreaterThan(-1);
    expect(skillsAt).toBeLessThan(indexAt);
  });

  it("lists the shipped skills with the getSkill load instruction", () => {
    const instructions = buildServerInstructions();
    const section = instructions.slice(
      instructions.indexOf(SKILLS_HEADING),
      instructions.indexOf(OPERATION_INDEX_HEADING),
    );
    expect(section).toContain("`@appstrate/copilot`");
    expect(section).toContain("`@appstrate/web-search`");
    expect(section).toContain("`@appstrate/connector-choice`");
    expect(section).toContain("`@appstrate/agent-authoring`");
    expect(section).toContain("`@appstrate/skill-authoring`");
    expect(section).toContain("Assembler, modifier ou valider un agent enregistré");
    expect(section).toContain("Créer ou améliorer une skill de méthode");
    expect(section).toContain('`operation_id: "getSkill"`');
    expect(section).toContain("Choose the most specific guide");
    expect(section).toContain("Load one guide at a time");
    expect(section).toContain("If none clearly matches, load none");
    const indexedIds = Array.from(section.matchAll(/^- `([^`]+)`/gm), (match) => match[1]);
    expect(indexedIds).toEqual(EXPECTED_ASSISTANT_SKILLS);
    expect(section).not.toContain("`@appstrate/code-review`");
    expect(section).not.toContain("plus reference methods");
  });
});
