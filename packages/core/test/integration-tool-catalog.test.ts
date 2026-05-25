// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the integration tool catalog resolver — the single source
 * of truth for "what tools does this integration expose to an agent".
 *
 * The resolver layers four steps (see `resolveIntegrationToolCatalog`):
 *   1. Base catalog (api/local/fallback)
 *   2. Subtract `hidden_tools`
 *   3. Subtract auto-hidden connect-tool primitives
 *   4. Attach policy from `integration.tools[name]`
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
      tool: {},
      _meta: { "dev.appstrate/connect": { tool: opts.connectToolName, run_at: "run-start" } },
    };
  }
  return {
    schema_version: "2.0",
    type: "integration",
    name: "@me/integ",
    version: "1.0.0",
    display_name: "Integ",
    source: { kind: "local", server: { name: opts.serverName ?? "@me/server", version: "^1.0.0" } },
    auths: { primary: auth },
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.hidden_tools ? { hidden_tools: opts.hidden_tools } : {}),
  } as unknown as IntegrationManifest;
}

function apiSourceManifest(): IntegrationManifest {
  return {
    schema_version: "2.0",
    type: "integration",
    name: "@me/api-integ",
    version: "1.0.0",
    display_name: "API",
    source: { kind: "api", api: {} },
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

  it("attaches policy from integration.tools[name] without forcing every tool to be declared", () => {
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

  it("api source: synthesises [api_call] regardless of mcp-server tools", () => {
    const out = resolveIntegrationToolCatalog({
      integration: apiSourceManifest(),
      mcpServerTools: [{ name: "ignored" }],
    });
    expect(out).toEqual([{ name: API_CALL_TOOL_NAME }]);
  });

  it("local source without mcp-server tools: falls back to integration.tools keys", () => {
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
    // because `integration.tools{}` was treated as the whitelist.
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
    expect(errors[0]!.field).toBe("integrations.@me/integ.tools");
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
