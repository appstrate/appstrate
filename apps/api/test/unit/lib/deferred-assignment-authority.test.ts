// SPDX-License-Identifier: Apache-2.0

/**
 * RBAC spec §6.4 — deferred space assignments skip the actor-subset check; safe
 * only while `members:invite`/`members:change-role` stay on org roles that reach
 * every space as preset `admin`. This refuses a grant to `member` or `guest`.
 */

import { describe, expect, it } from "bun:test";
import { ORG_ROLES, ORG_ROLES_WITH_FULL_ACCESS } from "@appstrate/core/permissions";
import { orgPermissions } from "../../../src/lib/permissions.ts";

const DEFERRING_PERMISSIONS = ["members:invite", "members:change-role"] as const;

describe("deferred space assignments — who can author one", () => {
  it("grants members:invite / members:change-role only to the full-access org roles", () => {
    const holders = ORG_ROLES.filter((role) => {
      const granted = orgPermissions(role);
      return DEFERRING_PERMISSIONS.some((permission) => granted.has(permission));
    });

    // Positive control: an empty catalogue would satisfy the equality below.
    expect(holders.length).toBeGreaterThan(0);
    expect([...holders].sort()).toEqual([...ORG_ROLES_WITH_FULL_ACCESS].sort());
  });

  it("gives every full-access org role the admin preset in any space", async () => {
    const { resolveSpaceRole } = await import("../../../src/lib/space-role.ts");
    for (const role of ORG_ROLES_WITH_FULL_ACCESS) {
      expect(
        resolveSpaceRole(role, { id: "spc_x", visibility: "private", defaultRole: "viewer" }, null),
        `${role} must reach every space as preset admin, or the deferred path's guarantee fails`,
      ).toEqual({ kind: "preset", preset: "admin" });
    }
  });
});
