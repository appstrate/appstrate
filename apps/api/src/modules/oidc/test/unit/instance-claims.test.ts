// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for instance-level OIDC claims and scope filtering.
 */

import { describe, it, expect } from "bun:test";
import { scopesToPermissions } from "../../auth/claims.ts";

describe("scopesToPermissions — instance (user) actor type", () => {
  it("returns an empty set for user actor type (permissions deferred to pipeline)", () => {
    const result = scopesToPermissions("openid profile email agents:read agents:run", "user");
    expect(result.size).toBe(0);
  });

  it("returns an empty set even with a valid orgRole", () => {
    const result = scopesToPermissions("agents:read agents:run", "user", "admin");
    expect(result.size).toBe(0);
  });

  it("returns an empty set for undefined scope", () => {
    const result = scopesToPermissions(undefined, "user");
    expect(result.size).toBe(0);
  });
});
