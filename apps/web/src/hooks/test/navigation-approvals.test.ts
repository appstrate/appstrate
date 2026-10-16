// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { approvals } from "../use-unsaved-changes.ts";

const theme = Symbol("theme");
const language = Symbol("language");

describe("leaving multiple dirty forms", () => {
  it("requires an independent decision for each form", () => {
    approvals.clear();
    approvals.approve(theme, "/general");
    expect(approvals.has(theme, "/general")).toBe(true);
    expect(approvals.has(language, "/general")).toBe(false);
    approvals.approve(language, "/general");
    expect(approvals.has(theme, "/general")).toBe(true);
    expect(approvals.has(language, "/general")).toBe(true);
  });
  it("never reuses a decision after cancel, arrival, or a different destination", () => {
    approvals.clear();
    approvals.approve(theme, "/general");
    expect(approvals.has(theme, "/other")).toBe(false);
    expect(approvals.has(theme, "/general")).toBe(false);
    approvals.approve(theme, "/general");
    approvals.clear();
    expect(approvals.has(theme, "/general")).toBe(false);
  });
});
