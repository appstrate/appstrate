// SPDX-License-Identifier: Apache-2.0

/**
 * `credential-proxy:call` (the space's usable connections, and the run path) is held by `admin`
 * and `builder`, which author the agents a run executes; `credential-proxy:call-own` (own
 * connections, outside a run) by those and `operator`. `runner` and `viewer` hold neither.
 */

import { describe, expect, it } from "bun:test";
import { SPACE_ROLE_PRESETS } from "@appstrate/core/permissions";
import { presetPermissions, type Permission } from "../../../src/lib/permissions.ts";

const holders = (permission: Permission) =>
  SPACE_ROLE_PRESETS.filter((preset) => presetPermissions(preset).has(permission));

describe("credential proxy grants", () => {
  it("credential-proxy:call is held by `admin` and `builder`", () => {
    expect(holders("credential-proxy:call")).toEqual(["admin", "builder"]);
  });

  it("credential-proxy:call-own is held by `admin`, `builder` and `operator`", () => {
    expect(holders("credential-proxy:call-own")).toEqual(["admin", "builder", "operator"]);
  });
});
