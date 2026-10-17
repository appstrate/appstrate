// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  domainsChanged,
  spaceUpdateBody,
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

  it("sends the icon and the colour each on its own, null clearing it", () => {
    expect(spaceUpdateBody({ field: "icon", value: "lucide:rocket" })).toEqual({
      icon: "lucide:rocket",
    });
    expect(spaceUpdateBody({ field: "icon", value: null })).toEqual({ icon: null });
    expect(spaceUpdateBody({ field: "color", value: "violet" })).toEqual({ color: "violet" });
    expect(spaceUpdateBody({ field: "color", value: null })).toEqual({ color: null });
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
