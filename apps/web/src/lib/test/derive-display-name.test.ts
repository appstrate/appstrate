// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `deriveDisplayNameFromEmail` — used by RegisterPage to
 * pre-fill the display-name field from the locked bootstrap email
 * (issue #228), so the closed-mode operator only types a password.
 */

import { describe, it, expect } from "bun:test";
import { deriveDisplayNameFromEmail } from "../derive-display-name";

describe("deriveDisplayNameFromEmail", () => {
  it("capitalizes a single-segment local part", () => {
    expect(deriveDisplayNameFromEmail("admin@acme.com")).toBe("Admin");
  });

  it("splits on `.` and capitalizes each segment", () => {
    expect(deriveDisplayNameFromEmail("john.doe@acme.com")).toBe("John Doe");
  });

  it("splits on `_` and capitalizes each segment", () => {
    expect(deriveDisplayNameFromEmail("jane_smith@acme.com")).toBe("Jane Smith");
  });

  it("splits on `-` and capitalizes each segment", () => {
    expect(deriveDisplayNameFromEmail("anna-marie@acme.com")).toBe("Anna Marie");
  });

  it("drops plus-addressing", () => {
    expect(deriveDisplayNameFromEmail("admin+ops@acme.com")).toBe("Admin");
    expect(deriveDisplayNameFromEmail("john.doe+test@acme.com")).toBe("John Doe");
  });

  it("normalizes mixed case to Capitalized", () => {
    expect(deriveDisplayNameFromEmail("JOHN.DOE@acme.com")).toBe("John Doe");
    expect(deriveDisplayNameFromEmail("jOhN.dOe@acme.com")).toBe("John Doe");
  });

  it("collapses repeated separators", () => {
    expect(deriveDisplayNameFromEmail("john..doe@acme.com")).toBe("John Doe");
    expect(deriveDisplayNameFromEmail("john__doe@acme.com")).toBe("John Doe");
  });

  it("returns empty string for malformed input (no @)", () => {
    expect(deriveDisplayNameFromEmail("not-an-email")).toBe("");
  });

  it("returns empty string when local part is empty (leading @)", () => {
    expect(deriveDisplayNameFromEmail("@acme.com")).toBe("");
  });

  it("returns empty string for numeric-only local parts (meaningless as a name)", () => {
    expect(deriveDisplayNameFromEmail("42@acme.com")).toBe("");
    expect(deriveDisplayNameFromEmail("12345@acme.com")).toBe("");
  });

  it("handles empty input safely", () => {
    expect(deriveDisplayNameFromEmail("")).toBe("");
  });
});
