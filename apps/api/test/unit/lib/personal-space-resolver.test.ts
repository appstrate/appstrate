// SPDX-License-Identifier: Apache-2.0

/**
 * `resolveSpaceRole` on a PERSONAL space (RBAC spec §3.6).
 *
 * The whole guarantee of the feature is one branch taken BEFORE the org role,
 * so this is the truth table for it — and the negative rows are the point: an
 * organization owner, an admin, another member and every credential without a
 * user behind it must all get `null`, which every caller renders as 404.
 */

import { describe, it, expect } from "bun:test";
import { presetPermissions } from "../../../src/lib/permissions.ts";
import {
  PERSONAL_CAP_DELETE_PERMISSIONS,
  resolveSpaceRole,
  spacePermissions,
  type SpaceAccessRow,
} from "../../../src/lib/space-role.ts";

const OWNER = "usr_owner";
const OTHER = "usr_other";

const personal: SpaceAccessRow = {
  id: "spc_11111111-1111-4111-8111-111111111111",
  visibility: "private",
  defaultRole: "operator",
  ownerUserId: OWNER,
};

const team: SpaceAccessRow = {
  id: "spc_22222222-2222-4222-8222-222222222222",
  visibility: "open",
  defaultRole: "operator",
  ownerUserId: null,
};

describe("resolveSpaceRole on a personal space", () => {
  it("gives its owner preset admin when they are an owner, admin or member", () => {
    for (const orgRole of ["owner", "admin", "member"] as const) {
      expect(resolveSpaceRole(orgRole, personal, null, OWNER, "admin")).toEqual({
        kind: "preset",
        preset: "admin",
      });
    }
  });

  it("grants its owner exactly what `admin` holds, the credential proxy included", () => {
    const admin = presetPermissions("admin");
    for (const orgRole of ["owner", "member"] as const) {
      const owned = spacePermissions(resolveSpaceRole(orgRole, personal, null, OWNER, "admin"));
      expect([...owned].sort(), orgRole).toEqual([...admin].sort());
      expect(owned.has("credential-proxy:call")).toBe(true);
      expect(owned.has("credential-proxy:call-own")).toBe(true);
    }
  });

  it("gives a GUEST owner preset operator — receive and run, never author", () => {
    // A guest is an external identity invited to use one thing (§3.2). `admin`
    // in their own space would let them author and launch arbitrary agents on
    // the organization's LLM budget, which is what their org role withholds.
    expect(resolveSpaceRole("guest", personal, null, OWNER, "admin")).toEqual({
      kind: "preset",
      preset: "operator",
    });
  });

  it("holds the guest carve-out to the WRITE half: they still read and run", () => {
    // The preset is the contract, so this is the claim in terms of permissions:
    // an operator reads and launches agents and holds no `agents:write`.
    const guest = spacePermissions(resolveSpaceRole("guest", personal, null, OWNER, "admin"));
    expect(guest.has("agents:run")).toBe(true);
    expect(guest.has("agents:read")).toBe(true);
    expect(guest.has("agents:write")).toBe(false);
    expect(guest.has("skills:write")).toBe(false);
    const member = spacePermissions(resolveSpaceRole("member", personal, null, OWNER, "admin"));
    expect(member.has("agents:write")).toBe(true);
  });

  it("gives an organization owner or admin who is not the owner nothing", () => {
    expect(resolveSpaceRole("owner", personal, null, OTHER, "admin")).toBeNull();
    expect(resolveSpaceRole("admin", personal, null, OTHER, "admin")).toBeNull();
  });

  it("gives another member nothing", () => {
    expect(resolveSpaceRole("member", personal, null, OTHER, "admin")).toBeNull();
    expect(resolveSpaceRole("guest", personal, null, OTHER, "admin")).toBeNull();
  });

  it("gives a principal with no user behind it nothing — API key, end-user, preview", () => {
    expect(resolveSpaceRole("owner", personal, null, null, "admin")).toBeNull();
    expect(resolveSpaceRole("member", personal, null, null, "admin")).toBeNull();
  });

  it("ignores an explicit membership row: the column decides, not the row", () => {
    // Such a row cannot be written (409 `personal_space_has_no_members`), and
    // if one were seeded by hand it must still grant nothing — the branch runs
    // before `memberRow` is even looked at.
    const row = { ref: { kind: "preset", preset: "admin" } } as const;
    expect(resolveSpaceRole("member", personal, row, OTHER, "admin")).toBeNull();
  });

  it("leaves a team space to the rules it always had", () => {
    expect(resolveSpaceRole("admin", team, null, OTHER, "admin")).toEqual({
      kind: "preset",
      preset: "admin",
    });
    expect(resolveSpaceRole("member", team, null, OTHER, "admin")).toEqual({
      kind: "preset",
      preset: "operator",
    });
    expect(resolveSpaceRole("guest", team, null, OTHER, "admin")).toBeNull();
    // The caller id is irrelevant on a team space, which is what lets the SSE
    // and scheduler call sites pass whichever id they hold.
    expect(resolveSpaceRole("member", team, null, null, "admin")).toEqual({
      kind: "preset",
      preset: "operator",
    });
  });
});

describe("resolveSpaceRole under personal_space_role: operator", () => {
  it("gives a MEMBER owner operator plus exactly the four delete permissions", () => {
    const ref = resolveSpaceRole("member", personal, null, OWNER, "operator");
    expect(ref).toEqual({
      kind: "preset",
      preset: "operator",
      plus: ["agents:delete", "skills:delete", "integrations:delete", "schedules:delete"],
    });
    expect(PERSONAL_CAP_DELETE_PERMISSIONS).toEqual(
      expect.arrayContaining(["agents:delete", "skills:delete"]),
    );
    const held = spacePermissions(ref);
    const expected = new Set([
      ...presetPermissions("operator"),
      ...PERSONAL_CAP_DELETE_PERMISSIONS,
    ]);
    expect([...held].sort()).toEqual([...expected].sort());
    expect(held.has("agents:write")).toBe(false);
    expect(held.has("agents:run")).toBe(true);
    expect(held.has("spaces:write")).toBe(false);
  });

  it("keeps an owner or admin at admin", () => {
    for (const orgRole of ["owner", "admin"] as const) {
      expect(resolveSpaceRole(orgRole, personal, null, OWNER, "operator")).toEqual({
        kind: "preset",
        preset: "admin",
      });
    }
  });

  it("leaves a guest at plain operator, with no delete permissions", () => {
    expect(resolveSpaceRole("guest", personal, null, OWNER, "operator")).toEqual({
      kind: "preset",
      preset: "operator",
    });
  });

  it("changes nothing for another member, and nothing on a team space", () => {
    expect(resolveSpaceRole("member", personal, null, OTHER, "operator")).toBeNull();
    expect(resolveSpaceRole("member", team, null, OTHER, "operator")).toEqual({
      kind: "preset",
      preset: "operator",
    });
  });

  it("is the unchanged admin when the setting is admin", () => {
    expect(resolveSpaceRole("member", personal, null, OWNER, "admin")).toEqual({
      kind: "preset",
      preset: "admin",
    });
  });
});
