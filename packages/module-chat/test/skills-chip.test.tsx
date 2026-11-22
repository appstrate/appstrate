// SPDX-License-Identifier: Apache-2.0

/** The skills chip: the composer's entry to the picker while no skill is pinned. SSR only. */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import { SkillsChip } from "../src/ui/skills-picker.tsx";
import type { ChatSkillSelection } from "../src/skills.ts";
import { testHost } from "./test-host.ts";

function html(selection: ChatSkillSelection): string {
  return renderToStaticMarkup(
    <ChatHostProvider value={testHost()}>
      <SkillsChip selection={selection} onClick={() => {}} onReset={() => {}} />
    </ChatHostProvider>,
  );
}

describe("SkillsChip", () => {
  it("draws nothing while discovery is on", () => {
    expect(html({ skillDiscovery: true, pinnedSkills: [] })).toBe("");
  });

  it("draws the button and its X back to the default with discovery off", () => {
    const out = html({ skillDiscovery: false, pinnedSkills: [] });
    expect(out).toContain("skills-picker-trigger");
    expect(out).toContain("skills.discoveryOffChip");
    expect(out).toContain('aria-label="skills.reset"');
  });
});
