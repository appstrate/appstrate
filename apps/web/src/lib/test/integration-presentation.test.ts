// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { authMethodLabel, integrationConnectionState } from "../integration-presentation";
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
  it("does not warn about an unused optional method when a required account is available", () => {
    expect(
      integrationConnectionState(true, [auth({ ready: true }), auth({ required: false })]),
    ).toBe("available");
  });
  it("reports missing required access despite another available account", () => {
    expect(integrationConnectionState(true, [auth(), auth({ ready: true })])).toBe("missing");
  });
  it("shows optional-only empty accounts neutrally", () => {
    expect(integrationConnectionState(true, [auth({ required: false })])).toBe("none");
  });
  it("distinguishes no authentication from missing credentials", () => {
    expect(integrationConnectionState(true, [])).toBe("noAuth");
  });
  it("does not imply activation merely because accounts exist", () => {
    expect(integrationConnectionState(false, [auth({ ready: true })])).toBe("inactive");
  });
});
