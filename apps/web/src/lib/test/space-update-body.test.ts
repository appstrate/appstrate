// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  domainsChanged,
  spaceSettingsUpdate,
  visibilityChangeNeedsConfirmation,
} from "../space-update-body.ts";

describe("domainsChanged", () => {
  it("is false for a field left untouched, an added empty row included", () => {
    expect(domainsChanged(["a.com"], ["a.com"])).toBe(false);
    expect(domainsChanged(["a.com"], ["a.com", ""])).toBe(false);
    expect(domainsChanged(["a.com"], [" a.com "])).toBe(false);
  });

  it("is true for an edit, an addition or a removal", () => {
    expect(domainsChanged(["a.com"], ["b.com"])).toBe(true);
    expect(domainsChanged(["a.com"], ["a.com", "b.com"])).toBe(true);
    expect(domainsChanged(["a.com", "b.com"], ["b.com"])).toBe(true);
  });
});

describe("visibilityChangeNeedsConfirmation", () => {
  it("asks before an open space closes, and only then", () => {
    expect(visibilityChangeNeedsConfirmation("open", "closed")).toBe(true);
    expect(visibilityChangeNeedsConfirmation("open", "private")).toBe(true);
    expect(visibilityChangeNeedsConfirmation("closed", "private")).toBe(false);
    expect(visibilityChangeNeedsConfirmation("private", "open")).toBe(false);
  });
});

describe("spaceSettingsUpdate", () => {
  const baseline = {
    name: "Before",
    domains: ["old.test"],
    visibility: "open" as const,
    defaultRole: "viewer" as const,
  };
  it("renames with the trimmed name alone, so a personal space accepts it", () => {
    // `visibility` or `default_role` in the body is a 409 `personal_space_immutable`
    // on a personal space, whatever their value.
    expect(spaceSettingsUpdate(baseline, { ...baseline, name: "  After  " })).toEqual({
      name: "After",
    });
  });
  it("combines the edited fields, the domain list without the empty rows of editing", () => {
    const next = {
      ...baseline,
      name: "After",
      visibility: "private" as const,
      defaultRole: "operator" as const,
      domains: [" new.test ", "", "  "],
    };
    expect(spaceSettingsUpdate(baseline, next)).toEqual({
      name: "After",
      visibility: "private",
      default_role: "operator",
      settings: { allowedRedirectDomains: ["new.test"] },
    });
  });
  it("sends nothing for an added empty domain row", () => {
    expect(spaceSettingsUpdate(baseline, { ...baseline, domains: ["old.test", ""] })).toEqual({});
  });
});
