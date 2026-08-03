// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { assignableRolesForMember, canRemoveMember } from "../src/index.ts";

describe("assignableRolesForMember", () => {
  it("lets an admin promote a member to admin", () => {
    expect(
      assignableRolesForMember({
        actorRole: "admin",
        targetRole: "member",
        isSelf: false,
      }),
    ).toEqual(["viewer", "member", "admin"]);
  });

  it("lets an owner change another admin's role", () => {
    expect(
      assignableRolesForMember({
        actorRole: "owner",
        targetRole: "admin",
        isSelf: false,
      }),
    ).toEqual(["viewer", "member", "admin"]);
  });

  it("enforces the complete actor-target hierarchy", () => {
    const cases = [
      ["owner", "viewer", false, ["viewer", "member", "admin"]],
      ["owner", "member", false, ["viewer", "member", "admin"]],
      ["admin", "viewer", false, ["viewer", "member", "admin"]],
      ["admin", "admin", false, []],
      ["admin", "owner", false, []],
      ["member", "viewer", false, []],
      ["viewer", "member", false, []],
      ["owner", "owner", true, []],
      ["admin", "admin", true, []],
    ] as const;

    for (const [actorRole, targetRole, isSelf, expected] of cases) {
      expect(assignableRolesForMember({ actorRole, targetRole, isSelf })).toEqual(expected);
    }
  });
});

describe("canRemoveMember", () => {
  it("lets an admin remove regular members but not peer admins", () => {
    expect(canRemoveMember({ actorRole: "admin", targetRole: "member", isSelf: false })).toBe(true);
    expect(canRemoveMember({ actorRole: "admin", targetRole: "admin", isSelf: false })).toBe(false);
  });

  it("enforces the complete removal hierarchy", () => {
    const cases = [
      ["owner", "admin", false, true],
      ["owner", "member", false, true],
      ["admin", "viewer", false, true],
      ["admin", "admin", false, false],
      ["admin", "owner", false, false],
      ["member", "viewer", false, false],
      ["owner", "owner", true, false],
      ["admin", "admin", true, false],
    ] as const;

    for (const [actorRole, targetRole, isSelf, expected] of cases) {
      expect(canRemoveMember({ actorRole, targetRole, isSelf })).toBe(expected);
    }
  });
});
