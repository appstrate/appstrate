// SPDX-License-Identifier: Apache-2.0

/**
 * `credential-proxy:call-own`, the call outside a run, is held by `admin` alone among the presets:
 * it is the one permission `builder` lacks besides the governance families.
 */

import { describe, expect, it } from "bun:test";
import { SPACE_LEVEL_PERMISSIONS, SPACE_ROLE_PRESETS } from "@appstrate/core/permissions";
import { presetPermissions } from "../../../src/lib/permissions.ts";

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
});
