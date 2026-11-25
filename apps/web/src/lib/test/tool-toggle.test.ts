// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { isToolToggleDisabled } from "../tool-toggle.ts";

describe("isToolToggleDisabled", () => {
  it("keeps an unusable tool of the saved selection toggleable once dropped, so it can be taken back", () => {
    expect(isToolToggleDisabled({ unusable: true, selected: false, saved: true })).toBe(false);
    expect(isToolToggleDisabled({ unusable: true, selected: true, saved: true })).toBe(false);
  });

  it("refuses to add an unusable tool that was never selected, and never blocks a usable one", () => {
    expect(isToolToggleDisabled({ unusable: true, selected: false, saved: false })).toBe(true);
    expect(isToolToggleDisabled({ unusable: false, selected: false, saved: false })).toBe(false);
  });
});
