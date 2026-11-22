// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { shouldBlurAfterRunStart } from "../src/ui/run-start-focus.ts";

describe("shouldBlurAfterRunStart", () => {
  const phone = { autofocus: false, focusedAtSend: false, focusedNow: true };

  it("blurs the editor the library focused for a user who had left it", () => {
    expect(shouldBlurAfterRunStart(phone)).toBe(true);
  });

  it("leaves a field the user was typing in, and a device that auto-focuses", () => {
    expect(shouldBlurAfterRunStart({ ...phone, focusedAtSend: true })).toBe(false);
    expect(shouldBlurAfterRunStart({ ...phone, autofocus: true })).toBe(false);
  });

  it("has nothing to blur when the editor holds no focus", () => {
    expect(shouldBlurAfterRunStart({ ...phone, focusedNow: false })).toBe(false);
  });
});
