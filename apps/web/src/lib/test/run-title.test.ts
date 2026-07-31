// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { inlineRunDisplayName, runPageTitle } from "../run-title.ts";

describe("inline run titles", () => {
  it("uses the task-specific manifest display name on the run page", () => {
    const inlineName = inlineRunDisplayName("  Analyse des 3 derniers e-mails  ", "Run inline");

    expect(
      runPageTitle({
        isInline: true,
        inlineName,
        numberedTitle: "Run #42",
      }),
    ).toBe("Analyse des 3 derniers e-mails");
  });

  it("keeps numbered titles for cataloged-agent runs", () => {
    expect(
      runPageTitle({
        isInline: false,
        inlineName: "Unused inline name",
        numberedTitle: "Run #42",
      }),
    ).toBe("Run #42");
  });

  it("uses the localized inline fallback when the manifest supplied no display name", () => {
    expect(inlineRunDisplayName("   ", "Run inline")).toBe("Run inline");
  });
});
