// SPDX-License-Identifier: Apache-2.0

/**
 * `credential-proxy:call-own`, the call outside a run, is held by `admin` alone among the presets:
 * below it a custom space role grants it, and an API key carries it only from a creator who
 * holds it.
 */

import { describe, expect, it } from "bun:test";
import { SPACE_LEVEL_PERMISSIONS, SPACE_ROLE_PRESETS } from "@appstrate/core/permissions";
import {
  API_KEY_ALLOWED_SCOPES,
  effectivePermissions,
  orgPermissions,
  presetPermissions,
  validateScopes,
} from "../../../src/lib/permissions.ts";
import { resolveSpaceRole, spacePermissions } from "../../../src/lib/space-role.ts";

const CALL_OWN = "credential-proxy:call-own";

describe("credential-proxy:call-own", () => {
  it("is held by `admin` and by no other preset", () => {
    expect(SPACE_ROLE_PRESETS.filter((preset) => presetPermissions(preset).has(CALL_OWN))).toEqual([
      "admin",
    ]);
  });

  it("is the one core permission `builder` lacks outside the governance families", () => {
    // `builder` derives from `admin`, so what it lacks is its exclusions and
    // nothing else: the three governance families, and this string.
    const builder = presetPermissions("builder");
    const governance = ["space-settings:", "space-members:", "api-keys:"];
    const lacking = [...SPACE_LEVEL_PERMISSIONS].filter(
      (permission) =>
        !builder.has(permission) && !governance.some((prefix) => permission.startsWith(prefix)),
    );
    expect(lacking).toEqual([CALL_OWN]);
  });

  it("reaches an org owner or admin in any team space, and no member through a default role", () => {
    const inOpenSpace = (role: Parameters<typeof orgPermissions>[0]) =>
      effectivePermissions({
        orgPermissions: orgPermissions(role),
        spacePermissions: spacePermissions(
          resolveSpaceRole(
            role,
            { id: "spc_test", visibility: "open", defaultRole: "builder", ownerUserId: null },
            null,
            "usr_test",
          ),
        ),
      });
    expect(inOpenSpace("owner").has(CALL_OWN)).toBe(true);
    expect(inOpenSpace("admin").has(CALL_OWN)).toBe(true);
    // The widest default a space can hand a member is not `admin`'s.
    expect(inOpenSpace("member").has(CALL_OWN)).toBe(false);
    expect(inOpenSpace("guest").has(CALL_OWN)).toBe(false);
  });

  it("is API-key grantable, and only to a creator who holds it", () => {
    expect(API_KEY_ALLOWED_SCOPES.has(CALL_OWN)).toBe(true);
    expect(validateScopes([CALL_OWN], new Set([CALL_OWN]))).toEqual([CALL_OWN]);
    expect(validateScopes(["agents:read", CALL_OWN], presetPermissions("admin"))).toEqual([
      "agents:read",
      CALL_OWN,
    ]);
    // A builder does not hold it: the scope narrows away at mint, as any grant
    // above the creator does.
    expect(validateScopes(["agents:read", CALL_OWN], presetPermissions("builder"))).toEqual([
      "agents:read",
    ]);
  });
});
