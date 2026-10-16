// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  domainsChanged,
  spaceUpdateBody,
  spaceSettingsUpdate,
  visibilityChangeNeedsConfirmation,
} from "../space-update-body.ts";

describe("spaceUpdateBody", () => {
  it("renames with the name alone, so a personal space accepts it", () => {
    // `visibility` or `default_role` in the body is a 409 `personal_space_immutable`
    // on a personal space, whatever their value.
    expect(spaceUpdateBody({ field: "name", value: "  Mon espace  " })).toEqual({
      name: "Mon espace",
    });
  });

  it("sends each access setting on its own", () => {
    expect(spaceUpdateBody({ field: "visibility", value: "closed" })).toEqual({
      visibility: "closed",
    });
    expect(spaceUpdateBody({ field: "defaultRole", value: "operator" })).toEqual({
      default_role: "operator",
    });
  });

  it("sends the domain list without the empty rows of editing", () => {
    expect(spaceUpdateBody({ field: "domains", value: [" a.com ", "", "  "] })).toEqual({
      settings: { allowedRedirectDomains: ["a.com"] },
    });
  });
});

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

describe("manual space settings patch", () => {
  const baseline = {
    name: "Before",
    domains: ["old.test"],
    visibility: "open" as const,
    defaultRole: "viewer" as const,
  };
  it("sends only the edited name, preserving a concurrent closure and domain/role changes", () => {
    expect(spaceSettingsUpdate(baseline, { ...baseline, name: "After" }, false)).toEqual({
      name: "After",
    });
  });
  it("combines explicitly edited fields and never includes personal-space policy fields", () => {
    const next = {
      ...baseline,
      name: "After",
      visibility: "private" as const,
      domains: ["new.test"],
    };
    expect(spaceSettingsUpdate(baseline, next, false)).toEqual({
      name: "After",
      visibility: "private",
      settings: { allowedRedirectDomains: ["new.test"] },
    });
    expect(spaceSettingsUpdate(baseline, next, true)).toEqual({
      name: "After",
      settings: { allowedRedirectDomains: ["new.test"] },
    });
  });
});
