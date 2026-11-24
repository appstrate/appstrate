// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { authMethodLabel, reconnectScopeOf } from "../integration-presentation";
import type { IntegrationAuthStatus } from "../../hooks/use-integrations";

function auth(overrides: Partial<IntegrationAuthStatus> = {}): IntegrationAuthStatus {
  return {
    auth_key: "oauth",
    type: "oauth2",
    required: true,
    ready: false,
    scopes: [],
    resource: null,
    connections: [],
    has_oauth_client: true,
    has_system_client: false,
    client_auto_provisioned: false,
    ...overrides,
  };
}

describe("integration presentation", () => {
  it("does not turn a lone technical key into a menu label", () => {
    const method = auth({ auth_key: "mcp" });
    expect(authMethodLabel(method, [method], "OAuth")).toBe("OAuth");
  });
  it("disambiguates methods of the same type without guessing capabilities", () => {
    const methods = [auth({ auth_key: "drive" }), auth({ auth_key: "mcp" })];
    expect(authMethodLabel(methods[0]!, methods, "OAuth")).toBe("OAuth (drive)");
    expect(authMethodLabel(methods[1]!, methods, "OAuth")).toBe("OAuth (mcp)");
  });
});

describe("reconnectScopeOf", () => {
  const row = (overrides: Partial<Parameters<typeof reconnectScopeOf>[0]> = {}) => ({
    allowed_actions: ["rename", "reconnect"],
    org: { id: "org_a" },
    space: null,
    origin_space: null,
    ...overrides,
  });
  const working = { orgId: "org_a", spaceId: "spc_here" };

  it("offers nothing without the reconnect action", () => {
    expect(reconnectScopeOf(row({ allowed_actions: ["rename"] }), working)).toBeNull();
  });
  it("renews a space-scoped row in its own space, whatever the working space", () => {
    expect(
      reconnectScopeOf(row({ space: { id: "spc_row" }, origin_space: { id: "spc_o" } }), working),
    ).toEqual({ orgId: "org_a", spaceId: "spc_row" });
  });
  it("renews an org-wide row in the space that minted it", () => {
    expect(reconnectScopeOf(row({ origin_space: { id: "spc_o" } }), working)).toEqual({
      orgId: "org_a",
      spaceId: "spc_o",
    });
  });
  it("falls back to the working space only inside the working organization", () => {
    expect(reconnectScopeOf(row(), working)).toEqual({ orgId: "org_a", spaceId: "spc_here" });
    expect(reconnectScopeOf(row({ org: { id: "org_b" } }), working)).toBeNull();
  });
});
