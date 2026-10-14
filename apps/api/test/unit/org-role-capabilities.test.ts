// SPDX-License-Identifier: Apache-2.0

/**
 * The roles page's capability table (`apps/web/src/lib/org-role-capabilities.ts`)
 * pinned to the org-role grants the API enforces: a role listed under a
 * capability holds every permission it stands for, and every role that does
 * is listed.
 */

import { describe, it, expect } from "bun:test";
import { ORG_LEVEL_PERMISSIONS, ORG_ROLES } from "@appstrate/core/permissions";
import { orgPermissions } from "../../src/lib/permissions.ts";
import { ORG_ROLE_CAPABILITIES } from "../../../web/src/lib/org-role-capabilities.ts";

describe("ORG_ROLE_CAPABILITIES", () => {
  it("names org-level permissions only", () => {
    const unknown = ORG_ROLE_CAPABILITIES.flatMap((capability) =>
      capability.permissions.filter((permission) => !ORG_LEVEL_PERMISSIONS.has(permission)),
    );
    expect(unknown).toEqual([]);
  });

  for (const capability of ORG_ROLE_CAPABILITIES) {
    it(`lists exactly the roles holding "${capability.key}"`, () => {
      const holders = ORG_ROLES.filter((role) => {
        const granted = orgPermissions(role);
        return capability.permissions.every((permission) => granted.has(permission));
      });
      expect([...capability.roles].sort()).toEqual([...holders].sort());
    });
  }
});
