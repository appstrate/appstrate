// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { ORG_ROLES, type OrgRole } from "@appstrate/core/permissions";
import {
  ASSIGNABLE_ORG_ROLES,
  assignableRolesForMember,
  canLeaveOrg,
  canRemoveMember,
} from "../src/index.ts";

const ALL = ORG_ROLES;
const NON_OWNER = ASSIGNABLE_ORG_ROLES;

// actor × target, isSelf = false. Owner manages everyone (owners included);
// admin manages guests and members only; member and guest manage nobody.
const MANAGEMENT_TABLE: ReadonlyArray<readonly [OrgRole, OrgRole, boolean]> = [
  ["owner", "owner", true],
  ["owner", "admin", true],
  ["owner", "member", true],
  ["owner", "guest", true],
  ["admin", "owner", false],
  ["admin", "admin", false],
  ["admin", "member", true],
  ["admin", "guest", true],
  ["member", "owner", false],
  ["member", "admin", false],
  ["member", "member", false],
  ["member", "guest", false],
  ["guest", "owner", false],
  ["guest", "admin", false],
  ["guest", "member", false],
  ["guest", "guest", false],
];

describe("member management policy", () => {
  it("covers every actor × target pair", () => {
    expect(MANAGEMENT_TABLE).toHaveLength(ORG_ROLES.length * ORG_ROLES.length);
  });

  it("canRemoveMember follows the hierarchy", () => {
    for (const [actorRole, targetRole, expected] of MANAGEMENT_TABLE) {
      expect({
        actorRole,
        targetRole,
        allowed: canRemoveMember({ actorRole, targetRole, isSelf: false }),
      }).toEqual({ actorRole, targetRole, allowed: expected });
    }
  });

  it("assignableRolesForMember offers owner only to an owner actor", () => {
    for (const [actorRole, targetRole, manageable] of MANAGEMENT_TABLE) {
      const expected = !manageable ? [] : actorRole === "owner" ? ALL : NON_OWNER;
      expect({
        actorRole,
        targetRole,
        roles: assignableRolesForMember({ actorRole, targetRole, isSelf: false }),
      }).toEqual({ actorRole, targetRole, roles: [...expected] });
    }
  });

  it("nobody manages themselves, whatever the roles", () => {
    for (const actorRole of ORG_ROLES) {
      for (const targetRole of ORG_ROLES) {
        expect(canRemoveMember({ actorRole, targetRole, isSelf: true })).toBe(false);
        expect(assignableRolesForMember({ actorRole, targetRole, isSelf: true })).toEqual([]);
      }
    }
  });

  it("keeps owner out of the invitation / signup roles", () => {
    expect(ASSIGNABLE_ORG_ROLES as readonly string[]).not.toContain("owner");
  });
});

describe("canLeaveOrg", () => {
  it("lets any non-owner leave", () => {
    for (const role of NON_OWNER) {
      expect(canLeaveOrg({ role, ownerCount: 1 })).toBe(true);
    }
  });

  it("refuses the last owner and lets an owner with a co-owner leave", () => {
    expect(canLeaveOrg({ role: "owner", ownerCount: 1 })).toBe(false);
    expect(canLeaveOrg({ role: "owner", ownerCount: 2 })).toBe(true);
  });
});
