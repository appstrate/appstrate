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
import { presetPermissions, type Permission } from "../../../src/lib/permissions.ts";
import {
  ADMIN_ROLE_REF,
  overrideSurvivesRoleChange,
  PERSONAL_CAP_DELETE_PERMISSIONS,
  personalSpaceDefaultRef,
  resolveSpaceRole,
  spacePermissions,
  type SpaceAccessRow,
  type SpaceRoleRef,
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

const preset = (name: "admin" | "builder" | "operator" | "runner" | "viewer"): SpaceRoleRef => ({
  kind: "preset",
  preset: name,
});

const CUSTOM: SpaceRoleRef = {
  kind: "custom",
  role: {
    id: "srl_33333333-3333-4333-8333-333333333333",
    key: "reader",
    name: "Reader",
    permissions: ["agents:read", "runs:read"],
  },
};

const FLOOR: Permission[] = [
  "agents:delete",
  "skills:delete",
  "integrations:delete",
  "schedules:delete",
];

describe("resolveSpaceRole on a personal space", () => {
  it("gives its owner preset admin when they are an owner, admin or member", () => {
    for (const orgRole of ["owner", "admin", "member"] as const) {
      expect(resolveSpaceRole(orgRole, personal, null, OWNER, ADMIN_ROLE_REF)).toEqual({
        kind: "preset",
        preset: "admin",
      });
    }
  });

  it("grants its owner exactly what `admin` holds, the credential proxy included", () => {
    const admin = presetPermissions("admin");
    for (const orgRole of ["owner", "member"] as const) {
      const owned = spacePermissions(
        resolveSpaceRole(orgRole, personal, null, OWNER, ADMIN_ROLE_REF),
      );
      expect([...owned].sort(), orgRole).toEqual([...admin].sort());
      expect(owned.has("credential-proxy:call")).toBe(true);
      expect(owned.has("credential-proxy:call-own")).toBe(true);
    }
  });

  it("gives a GUEST owner preset operator under the admin default — receive and run, never author", () => {
    // A guest is an external identity invited to use one thing (§3.2). `admin`
    // in their own space would let them author and launch arbitrary agents on
    // the organization's LLM budget, which is what their org role withholds.
    expect(resolveSpaceRole("guest", personal, null, OWNER, ADMIN_ROLE_REF)).toEqual({
      kind: "preset",
      preset: "operator",
    });
  });

  it("holds the guest carve-out to the WRITE half: they still read and run", () => {
    const guest = spacePermissions(
      resolveSpaceRole("guest", personal, null, OWNER, ADMIN_ROLE_REF),
    );
    expect(guest.has("agents:run")).toBe(true);
    expect(guest.has("agents:read")).toBe(true);
    expect(guest.has("agents:write")).toBe(false);
    expect(guest.has("skills:write")).toBe(false);
    const member = spacePermissions(
      resolveSpaceRole("member", personal, null, OWNER, ADMIN_ROLE_REF),
    );
    expect(member.has("agents:write")).toBe(true);
  });

  it("gives an organization owner or admin who is not the owner nothing", () => {
    expect(resolveSpaceRole("owner", personal, null, OTHER, ADMIN_ROLE_REF)).toBeNull();
    expect(resolveSpaceRole("admin", personal, null, OTHER, ADMIN_ROLE_REF)).toBeNull();
  });

  it("gives another member nothing", () => {
    expect(resolveSpaceRole("member", personal, null, OTHER, ADMIN_ROLE_REF)).toBeNull();
    expect(resolveSpaceRole("guest", personal, null, OTHER, ADMIN_ROLE_REF)).toBeNull();
  });

  it("gives a principal with no user behind it nothing — API key, end-user, preview", () => {
    expect(resolveSpaceRole("owner", personal, null, null, ADMIN_ROLE_REF)).toBeNull();
    expect(resolveSpaceRole("member", personal, null, null, ADMIN_ROLE_REF)).toBeNull();
  });

  it("gives another member nothing even with a row naming them: the column decides first", () => {
    const row = { ref: preset("admin") } as const;
    expect(resolveSpaceRole("member", personal, row, OTHER, ADMIN_ROLE_REF)).toBeNull();
  });

  it("leaves a team space to the rules it always had", () => {
    expect(resolveSpaceRole("admin", team, null, OTHER, ADMIN_ROLE_REF)).toEqual(preset("admin"));
    expect(resolveSpaceRole("member", team, null, OTHER, ADMIN_ROLE_REF)).toEqual(
      preset("operator"),
    );
    expect(resolveSpaceRole("guest", team, null, OTHER, ADMIN_ROLE_REF)).toBeNull();
    // The caller id is irrelevant on a team space, which is what lets the SSE
    // and scheduler call sites pass whichever id they hold.
    expect(resolveSpaceRole("member", team, null, null, ADMIN_ROLE_REF)).toEqual(
      preset("operator"),
    );
    // Nor does the personal-space default reach a team space.
    expect(resolveSpaceRole("member", team, null, OTHER, preset("viewer"))).toEqual(
      preset("operator"),
    );
  });
});

describe("resolveSpaceRole under an org default other than admin", () => {
  it("gives a MEMBER owner operator plus exactly the four delete permissions", () => {
    const ref = resolveSpaceRole("member", personal, null, OWNER, preset("operator"));
    expect(ref).toEqual({ kind: "preset", preset: "operator", plus: FLOOR });
    expect([...PERSONAL_CAP_DELETE_PERMISSIONS]).toEqual(FLOOR);
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

  it("carries the floor on every preset short of admin", () => {
    for (const name of ["builder", "runner", "viewer"] as const) {
      const ref = resolveSpaceRole("member", personal, null, OWNER, preset(name));
      expect(ref, name).toEqual({ kind: "preset", preset: name, plus: FLOOR });
      const held = spacePermissions(ref);
      for (const permission of [...presetPermissions(name), ...FLOOR]) {
        expect(held.has(permission), `${name} ${permission}`).toBe(true);
      }
    }
  });

  it("gives a custom default its own permissions plus the floor, nothing else", () => {
    const ref = resolveSpaceRole("member", personal, null, OWNER, CUSTOM);
    expect(ref).toEqual({ ...CUSTOM, plus: FLOOR });
    expect<string[]>([...spacePermissions(ref)].sort()).toEqual(
      ["agents:read", "runs:read", ...FLOOR].sort(),
    );
  });

  it("keeps an owner or admin at admin", () => {
    for (const orgRole of ["owner", "admin"] as const) {
      for (const fallback of [preset("operator"), CUSTOM]) {
        expect(resolveSpaceRole(orgRole, personal, null, OWNER, fallback)).toEqual(preset("admin"));
      }
    }
  });

  it("caps a guest to plain operator, no deletes, under a default that lets them author", () => {
    const authoring: SpaceRoleRef = {
      kind: "custom",
      role: {
        id: "srl_55555555-5555-4555-8555-555555555555",
        key: "author",
        name: "Author",
        permissions: ["agents:read", "agents:write"],
      },
    };
    for (const fallback of [ADMIN_ROLE_REF, preset("builder"), authoring]) {
      expect(resolveSpaceRole("guest", personal, null, OWNER, fallback)).toEqual(
        preset("operator"),
      );
    }
    // A member takes the authoring custom default with the floor.
    expect(resolveSpaceRole("member", personal, null, OWNER, authoring)).toEqual({
      ...authoring,
      plus: FLOOR,
    });
  });

  it("gives a guest any default that does not author, plus the floor, like a member", () => {
    for (const fallback of [preset("operator"), preset("runner"), preset("viewer"), CUSTOM]) {
      const expected = { ...fallback, plus: FLOOR };
      expect(resolveSpaceRole("guest", personal, null, OWNER, fallback)).toEqual(expected);
      expect(resolveSpaceRole("member", personal, null, OWNER, fallback)).toEqual(expected);
    }
  });

  it("changes nothing for another member, and nothing on a team space", () => {
    expect(resolveSpaceRole("member", personal, null, OTHER, preset("operator"))).toBeNull();
    expect(resolveSpaceRole("member", team, null, OTHER, preset("operator"))).toEqual(
      preset("operator"),
    );
  });
});

describe("resolveSpaceRole with the owner's own override row", () => {
  it("lets a member's row win over the org default, with the floor", () => {
    expect(
      resolveSpaceRole("member", personal, { ref: preset("viewer") }, OWNER, ADMIN_ROLE_REF),
    ).toEqual({ kind: "preset", preset: "viewer", plus: FLOOR });
    expect(
      resolveSpaceRole("member", personal, { ref: preset("builder") }, OWNER, preset("operator")),
    ).toEqual({ kind: "preset", preset: "builder", plus: FLOOR });
    expect(resolveSpaceRole("member", personal, { ref: CUSTOM }, OWNER, ADMIN_ROLE_REF)).toEqual({
      ...CUSTOM,
      plus: FLOOR,
    });
  });

  it("lifts a member to admin through an admin row, without a floor", () => {
    expect(
      resolveSpaceRole("member", personal, { ref: preset("admin") }, OWNER, preset("viewer")),
    ).toEqual(preset("admin"));
  });

  it("lets a guest's row win over the guest operator, with the floor", () => {
    expect(
      resolveSpaceRole("guest", personal, { ref: preset("builder") }, OWNER, ADMIN_ROLE_REF),
    ).toEqual({ kind: "preset", preset: "builder", plus: FLOOR });
  });

  it("ignores a row for an owner or admin, who always hold admin", () => {
    for (const orgRole of ["owner", "admin"] as const) {
      expect(
        resolveSpaceRole(orgRole, personal, { ref: preset("viewer") }, OWNER, ADMIN_ROLE_REF),
      ).toEqual(preset("admin"));
    }
  });
});

describe("personalSpaceDefaultRef", () => {
  const stored = (value: string | null, custom: unknown = null) =>
    personalSpaceDefaultRef({ storedPersonalSpaceRole: value, personalSpaceCustomRole: custom });

  it("reads an absent setting as admin and a preset key as that preset", () => {
    expect(stored(null)).toEqual(ADMIN_ROLE_REF);
    for (const name of ["admin", "builder", "operator", "runner", "viewer"] as const) {
      expect(stored(name)).toEqual(preset(name));
    }
  });

  it("reads a custom id as the role the same statement resolved", () => {
    if (CUSTOM.kind !== "custom") throw new Error("unreachable");
    expect(stored(CUSTOM.role.id, CUSTOM.role)).toEqual(CUSTOM);
  });

  it("fails closed to no role on a dangling id or a stray value, never a preset", () => {
    if (CUSTOM.kind !== "custom") throw new Error("unreachable");
    expect(stored(CUSTOM.role.id, null)).toBeNull();
    expect(stored("superuser")).toBeNull();
    // No preset in its place: every preset holds `studio:read`, which the setting may withhold.
    expect(presetPermissions("viewer").has("studio:read")).toBe(true);
    // An owner without an override then holds nothing in their own space, a member or a guest…
    for (const orgRole of ["member", "guest"] as const) {
      expect(resolveSpaceRole(orgRole, personal, null, OWNER, stored(CUSTOM.role.id))).toBeNull();
    }
    // …while an override still answers first, and an owner or admin still holds admin.
    expect(
      resolveSpaceRole("member", personal, { ref: preset("runner") }, OWNER, stored("superuser")),
    ).toEqual({ kind: "preset", preset: "runner", plus: FLOOR });
    expect(resolveSpaceRole("admin", personal, null, OWNER, stored("superuser"))).toEqual(
      ADMIN_ROLE_REF,
    );
  });
});

describe("overrideSurvivesRoleChange", () => {
  it("keeps a restriction across member ↔ guest", () => {
    // Guest under the admin default: plain operator; viewer reads less, so it stays.
    expect(overrideSurvivesRoleChange(preset("viewer"), "guest", ADMIN_ROLE_REF)).toBe(true);
    expect(overrideSurvivesRoleChange(preset("operator"), "guest", ADMIN_ROLE_REF)).toBe(true);
    expect(overrideSurvivesRoleChange(CUSTOM, "guest", ADMIN_ROLE_REF)).toBe(true);
    expect(overrideSurvivesRoleChange(preset("viewer"), "member", ADMIN_ROLE_REF)).toBe(true);
    expect(overrideSurvivesRoleChange(preset("runner"), "member", preset("operator"))).toBe(true);
  });

  it("drops an override that would widen the new role", () => {
    // A guest never authors agents in their own space by default: builder goes.
    expect(overrideSurvivesRoleChange(preset("builder"), "guest", ADMIN_ROLE_REF)).toBe(false);
    expect(overrideSurvivesRoleChange(preset("admin"), "guest", preset("viewer"))).toBe(false);
    // A member under a narrow default: an override broader than it goes.
    expect(overrideSurvivesRoleChange(preset("operator"), "member", preset("viewer"))).toBe(false);
  });

  it("drops every override on a promotion to owner or admin", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(overrideSurvivesRoleChange(preset("viewer"), role, ADMIN_ROLE_REF)).toBe(false);
    }
  });

  it("drops it when the default names no role: nothing is known to hold it", () => {
    expect(overrideSurvivesRoleChange(preset("viewer"), "member", null)).toBe(false);
  });
});
