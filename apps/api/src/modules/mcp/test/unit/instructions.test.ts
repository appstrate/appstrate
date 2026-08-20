// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, it } from "bun:test";
import { OPERATION_INDEX_HEADING } from "@appstrate/core/chat-contract";
import { initSystemPackages } from "../../../../services/system-packages.ts";
import { buildServerInstructions } from "../../router.ts";

const EXPECTED_SKILLS = [
  "@appstrate/agent-authoring",
  "@appstrate/connector-choice",
  "@appstrate/copilot",
  "@appstrate/skill-authoring",
  "@appstrate/web-search",
];

describe("MCP assistant skill discovery", () => {
  beforeAll(async () => {
    await initSystemPackages();
  });

  it("automatically injects the compact skill index before the operation index", () => {
    const instructions = buildServerInstructions();
    const skillsAt = instructions.indexOf("## Assistant skills");
    const operationsAt = instructions.indexOf(OPERATION_INDEX_HEADING);

    expect(skillsAt).toBeGreaterThan(-1);
    expect(skillsAt).toBeLessThan(operationsAt);
    const section = instructions.slice(skillsAt, operationsAt);
    expect(Array.from(section.matchAll(/^- `([^`]+)`/gm), (match) => match[1])).toEqual(
      EXPECTED_SKILLS,
    );
    expect(section).toContain('`operation_id: "getSkill"`');
  });
});
