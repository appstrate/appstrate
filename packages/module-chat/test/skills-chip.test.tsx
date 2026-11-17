// SPDX-License-Identifier: Apache-2.0

/** The skills chip: the composer's entry to the picker while no skill is loaded. SSR only. */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import { SkillsChip } from "../src/ui/skills-picker.tsx";
import type { ChatSkillSelection } from "../src/skills.ts";
import { testHost } from "./fake-request.ts";

function html(selection: ChatSkillSelection): string {
  return renderToStaticMarkup(
    <ChatHostProvider value={testHost()}>
      <SkillsChip selection={selection} onClick={() => {}} />
    </ChatHostProvider>,
  );
}

describe("SkillsChip", () => {
  it("draws nothing for the default selection", () => {
    expect(html({ skillMode: "auto", pinnedSkills: [] })).toBe("");
  });

  it("draws the button for a non-default selection", () => {
    expect(html({ skillMode: "manual", pinnedSkills: [] })).toContain("skills-picker-trigger");
  });
});
