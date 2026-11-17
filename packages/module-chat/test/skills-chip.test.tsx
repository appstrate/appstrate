// SPDX-License-Identifier: Apache-2.0

/** The skills chip: the composer's entry to the picker while no skill is loaded. SSR only. */

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
  it("draws nothing in automatic mode, whatever pins are kept", () => {
    expect(html({ skillMode: "auto", pinnedSkills: [] })).toBe("");
    expect(html({ skillMode: "auto", pinnedSkills: ["@acme/a"] })).toBe("");
  });

  it("draws the button and its X back to automatic off the automatic mode", () => {
    for (const skillMode of ["manual", "strict"] as const) {
      const out = html({ skillMode, pinnedSkills: [] });
      expect(out).toContain("skills-picker-trigger");
      expect(out).toContain("skills-reset-auto");
    }
  });
});
