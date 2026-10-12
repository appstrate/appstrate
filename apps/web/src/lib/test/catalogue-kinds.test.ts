// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue's kinds are the ones the caller may activate in the space they stand in,
 * by the same verdict as every activation control, the owner of a personal space included.
 */

import { describe, it, expect } from "bun:test";
import { spacePackagePermission } from "@appstrate/core/permissions";
import { catalogueKinds, type SpaceGrant } from "../package-permissions.ts";

function grant(overrides: Partial<SpaceGrant> = {}): SpaceGrant {
  return { permissions: [], personal: false, access: "member", ...overrides };
}

describe("catalogueKinds", () => {
  it("is empty while the space list has not resolved", () => {
    expect(catalogueKinds(undefined)).toEqual([]);
  });

  it("offers the kinds the space grants activation for", () => {
    const space = grant({
      permissions: [
        spacePackagePermission("agent", "activate"),
        spacePackagePermission("skill", "activate"),
      ],
    });
    expect(catalogueKinds(space)).toEqual(["agent", "skill"]);
  });

  it("offers nothing to a team space that grants no activation", () => {
    expect(catalogueKinds(grant({ permissions: ["agents:read"] }))).toEqual([]);
  });

  // RBAC spec §3.6: a guest holds no activation grant in their own personal space and the
  // server lets them activate anyway, so the catalogue must open for them.
  it("offers every kind to the owner of a personal space, grants or none", () => {
    expect(catalogueKinds(grant({ personal: true }))).toEqual([
      "agent",
      "skill",
      "mcp-server",
      "integration",
    ]);
  });

  it("does not open a personal space the caller does not own", () => {
    expect(catalogueKinds(grant({ personal: true, access: "none" }))).toEqual([]);
  });
});
