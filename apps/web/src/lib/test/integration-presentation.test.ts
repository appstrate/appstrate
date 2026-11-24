// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { authMethodLabel } from "../integration-presentation";
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
