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
  overrideAdmissible,
  PERSONAL_CAP_DELETE_PERMISSIONS,
  personalSpaceDefaultRef,
  resolveSpaceRole,
  spacePermissions,
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

/**
 * The org default as the snapshot carries it: the raw columns, never a decoded role. `stored` is
 * the jsonb key; `custom` is the role `personal_space_role_id` names, which the `psr` join finds
 * unless `joined` is false (a role of another organization).
 */
function cols(
  stored: string | null,
  custom: SpaceRoleRef | null = null,
  joined = true,
): PersonalSpaceDefaultColumns {
  const role = custom?.kind === "custom" ? custom.role : null;
  const found = joined ? role : null;
  return {
    storedPersonalSpaceRole: stored,
    storedPersonalSpaceRoleId: role?.id ?? null,
    personalDefaultRoleId: found?.id ?? null,
    personalDefaultKey: found?.key ?? null,
    personalDefaultName: found?.name ?? null,
    personalDefaultPermissions: found ? [...found.permissions] : null,
    personalDefaultShowsStudio: found?.showsStudio ?? null,
  };
}
const ADMIN_DEFAULT = cols(null);
const presetDefault = (name: string) => cols(name);
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
    expect(resolveSpaceRole("admin", team, null, OTHER)).toEqual(preset("admin"));
    expect(resolveSpaceRole("member", team, null, OTHER)).toEqual(preset("operator"));
    expect(resolveSpaceRole("guest", team, null, OTHER)).toBeNull();
    // The caller id is irrelevant on a team space, which is what lets the SSE
    // and scheduler call sites pass whichever id they hold.
    expect(resolveSpaceRole("member", team, null, null)).toEqual(preset("operator"));
    // Nor does the personal-space default reach a team space, whatever it names.
    expect(resolveSpaceRole("member", team, null, OTHER, presetDefault("viewer"))).toEqual(
      preset("operator"),
    );
    expect(resolveSpaceRole("member", team, null, OTHER, presetDefault("superuser"))).toEqual(
      preset("operator"),
    );
  });

  it("throws when a personal space is resolved for its owner without the default: a programming error", () => {
    expect(() => resolveSpaceRole("member", personal, null, OWNER)).toThrow();
    // The refusals that read no default stay answers, not errors.
    expect(resolveSpaceRole("member", personal, null, OTHER)).toBeNull();
    expect(resolveSpaceRole("owner", personal, null, OWNER)).toEqual(preset("admin"));
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

  it("takes operator plus the floor under the admin default", () => {
    expect(resolveSpaceRole("guest", personal, null, OWNER, ADMIN_DEFAULT)).toEqual({
      kind: "preset",
      preset: "operator",
      plus: FLOOR,
    });
  });

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

  it("takes the viewer default as viewer plus the floor, no more than viewer", () => {
    const held = spacePermissions(
      resolveSpaceRole("guest", personal, null, OWNER, presetDefault("viewer")),
    );
    expect<string[]>([...held].sort()).toEqual([...presetPermissions("viewer"), ...FLOOR].sort());
  });

  it("takes an authoring custom default restricted to operator: no agents:write, no studio:read", () => {
    const ref = resolveSpaceRole("guest", personal, null, OWNER, customDefault(AUTHORING));
    expect(ref?.kind).toBe("custom");
    expect(ref).toMatchObject({ plus: FLOOR });
    expect((ref as { within?: unknown }).within).toBeDefined();
    const held = spacePermissions(ref);
    expect(held.has("agents:write")).toBe(false);
    expect(held.has("studio:read")).toBe(false);
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

  it("holds nothing under a default naming no role", () => {
    expect(resolveSpaceRole("guest", personal, null, OWNER, presetDefault("superuser"))).toBeNull();
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

  it("answers before a default naming no role", () => {
    expect(
      resolveSpaceRole(
        "member",
        personal,
        { ref: preset("runner") },
        OWNER,
        presetDefault("superuser"),
      ),
    ).toEqual({ kind: "preset", preset: "runner", plus: FLOOR });
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

  it("fails closed to no role on what the schema cannot exclude, never a preset", () => {
    // The column naming a role the org-scoped join does not find: another org's.
    const foreign = cols(null, CUSTOM, false);
    expect(personalSpaceDefaultRef(foreign)).toBeNull();
    // A jsonb value that is not a preset (an id there included: the column holds customs).
    expect(personalSpaceDefaultRef(cols("superuser"))).toBeNull();
    if (CUSTOM.kind !== "custom") throw new Error("unreachable");
    expect(personalSpaceDefaultRef(cols(CUSTOM.role.id))).toBeNull();
    const dangling = foreign;
    // An owner without an override then holds nothing in their own space, a member or a guest…
    for (const orgRole of ["member", "guest"] as const) {
      expect(resolveSpaceRole(orgRole, personal, null, OWNER, dangling)).toBeNull();
    }
    // …while an override still answers first, and an owner or admin still holds admin.
    expect(
      resolveSpaceRole("member", personal, { ref: preset("runner") }, OWNER, cols("superuser")),
    ).toEqual({ kind: "preset", preset: "runner", plus: FLOOR });
    expect(resolveSpaceRole("admin", personal, null, OWNER, cols("superuser"))).toEqual(
      ADMIN_ROLE_REF,
    );
  });
});

describe("studio:read on a custom role: resolved from shows_studio, never from the bundle", () => {
  it("resolves it when the role shows the Studio, not otherwise", () => {
    expect(spacePermissions(CUSTOM_STUDIO).has("studio:read")).toBe(true);
    expect(spacePermissions(CUSTOM).has("studio:read")).toBe(false);
  });

  it("never grants it from a stored array that spells it", () => {
    if (CUSTOM.kind !== "custom") throw new Error("unreachable");
    const spelled: SpaceRoleRef = {
      kind: "custom",
      role: { ...CUSTOM.role, permissions: [...CUSTOM.role.permissions, "studio:read"] },
    };
    expect(spacePermissions(spelled).has("studio:read")).toBe(false);
  });

  it("follows the role as the org default and as an override, for a member", () => {
    for (const [ref, studio] of [
      [CUSTOM_STUDIO, true],
      [CUSTOM, false],
    ] as const) {
      const byDefault = resolveSpaceRole("member", personal, null, OWNER, customDefault(ref));
      const byOverride = resolveSpaceRole("member", personal, { ref }, OWNER, ADMIN_DEFAULT);
      expect(spacePermissions(byDefault).has("studio:read")).toBe(studio);
      expect(spacePermissions(byOverride).has("studio:read")).toBe(studio);
    }
  });

  it("keeps it under the guest cap when the role shows the Studio, and keeps it hidden otherwise", () => {
    // `operator` holds `studio:read`, so a role showing the Studio stays inside it.
    expect(overrideAdmissible("guest", CUSTOM_STUDIO)).toBe(true);
    expect(resolveSpaceRole("guest", personal, null, OWNER, customDefault(CUSTOM_STUDIO))).toEqual({
      ...CUSTOM_STUDIO,
      plus: FLOOR,
    });
    for (const ref of [CUSTOM_STUDIO, CUSTOM]) {
      const guest = spacePermissions(
        resolveSpaceRole("guest", personal, { ref }, OWNER, ADMIN_DEFAULT),
      );
      expect(guest.has("studio:read")).toBe(ref === CUSTOM_STUDIO);
    }
  });
});

describe("overrideAdmissible", () => {
  it("admits any role for a member", () => {
    for (const ref of [preset("viewer"), preset("builder"), preset("admin"), CUSTOM]) {
      expect(overrideAdmissible("member", ref)).toBe(true);
    }
  });

  it("admits a role inside operator for a guest, and refuses one holding more", () => {
    for (const ref of [preset("viewer"), preset("runner"), preset("operator"), CUSTOM]) {
      expect(overrideAdmissible("guest", ref)).toBe(true);
    }
    for (const ref of [preset("builder"), preset("admin")]) {
      expect(overrideAdmissible("guest", ref)).toBe(false);
    }
  });

  it("admits nothing for an owner or admin, who always hold admin and never read it", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(overrideAdmissible(role, preset("viewer"))).toBe(false);
    }
  });
});
