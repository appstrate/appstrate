// SPDX-License-Identifier: Apache-2.0

/**
 * `credential-proxy:call-own`, the call outside a run, is held by the presets that hold
 * `credential-proxy:call-run`: `admin` and `builder`, which author the agents a run executes.
 */

import { describe, expect, it } from "bun:test";
import { SPACE_ROLE_PRESETS } from "@appstrate/core/permissions";
import { presetPermissions, type Permission } from "../../../src/lib/permissions.ts";

const holders = (permission: Permission) =>
  SPACE_ROLE_PRESETS.filter((preset) => presetPermissions(preset).has(permission));

describe("credential-proxy:call-own", () => {
  it("is held by `admin` and `builder`, the presets holding credential-proxy:call-run", () => {
    expect(holders("credential-proxy:call-own")).toEqual(["admin", "builder"]);
    expect(holders("credential-proxy:call-run")).toEqual(["admin", "builder"]);
  });
});
