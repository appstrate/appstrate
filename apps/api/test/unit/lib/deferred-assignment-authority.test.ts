// SPDX-License-Identifier: Apache-2.0

/**
 * RBAC spec §6.4 — the deferred space assignments.
 *
 * An org invitation and an OAuth-signup policy both carry `space_assignments`
 * that are applied LATER, with no actor present and no request to read a
 * credential ceiling from (`services/space-assignments.ts`). They are therefore
 * validated for org ownership and role shape only — not against the actor's
 * effective set in each space, the way a direct `POST /api/spaces/:id/members`
 * is.
 *
 * What makes that safe is not the assignment code: it is who can reach it.
 * `members:invite` and `members:change-role` are org-level and belong to
 * `owner` and `admin`, and `resolveSpaceRole` hands those two the `admin`
 * preset in EVERY space — so the subset check the deferred path skips would be
 * vacuous for the only principals that can trigger it.
 *
 * Grant either string to `member` or `guest` and that stops being true
 * silently: the paragraph in the spec would still read correctly and the
 * deferred path would start accepting assignments its actor cannot make. This
 * refuses the grant instead.
 */

import { describe, expect, it } from "bun:test";
import { ORG_ROLES, ORG_ROLES_WITH_FULL_ACCESS } from "@appstrate/core/permissions";
import { orgPermissions } from "../../../src/lib/permissions.ts";

/** The two permissions that let a principal author a deferred assignment. */
const DEFERRING_PERMISSIONS = ["members:invite", "members:change-role"] as const;

describe("deferred space assignments — who can author one", () => {
  it("grants members:invite / members:change-role only to the full-access org roles", () => {
    const holders = ORG_ROLES.filter((role) => {
      const granted = orgPermissions(role);
      return DEFERRING_PERMISSIONS.some((permission) => granted.has(permission));
    });

    // Positive control: nobody holding them would pass the assertion vacuously
    // while meaning the catalogue had lost the permissions entirely.
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
