// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { cn } from "../src/schema-form/cn.ts";

describe("cn", () => {
  it("joins truthy class names with a single space", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("skips falsy values (false, null, undefined, empty string)", () => {
    expect(cn("a", false, "b", null, "c", undefined, "", "d")).toBe("a b c d");
  });

  it("returns an empty string when no truthy input", () => {
    expect(cn(false, null, undefined, "")).toBe("");
  });

  it("does not deduplicate or merge conflicting Tailwind classes", () => {
    // Documented invariant: templates must not produce conflicting classes.
    // If this ever needs to change, swap cn for tailwind-merge.
    expect(cn("p-2", "p-4")).toBe("p-2 p-4");
  });
});
