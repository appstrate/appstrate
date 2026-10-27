// SPDX-License-Identifier: Apache-2.0

/**
 * The roles page's rows group org-level permissions; which role holds a row is read from
 * `GET /api/org-roles`, never copied here.
 */

import { describe, expect, it } from "bun:test";
import { ORG_LEVEL_PERMISSIONS } from "@appstrate/core/permissions";
import { holdsCapability, ORG_ROLE_CAPABILITIES } from "../org-role-capabilities.ts";

describe("ORG_ROLE_CAPABILITIES", () => {
  it("names org-level permissions only", () => {
    const unknown = ORG_ROLE_CAPABILITIES.flatMap((capability) =>
      capability.permissions.filter((permission) => !ORG_LEVEL_PERMISSIONS.has(permission)),
    );
    expect(unknown).toEqual([]);
  });
});

describe("holdsCapability", () => {
  const settings = ORG_ROLE_CAPABILITIES.find((capability) => capability.key === "settings")!;

  it("holds a row only with every permission it stands for", () => {
    expect(holdsCapability(settings, new Set(["org:settings", "org:read"]))).toBe(true);
    expect(holdsCapability(settings, new Set(["org:read"]))).toBe(false);
  });
});
