// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  categorizeUserAgent,
  grantLabel,
  grantOriginLabel,
  grantTargetLabel,
  grantTargetPhrase,
} from "../access-grants";

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}(${JSON.stringify(options)})` : key;

describe("grantOriginLabel", () => {
  it("shows the origin the platform can vouch for", () => {
    expect(
      grantOriginLabel({ client_origin: "claude.ai", client_registration: "metadata_document" }, t),
    ).toBe("claude.ai");
  });

  it("calls a dynamic client with only loopback redirects a local app", () => {
    expect(grantOriginLabel({ client_origin: null, client_registration: "dynamic" }, t)).toBe(
      "accessGrants.originLocal",
    );
  });

  it("says when no origin could be verified", () => {
    expect(grantOriginLabel({ client_origin: null, client_registration: "managed" }, t)).toBe(
      "accessGrants.originUnknown",
    );
  });
});

describe("grantLabel", () => {
  const base = { device_name: null, user_agent: null, client_name: null };

  it("uses the MCP client's declared name, or says it has none", () => {
    expect(grantLabel({ ...base, kind: "mcp", client_name: "Cursor" }, t)).toBe("Cursor");
    expect(grantLabel({ ...base, kind: "mcp" }, t)).toBe("accessGrants.unnamedClient");
  });

  it("names a CLI session by its device, else by its user agent", () => {
    expect(grantLabel({ ...base, kind: "cli", device_name: "laptop" }, t)).toBe("laptop");
    expect(grantLabel({ ...base, kind: "cli", user_agent: "appstrate-action/1.0" }, t)).toBe(
      "accessGrants.fallbackGithubAction",
    );
    expect(grantLabel({ ...base, kind: "cli", user_agent: "appstrate-cli/2.4.0" }, t)).toBe(
      "accessGrants.fallbackCli",
    );
  });
});

describe("categorizeUserAgent", () => {
  it("matches the GitHub Action before the CLI it contains", () => {
    expect(categorizeUserAgent("appstrate-cli/2.4 github-action")).toBe("github-action");
    expect(categorizeUserAgent(null)).toBe("unknown");
  });
});

describe("grantTargetLabel / grantTargetPhrase", () => {
  const org = { orgId: "o", org_name: "Acme", spaceId: null, space_name: null };
  const space = { orgId: "o", org_name: "Acme", spaceId: "spc_1", space_name: "Ops" };

  it("names the org or the space the grant reaches", () => {
    expect(grantTargetLabel(org, t)).toBe('accessGrants.targetOrg({"name":"Acme"})');
    expect(grantTargetPhrase(space, t)).toBe('accessGrants.targetSpacePhrase({"name":"Ops"})');
  });
});
