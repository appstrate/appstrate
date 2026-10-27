// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { timezoneOptions } from "../timezones.ts";

describe("timezoneOptions", () => {
  it("offers UTC first, once", () => {
    const zones = timezoneOptions();
    expect(zones[0]).toBe("UTC");
    expect(zones.filter((z) => z === "UTC")).toHaveLength(1);
  });

  it("keeps a stored zone the browser does not know, so the select is never empty", () => {
    expect(timezoneOptions("Mars/Olympus_Mons")).toContain("Mars/Olympus_Mons");
    expect(timezoneOptions()).not.toContain("Mars/Olympus_Mons");
  });

  it("does not list a known zone twice", () => {
    expect(timezoneOptions("UTC")).toEqual(timezoneOptions());
  });
});
