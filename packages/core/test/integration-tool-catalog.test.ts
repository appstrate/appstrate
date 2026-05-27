// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the integration tool catalog resolver — the single source
 * of truth for "what tools does this integration expose to an agent".
 *
 * The resolver layers four steps (see `resolveIntegrationToolCatalog`):
 *   1. Base catalog (api/local/fallback)
 *   2. Subtract `hidden_tools`
 *   3. Subtract auto-hidden connect-tool primitives
 *   4. Attach policy from `integration.tools_policy[name]`
 *
 * `validateAgentIntegrationScopes` now consumes the same resolver, so
 * tool-membership errors track the catalog (not the sparse policy table).
 */

import { describe, it, expect } from "bun:test";
import {
  resolveIntegrationToolCatalog,
  getConnectToolNames,
  validateAgentIntegrationScopes,
  API_CALL_TOOL_NAME,
  type IntegrationManifest,
} from "../src/integration.ts";

function localSourceManifest(opts: {
  serverName?: string;
  tools?: Record<string, unknown>;
  hidden_tools?: string[];
  connectToolName?: string;
}): IntegrationManifest {
  const auth: Record<string, unknown> = {
    type: "api_key",
    authorized_uris: ["https://api.example.com/**"],
    credentials: {
      schema: {
        type: "object",
        required: ["api_key"],
        properties: { api_key: { type: "string" } },
      },
    },
    delivery: { http: { in: "header", name: "Authorization", value: "{$credential.api_key}" } },
  };
  if (opts.connectToolName) {
    auth.connect = {
      tool: { name: opts.connectToolName, run_at: "run-start" },
    };
  }
  return {
    schema_version: "0.1",
    type: "integration",
    name: "@me/integ",
    version: "1.0.0",
    display_name: "Integ",
    source: { kind: "local", server: { name: opts.serverName ?? "@me/server", version: "^1.0.0" } },
    auths: { primary: auth },
    ...(opts.tools ? { tools_policy: opts.tools } : {}),
    ...(opts.hidden_tools ? { hidden_tools: opts.hidden_tools } : {}),
  } as unknown as IntegrationManifest;
}

function apiSourceManifest(): IntegrationManifest {
  return {
    schema_version: "0.1",
    type: "integration",
    name: "@me/api-integ",
    version: "1.0.0",
    display_name: "API",
    // Serverless integration: no MCP backing, api_call exposed via the
    // `_meta["dev.appstrate/api"]` vendor extension (orthogonal to source.kind).
    source: { kind: "none" },
    _meta: { "dev.appstrate/api": { auths: { primary: {} } } },
    auths: {
      primary: {
        type: "api_key",
        authorized_uris: ["https://api.example.com/**"],
        credentials: {
          schema: {
            type: "object",
            required: ["api_key"],
            properties: { api_key: { type: "string" } },
          },
        },
        delivery: { http: { in: "header", name: "Authorization", value: "{$credential.api_key}" } },
      },
    },
  } as unknown as IntegrationManifest;
}

describe("resolveIntegrationToolCatalog", () => {
  it("local source: surfaces mcp-server tools as the base catalog (MCPB-canonical)", () => {
    const out = resolveIntegrationToolCatalog({
      integration: localSourceManifest({}),
      mcpServerTools: [
        { name: "kv_set", description: "set a key" },
        { name: "kv_get", description: "get a key" },
        { name: "hash" },
      ],
    });
    expect(out.map((e) => e.name)).toEqual(["kv_set", "kv_get", "hash"]);
    expect(out[0]!.description).toBe("set a key");
    expect(out[0]!.policy).toBeUndefined();
  });

  it("attaches policy from integration.tools_policy[name] without forcing every tool to be declared", () => {
    const out = resolveIntegrationToolCatalog({
      integration: localSourceManifest({
        tools: {
          fetch_echo: {
            required_auth_key: "primary",
            required_scopes: ["read"],
            url_patterns: [{ pattern: "https://httpbin.org/**", methods: ["GET"] }],
          },
        },
      }),
      mcpServerTools: [{ name: "kv_set" }, { name: "fetch_echo" }],
    });
    expect(out).toHaveLength(2);
    const fetchEcho = out.find((e) => e.name === "fetch_echo")!;
    expect(fetchEcho.policy?.requiredScopes).toEqual(["read"]);
    expect(fetchEcho.policy?.requiredAuthKey).toBe("primary");
    expect(fetchEcho.policy?.urlPatterns).toEqual([
      { pattern: "https://httpbin.org/**", methods: ["GET"] },
    ]);
    const kvSet = out.find((e) => e.name === "kv_set")!;
    expect(kvSet.policy).toBeUndefined();
  });

  it("subtracts hidden_tools (explicit opt-out)", () => {
    const out = resolveIntegrationToolCatalog({
      integration: localSourceManifest({ hidden_tools: ["internal_dbg"] }),
      mcpServerTools: [{ name: "public" }, { name: "internal_dbg" }],
    });
    expect(out.map((e) => e.name)).toEqual(["public"]);
  });

  it("auto-subtracts tools used as a run-start connect.tool primitive", () => {
    const out = resolveIntegrationToolCatalog({
      integration: localSourceManifest({ connectToolName: "login" }),
      mcpServerTools: [{ name: "login" }, { name: "fetch_data" }],
    });
    expect(out.map((e) => e.name)).toEqual(["fetch_data"]);
  });

  it("none source with api_call _meta: appends api_call to the base catalog", () => {
    // A `none` source has no MCP base catalog of its own, so the appended
    // api_call tool is the only entry. (Any `mcpServerTools` passed here are
    // a no-op the resolver still prepends — see the local+api_call case below.)
    const out = resolveIntegrationToolCatalog({
      integration: apiSourceManifest(),
    });
    expect(out).toEqual([{ name: API_CALL_TOOL_NAME }]);
  });

  it("local source WITH api_call _meta: api_call is appended to the mcp tools", () => {
    const integration = localSourceManifest({});
    (integration as unknown as { _meta: unknown })._meta = {
      "dev.appstrate/api": { auths: { primary: {} } },
    };
    const out = resolveIntegrationToolCatalog({
      integration,
      mcpServerTools: [{ name: "kv_set" }, { name: "kv_get" }],
    });
    expect(out.map((e) => e.name)).toEqual(["kv_set", "kv_get", API_CALL_TOOL_NAME]);
  });

  it("local source without mcp-server tools: falls back to integration.tools_policy keys", () => {
    const out = resolveIntegrationToolCatalog({
      integration: localSourceManifest({
        tools: { policy_only: { required_scopes: ["read"] } },
      }),
    });
    expect(out.map((e) => e.name)).toEqual(["policy_only"]);
    expect(out[0]!.policy?.requiredScopes).toEqual(["read"]);
  });
});

describe("getConnectToolNames", () => {
  it("collects tool names across every auth declaring a connect primitive", () => {
    const m = localSourceManifest({ connectToolName: "login" });
    expect(getConnectToolNames(m)).toEqual(["login"]);
  });

  it("returns [] when no auth declares a connect.tool", () => {
    expect(getConnectToolNames(localSourceManifest({}))).toEqual([]);
  });
});

describe("validateAgentIntegrationScopes — uses the catalog, not the policy table", () => {
  it("accepts an mcp-server tool the integration did NOT declare in its policy table", () => {
    // Regression: before the catalog refactor, this returned `unknown_tool`
    // because `integration.tools_policy{}` was treated as the whitelist.
    const errors = validateAgentIntegrationScopes(
      { id: "@me/integ", tools: ["kv_set"] },
      localSourceManifest({
        tools: { fetch_echo: { required_scopes: ["read"] } }, // policy only for one tool
      }),
      [{ name: "kv_set" }, { name: "fetch_echo" }],
    );
    expect(errors).toEqual([]);
  });

  it("rejects tools not present in the catalog", () => {
    const errors = validateAgentIntegrationScopes(
      { id: "@me/integ", tools: ["doesnt_exist"] },
      localSourceManifest({}),
      [{ name: "kv_set" }],
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("unknown_tool");
    expect(errors[0]!.field).toBe("integrations_configuration.@me/integ.tools");
  });

  it("rejects a hidden tool even if the mcp-server advertises it", () => {
    const errors = validateAgentIntegrationScopes(
      { id: "@me/integ", tools: ["login"] },
      localSourceManifest({ connectToolName: "login" }),
      [{ name: "login" }, { name: "fetch_data" }],
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("unknown_tool");
  });

  it("api source: accepts api_call as the synthetic catalog member", () => {
    const errors = validateAgentIntegrationScopes(
      { id: "@me/api-integ", tools: [API_CALL_TOOL_NAME] },
      apiSourceManifest(),
    );
    expect(errors).toEqual([]);
  });
});
