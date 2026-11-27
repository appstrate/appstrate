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
import type { SpaceRolePreset } from "@appstrate/core/permissions";
import { presetPermissions, type Permission } from "../../../src/lib/permissions.ts";
import {
  ADMIN_ROLE_REF,
  PERSONAL_CAP_DELETE_PERMISSIONS,
  personalSpaceDefaultRef,
  resolveSpaceRole,
  spacePermissions,
  spaceShowsStudio,
  type PersonalSpaceDefaultColumns,
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
    // Hides the Studio, so what it resolves is exactly its bundle.
    showsStudio: false,
  },
};

/** The same bundle on a role that shows the Studio, as every role created without a choice does. */
const CUSTOM_STUDIO: SpaceRoleRef = {
  kind: "custom",
  role: {
    id: "srl_44444444-4444-4444-8444-444444444444",
    key: "reader-studio",
    name: "Reader with the Studio",
    permissions: ["agents:read", "runs:read"],
    showsStudio: true,
  },
};

const FLOOR: Permission[] = [
  "agents:delete",
  "skills:delete",
  "integrations:delete",
  "schedules:delete",
];

/** The org default as the snapshot carries it: the jsonb key, or the joined custom role. */
function cols(
  stored: SpaceRolePreset | null,
  custom: SpaceRoleRef | null = null,
): PersonalSpaceDefaultColumns {
  const role = custom?.kind === "custom" ? custom.role : null;
  return {
    storedPersonalSpaceRole: stored,
    personalDefaultRoleId: role?.id ?? null,
    personalDefaultKey: role?.key ?? null,
    personalDefaultName: role?.name ?? null,
    personalDefaultPermissions: role ? [...role.permissions] : null,
    personalDefaultShowsStudio: role?.showsStudio ?? null,
  };
}
const ADMIN_DEFAULT = cols(null);
const presetDefault = (name: SpaceRolePreset) => cols(name);
const customDefault = (ref: SpaceRoleRef) => cols(null, ref);

describe("resolveSpaceRole on a personal space", () => {
  it("gives its owner preset admin when they are an owner, admin or member", () => {
    for (const orgRole of ["owner", "admin", "member"] as const) {
      expect(resolveSpaceRole(orgRole, personal, null, OWNER, ADMIN_DEFAULT)).toEqual({
        kind: "preset",
        preset: "admin",
      });
    }
  });

  it("grants its owner exactly what `admin` holds, the credential proxy included", () => {
    const admin = presetPermissions("admin");
    for (const orgRole of ["owner", "member"] as const) {
      const owned = spacePermissions(
        resolveSpaceRole(orgRole, personal, null, OWNER, ADMIN_DEFAULT),
      );
      expect([...owned].sort(), orgRole).toEqual([...admin].sort());
      expect(owned.has("credential-proxy:call")).toBe(true);
      expect(owned.has("credential-proxy:call-own")).toBe(true);
    }
  });

  it("gives a GUEST owner operator plus the floor under the admin default — use and run, never author", () => {
    // A guest is an external identity invited to use one thing (§3.2). `admin`
    // in their own space would let them author and launch arbitrary agents on
    // the organization's LLM budget, which is what their org role withholds.
    expect(resolveSpaceRole("guest", personal, null, OWNER, ADMIN_DEFAULT)).toEqual({
      kind: "preset",
      preset: "operator",
      plus: FLOOR,
    });
  });

  it("holds the guest cap to the WRITE half: they still read and run", () => {
    const guest = spacePermissions(resolveSpaceRole("guest", personal, null, OWNER, ADMIN_DEFAULT));
    expect(guest.has("agents:run")).toBe(true);
    expect(guest.has("agents:read")).toBe(true);
    expect(guest.has("agents:write")).toBe(false);
    expect(guest.has("skills:write")).toBe(false);
    const member = spacePermissions(
      resolveSpaceRole("member", personal, null, OWNER, ADMIN_DEFAULT),
    );
    expect(member.has("agents:write")).toBe(true);
  });

  it("gives an organization owner or admin who is not the owner nothing", () => {
    expect(resolveSpaceRole("owner", personal, null, OTHER, ADMIN_DEFAULT)).toBeNull();
    expect(resolveSpaceRole("admin", personal, null, OTHER, ADMIN_DEFAULT)).toBeNull();
  });

  it("gives another member nothing", () => {
    expect(resolveSpaceRole("member", personal, null, OTHER, ADMIN_DEFAULT)).toBeNull();
    expect(resolveSpaceRole("guest", personal, null, OTHER, ADMIN_DEFAULT)).toBeNull();
  });

  it("gives a principal with no user behind it nothing — API key, end-user, preview", () => {
    expect(resolveSpaceRole("owner", personal, null, null, ADMIN_DEFAULT)).toBeNull();
    expect(resolveSpaceRole("member", personal, null, null, ADMIN_DEFAULT)).toBeNull();
  });

  it("gives another member nothing even with a row naming them: the column decides first", () => {
    const row = { ref: preset("admin") } as const;
    expect(resolveSpaceRole("member", personal, row, OTHER, ADMIN_DEFAULT)).toBeNull();
  });

  it("leaves a team space to the rules it always had, and reads no default there", () => {
    expect(resolveSpaceRole("admin", team, null, OTHER, null)).toEqual(preset("admin"));
    expect(resolveSpaceRole("member", team, null, OTHER, null)).toEqual(preset("operator"));
    expect(resolveSpaceRole("guest", team, null, OTHER, null)).toBeNull();
    // The caller id is irrelevant on a team space, which is what lets the SSE
    // and scheduler call sites pass whichever id they hold.
    expect(resolveSpaceRole("member", team, null, null, null)).toEqual(preset("operator"));
    // Nor does the personal-space default reach a team space.
    expect(resolveSpaceRole("member", team, null, OTHER, presetDefault("viewer"))).toEqual(
      preset("operator"),
    );
  });

  it("throws when a personal space is resolved for its owner without the default: a programming error", () => {
    expect(() => resolveSpaceRole("member", personal, null, OWNER, null)).toThrow();
    // The refusals that read no default stay answers, not errors.
    expect(resolveSpaceRole("member", personal, null, OTHER, null)).toBeNull();
    expect(resolveSpaceRole("owner", personal, null, OWNER, null)).toEqual(preset("admin"));
  });
});

describe("resolveSpaceRole under an org default other than admin", () => {
  it("gives a MEMBER owner operator plus exactly the four delete permissions", () => {
    const ref = resolveSpaceRole("member", personal, null, OWNER, presetDefault("operator"));
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
      const ref = resolveSpaceRole("member", personal, null, OWNER, presetDefault(name));
      expect(ref, name).toEqual({ kind: "preset", preset: name, plus: FLOOR });
      const held = spacePermissions(ref);
      for (const permission of [...presetPermissions(name), ...FLOOR]) {
        expect(held.has(permission), `${name} ${permission}`).toBe(true);
      }
    }
  });

  it("gives a custom default its own permissions plus the floor, nothing else", () => {
    const ref = resolveSpaceRole("member", personal, null, OWNER, customDefault(CUSTOM));
    expect(ref).toEqual({ ...CUSTOM, plus: FLOOR });
    expect<string[]>([...spacePermissions(ref)].sort()).toEqual(
      ["agents:read", "runs:read", ...FLOOR].sort(),
    );
  });

  it("keeps an owner or admin at admin", () => {
    for (const orgRole of ["owner", "admin"] as const) {
      for (const fallback of [presetDefault("operator"), customDefault(CUSTOM)]) {
        expect(resolveSpaceRole(orgRole, personal, null, OWNER, fallback)).toEqual(preset("admin"));
      }
    }
  });

  it("changes nothing for another member, and nothing on a team space", () => {
    expect(resolveSpaceRole("member", personal, null, OTHER, presetDefault("operator"))).toBeNull();
    expect(resolveSpaceRole("member", team, null, OTHER, presetDefault("operator"))).toEqual(
      preset("operator"),
    );
  });
});

describe("resolveSpaceRole for a GUEST owner: never more than operator, never more than chosen", () => {
  const AUTHORING: SpaceRoleRef = {
    kind: "custom",
    role: {
      id: "srl_55555555-5555-4555-8555-555555555555",
      key: "author",
      name: "Author",
      // Writes agents and runs them, reads and connects; never opens the Studio.
      permissions: [
        "agents:read",
        "agents:write",
        "agents:run",
        "runs:read",
        "integrations:connect",
      ],
      showsStudio: false,
    },
  };

  it("takes operator under builder and operator defaults, the chosen role as it is under narrower ones", () => {
    for (const name of ["builder", "operator"] as const) {
      expect(resolveSpaceRole("guest", personal, null, OWNER, presetDefault(name))).toEqual({
        kind: "preset",
        preset: "operator",
        plus: FLOOR,
      });
    }
    for (const name of ["viewer", "runner"] as const) {
      expect(resolveSpaceRole("guest", personal, null, OWNER, presetDefault(name))).toEqual({
        kind: "preset",
        preset: name,
        plus: FLOOR,
      });
    }
  });

  it("takes an authoring custom default restricted to operator: no agents:write, no Studio", () => {
    const ref = resolveSpaceRole("guest", personal, null, OWNER, customDefault(AUTHORING));
    expect(ref?.kind).toBe("custom");
    expect(ref).toMatchObject({ plus: FLOOR });
    expect((ref as { within?: unknown }).within).toBeDefined();
    const held = spacePermissions(ref);
    expect(held.has("agents:write")).toBe(false);
    expect(spaceShowsStudio(ref)).toBe(false);
    expect<string[]>([...held].sort()).toEqual(
      ["agents:read", "agents:run", "runs:read", "integrations:connect", ...FLOOR].sort(),
    );
  });

  it("takes a custom default already inside operator as it is, with the floor", () => {
    expect(resolveSpaceRole("guest", personal, null, OWNER, customDefault(CUSTOM))).toEqual({
      ...CUSTOM,
      plus: FLOOR,
    });
  });

  it("caps a guest's override by the same rule, whichever role it names", () => {
    const row = (ref: SpaceRoleRef) => ({ ref });
    expect(
      resolveSpaceRole("guest", personal, row(preset("runner")), OWNER, ADMIN_DEFAULT),
    ).toEqual({ kind: "preset", preset: "runner", plus: FLOOR });
    expect(
      resolveSpaceRole("guest", personal, row(preset("builder")), OWNER, ADMIN_DEFAULT),
    ).toEqual({ kind: "preset", preset: "operator", plus: FLOOR });
    const held = spacePermissions(
      resolveSpaceRole("guest", personal, row(AUTHORING), OWNER, ADMIN_DEFAULT),
    );
    expect(held.has("agents:write")).toBe(false);
  });
});

describe("resolveSpaceRole with the owner's own override row", () => {
  it("lets a member's row win over the org default, with the floor", () => {
    expect(
      resolveSpaceRole("member", personal, { ref: preset("viewer") }, OWNER, ADMIN_DEFAULT),
    ).toEqual({ kind: "preset", preset: "viewer", plus: FLOOR });
    expect(
      resolveSpaceRole(
        "member",
        personal,
        { ref: preset("builder") },
        OWNER,
        presetDefault("operator"),
      ),
    ).toEqual({ kind: "preset", preset: "builder", plus: FLOOR });
    expect(resolveSpaceRole("member", personal, { ref: CUSTOM }, OWNER, ADMIN_DEFAULT)).toEqual({
      ...CUSTOM,
      plus: FLOOR,
    });
  });

  it("lifts a member to admin through an admin row, without a floor", () => {
    expect(
      resolveSpaceRole(
        "member",
        personal,
        { ref: preset("admin") },
        OWNER,
        presetDefault("viewer"),
      ),
    ).toEqual(preset("admin"));
  });

  it("ignores a row for an owner or admin, who always hold admin", () => {
    for (const orgRole of ["owner", "admin"] as const) {
      expect(
        resolveSpaceRole(orgRole, personal, { ref: preset("viewer") }, OWNER, ADMIN_DEFAULT),
      ).toEqual(preset("admin"));
    }
  });
});

describe("personalSpaceDefaultRef", () => {
  it("reads an absent setting as admin and a preset key as that preset", () => {
    expect(personalSpaceDefaultRef(cols(null))).toEqual(ADMIN_ROLE_REF);
    for (const name of ["admin", "builder", "operator", "runner", "viewer"] as const) {
      expect(personalSpaceDefaultRef(cols(name))).toEqual(preset(name));
    }
  });

  it("reads the custom column as the role the same statement resolved, Studio flag included", () => {
    expect(personalSpaceDefaultRef(customDefault(CUSTOM))).toEqual(CUSTOM);
    expect(personalSpaceDefaultRef(customDefault(CUSTOM_STUDIO))).toEqual(CUSTOM_STUDIO);
  });
});

describe("shows_studio on a custom role: a display attribute, never a permission", () => {
  it("shows the Studio when the role says so, not otherwise; a preset always does", () => {
    expect(spaceShowsStudio(CUSTOM_STUDIO)).toBe(true);
    expect(spaceShowsStudio(CUSTOM)).toBe(false);
    expect(spaceShowsStudio({ kind: "preset", preset: "viewer" })).toBe(true);
    expect(spaceShowsStudio(null)).toBe(false);
  });

  it("follows the role as the org default and as an override, for a member", () => {
    for (const [ref, studio] of [
      [CUSTOM_STUDIO, true],
      [CUSTOM, false],
    ] as const) {
      const byDefault = resolveSpaceRole("member", personal, null, OWNER, customDefault(ref));
      const byOverride = resolveSpaceRole("member", personal, { ref }, OWNER, ADMIN_DEFAULT);
      expect(spaceShowsStudio(byDefault)).toBe(studio);
      expect(spaceShowsStudio(byOverride)).toBe(studio);
    }
  });

  it("keeps the role's flag under the guest cap", () => {
    for (const ref of [CUSTOM_STUDIO, CUSTOM]) {
      const guest = resolveSpaceRole("guest", personal, { ref }, OWNER, ADMIN_DEFAULT);
      expect(spaceShowsStudio(guest)).toBe(ref === CUSTOM_STUDIO);
    }
  });
});
