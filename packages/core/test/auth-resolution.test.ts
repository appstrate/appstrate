// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import type { AuthResolution } from "../src/module.ts";

const user = { id: "usr_1", email: "a@example.com", name: "A" };

describe("AuthResolution", () => {
  // Type-level: `tsc` fails on an unused `@ts-expect-error`, so each refused
  // shape below is one the type must keep refusing.
  it("takes its ceiling in `permissions` inline and in `scopeCeiling` deferred, never both", () => {
    const inline: AuthResolution = {
      user,
      orgRole: "admin",
      authMethod: "test",
      principalKind: "delegate",
      permissions: ["agents:read"],
    };
    const deferred: AuthResolution = {
      user,
      authMethod: "test",
      principalKind: "user",
      permissions: [],
      deferOrgResolution: true,
      scopeCeiling: ["agents:read"],
    };
    // @ts-expect-error — an inline resolution's ceiling is `permissions`
    const inlineWithScopeCeiling: AuthResolution = {
      user,
      authMethod: "test",
      principalKind: "delegate",
      permissions: ["agents:read"],
      scopeCeiling: ["agents:read"],
    };
    // @ts-expect-error — a deferred resolution's ceiling is `scopeCeiling`
    const deferredWithPermissions: AuthResolution = {
      user,
      authMethod: "test",
      principalKind: "user",
      permissions: ["agents:read"],
      deferOrgResolution: true,
    };
    // @ts-expect-error — a deferred resolution's role comes from the `X-Org-Id` middleware
    const deferredWithRole: AuthResolution = {
      user,
      orgRole: "admin",
      authMethod: "test",
      principalKind: "user",
      permissions: [],
      deferOrgResolution: true,
    };
    expect([
      inline,
      deferred,
      inlineWithScopeCeiling,
      deferredWithPermissions,
      deferredWithRole,
    ]).toHaveLength(5);
  });
});
