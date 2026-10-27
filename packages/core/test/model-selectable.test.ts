// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { isModelSelectable } from "../src/model-selectable.ts";

describe("isModelSelectable", () => {
  it("is true for a model that is enabled and connected", () => {
    expect(isModelSelectable({ enabled: true, needs_reconnection: false })).toBe(true);
  });

  it("treats an absent field as usable (an older instance omits them)", () => {
    expect(isModelSelectable({})).toBe(true);
  });

  it("is false for a switched-off model", () => {
    expect(isModelSelectable({ enabled: false })).toBe(false);
  });

  it("is false for a model whose credential needs reconnection", () => {
    expect(isModelSelectable({ enabled: true, needs_reconnection: true })).toBe(false);
  });
});
