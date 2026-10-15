// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import type { RoleObject } from "../../hooks/use-roles";
import {
  VIEW_AS_NO_SPACE,
  viewAsRoleValue,
  viewAsSpace,
  type ViewAsPreset,
} from "../view-as-preset";

const OPEN = { id: "spc_open", visibility: "open" as const, default_role: "runner" };
const CLOSED = { id: "spc_closed", visibility: "closed" as const, default_role: "viewer" };
const SPACES = [OPEN, CLOSED];

function space(preset: ViewAsPreset | null, home: string | null, picked: string | null = null) {
  return viewAsSpace({ preset, homeSpaceId: home, spaces: SPACES, pickedSpaceId: picked });
}

describe("viewAsSpace", () => {
  it("opens a Member on its open home space, with the role that space gives its members", () => {
    expect(space({ kind: "org", role: "member" }, OPEN.id)).toEqual({
      spaceId: OPEN.id,
      presetRoleKey: "runner",
    });
  });

  it("opens a Member on no space when the home space is not open, a Guest always", () => {
    const none = { spaceId: VIEW_AS_NO_SPACE, presetRoleKey: undefined };
    expect(space({ kind: "org", role: "member" }, CLOSED.id)).toEqual(none);
    expect(space({ kind: "org", role: "guest" }, OPEN.id)).toEqual(none);
    expect(space({ kind: "org", role: "member" }, null)).toEqual(none);
  });

  it("judges a space role in the home space, and opens on the home space without a preset", () => {
    expect(space({ kind: "space", key: "viewer" }, CLOSED.id)).toEqual({
      spaceId: CLOSED.id,
      presetRoleKey: "viewer",
    });
    expect(space(null, CLOSED.id)).toEqual({ spaceId: CLOSED.id, presetRoleKey: undefined });
    expect(space(null, null).spaceId).toBe(VIEW_AS_NO_SPACE);
  });

  it("opens on no space when the home space is not one the dialog offers", () => {
    // The admin's personal space is filtered out of the choices: nobody else stands in it.
    expect(space(null, "spc_personal").spaceId).toBe(VIEW_AS_NO_SPACE);
    expect(space({ kind: "space", key: "viewer" }, "spc_personal")).toEqual({
      spaceId: VIEW_AS_NO_SPACE,
      presetRoleKey: undefined,
    });
  });

  it("lets the user's pick, even no space, override the preset and drop its role", () => {
    expect(space({ kind: "org", role: "member" }, OPEN.id, VIEW_AS_NO_SPACE)).toEqual({
      spaceId: VIEW_AS_NO_SPACE,
      presetRoleKey: undefined,
    });
    expect(space({ kind: "space", key: "viewer" }, OPEN.id, CLOSED.id)).toEqual({
      spaceId: CLOSED.id,
      presetRoleKey: undefined,
    });
  });
});

function role(kind: "preset" | "custom", key: string, id: string | null = null): RoleObject {
  return {
    object: "role",
    kind,
    id,
    key,
    name: key,
    description: null,
    permissions: [],
    unavailable_permissions: [],
    createdAt: null,
    updatedAt: null,
  };
}

describe("viewAsRoleValue", () => {
  const roles = [role("preset", "viewer"), role("custom", "support-lead", "srl_1")];

  it("selects the preset's role from the catalog: a preset by key, a custom role by id", () => {
    expect(viewAsRoleValue("viewer", null, roles)).toBe("preset:viewer");
    expect(viewAsRoleValue("support-lead", null, roles)).toBe("custom:srl_1");
  });

  it("selects nothing for a role the catalog lacks, or before it lands", () => {
    expect(viewAsRoleValue("ghost", null, roles)).toBe("");
    expect(viewAsRoleValue("viewer", null, undefined)).toBe("");
    expect(viewAsRoleValue(undefined, null, roles)).toBe("");
  });

  it("keeps the user's pick over the preset", () => {
    expect(viewAsRoleValue("viewer", "custom:srl_1", roles)).toBe("custom:srl_1");
  });
});
