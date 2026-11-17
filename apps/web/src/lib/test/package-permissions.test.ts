// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { maySetPackageActive, type SpaceGrant } from "../package-permissions.ts";

function grant(overrides: Partial<SpaceGrant> = {}): SpaceGrant {
  return { permissions: [], personal: false, access: "member", ...overrides };
}

describe("maySetPackageActive", () => {
  it("is false while the space list has not resolved", () => {
    expect(maySetPackageActive(undefined, "skill", true)).toBe(false);
  });

  it("asks for the type's activation grant in the space", () => {
    expect(maySetPackageActive(grant({ permissions: ["skills:write"] }), "skill", true)).toBe(true);
    expect(maySetPackageActive(grant({ permissions: ["skills:read"] }), "skill", true)).toBe(false);
  });

  // The server waives the grant for the owner of a personal space (`gateSpacePackageWrite`).
  it("lets the owner of a personal space switch without the grant", () => {
    expect(maySetPackageActive(grant({ personal: true }), "skill", true)).toBe(true);
    expect(maySetPackageActive(grant({ personal: true }), "skill", false)).toBe(true);
    expect(maySetPackageActive(grant({ personal: true, access: "none" }), "skill", true)).toBe(
      false,
    );
  });
});
