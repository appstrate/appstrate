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
  apiUploadToolNameFor,
  isApiCallToolName,
  isApiUploadToolName,
  API_CALL_TOOL_NAME,
  API_UPLOAD_TOOL_NAME,
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

function apiKeyAuth(): Record<string, unknown> {
  return {
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
}

/**
 * Serverless integration: no MCP backing, api_call exposed via the
 * `_meta["dev.appstrate/api"]` vendor extension (orthogonal to source.kind).
 * `metaAuths` overrides the opted-in auth map — pass `upload_protocols` to
 * reproduce `@appstrate/google-drive`'s shape.
 */
function apiSourceManifest(
  opts: {
    metaAuths?: Record<string, unknown>;
    auths?: Record<string, unknown>;
    hidden_tools?: string[];
  } = {},
): IntegrationManifest {
  return {
    schema_version: "0.1",
    type: "integration",
    name: "@me/api-integ",
    version: "1.0.0",
    display_name: "API",
    source: { kind: "none" },
    _meta: { "dev.appstrate/api": { auths: opts.metaAuths ?? { primary: {} } } },
    auths: opts.auths ?? { primary: apiKeyAuth() },
    ...(opts.hidden_tools ? { hidden_tools: opts.hidden_tools } : {}),
  } as unknown as IntegrationManifest;
}

/** The `@appstrate/google-drive` shape: one auth, one declared upload protocol. */
function driveLikeManifest(): IntegrationManifest {
  return apiSourceManifest({ metaAuths: { primary: { upload_protocols: ["google-resumable"] } } });
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
            required_scopes: { primary: ["read"] },
          },
        },
      }),
      mcpServerTools: [{ name: "kv_set" }, { name: "fetch_echo" }],
    });
    expect(out).toHaveLength(2);
    const fetchEcho = out.find((e) => e.name === "fetch_echo")!;
    expect(fetchEcho.policy?.required_scopes).toEqual({ primary: ["read"] });
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

  it("gives a declared synthetic capability precedence over same-named native tools", () => {
    const integration = localSourceManifest({});
    (integration as unknown as { _meta: unknown })._meta = {
      "dev.appstrate/api": {
        auths: { primary: { upload_protocols: ["google-resumable"] } },
      },
    };
    const out = resolveIntegrationToolCatalog({
      integration,
      mcpServerTools: [
        { name: "api_call", description: "native collision" },
        { name: "api-call", description: "normalised native collision" },
        { name: "api_upload", description: "native collision" },
        { name: "drive__api.upload", description: "namespaced native collision" },
        { name: "kv_get" },
      ],
    });
    expect(out).toEqual([
      { name: "kv_get" },
      { name: API_CALL_TOOL_NAME },
      { name: API_UPLOAD_TOOL_NAME },
    ]);
  });

  it("keeps native api-like names when no synthetic capability is declared", () => {
    const out = resolveIntegrationToolCatalog({
      integration: localSourceManifest({}),
      mcpServerTools: [{ name: "api_call" }, { name: "api_upload" }],
    });
    expect(out.map((entry) => entry.name)).toEqual(["api_call", "api_upload"]);
  });

  it("reserves persisted long-key aliases against native MCP collisions", () => {
    const longAuthKey = "authentication_key_that_is_valid_but_long";
    const integration = localSourceManifest({});
    (integration as unknown as { auths: Record<string, unknown> }).auths = {
      short: apiKeyAuth(),
      [longAuthKey]: apiKeyAuth(),
    };
    (integration as unknown as { _meta: unknown })._meta = {
      "dev.appstrate/api": {
        auths: {
          short: {},
          [longAuthKey]: { upload_protocols: ["google-resumable"] },
        },
      },
    };
    const out = resolveIntegrationToolCatalog({
      integration,
      mcpServerTools: [
        { name: `api_call__${longAuthKey}`, description: "legacy native collision" },
        { name: `api_upload__${longAuthKey}`, description: "legacy native collision" },
        { name: "native_keep" },
      ],
    });
    expect(out.map((entry) => entry.name)).toEqual([
      "native_keep",
      "api_call__short",
      "api_call__h0a0593260c3968fd8",
      "api_upload__h0a0593260c3968fd8",
    ]);
  });

  // Regression — issue #881. `@appstrate/google-drive` declares
  // `upload_protocols`, so the sidecar advertises `{ns}__api_upload` at runtime,
  // but the catalog only listed `api_call`. The picker couldn't show the tool
  // and `validateAgentIntegrationScopes` rejected it as `unknown_tool`.
  it("none source with upload_protocols: appends the api_upload companion after api_call", () => {
    const out = resolveIntegrationToolCatalog({ integration: driveLikeManifest() });
    expect(out).toEqual([{ name: API_CALL_TOOL_NAME }, { name: API_UPLOAD_TOOL_NAME }]);
  });

  it("none source WITHOUT upload_protocols: no api_upload companion", () => {
    const out = resolveIntegrationToolCatalog({ integration: apiSourceManifest() });
    expect(out).toEqual([{ name: API_CALL_TOOL_NAME }]);
  });

  it("multi-auth: each opted-in auth gets its own api_call + api_upload pair", () => {
    const integration = apiSourceManifest({
      auths: { primary: apiKeyAuth(), backup: apiKeyAuth() },
      metaAuths: {
        primary: { upload_protocols: ["google-resumable"] },
        // `backup` declares none → api_call only, no companion.
        backup: {},
      },
    });
    expect(resolveIntegrationToolCatalog({ integration }).map((e) => e.name)).toEqual([
      "api_call__primary",
      "api_upload__primary",
      "api_call__backup",
    ]);
  });

  it("an opted-in _meta auth with no matching auths.{key} contributes nothing", () => {
    const integration = apiSourceManifest({
      metaAuths: { ghost: { upload_protocols: ["tus"] } },
    });
    expect(resolveIntegrationToolCatalog({ integration })).toEqual([]);
  });

  it("hidden_tools can hide the api_upload companion without hiding api_call", () => {
    const integration = apiSourceManifest({
      metaAuths: { primary: { upload_protocols: ["tus"] } },
      hidden_tools: [API_UPLOAD_TOOL_NAME],
    });
    expect(resolveIntegrationToolCatalog({ integration }).map((e) => e.name)).toEqual([
      API_CALL_TOOL_NAME,
    ]);
  });

  it("hidden_tools hiding api_call also hides its dependent api_upload companion", () => {
    const integration = apiSourceManifest({
      metaAuths: { primary: { upload_protocols: ["tus"] } },
      hidden_tools: [API_CALL_TOOL_NAME],
    });
    expect(resolveIntegrationToolCatalog({ integration })).toEqual([]);
  });

  it("multi-auth hidden_tools cascades per pair without hiding the other auth's api_call", () => {
    const integration = apiSourceManifest({
      auths: { primary: apiKeyAuth(), backup: apiKeyAuth() },
      metaAuths: {
        primary: { upload_protocols: ["google-resumable"] },
        backup: { upload_protocols: ["tus"] },
      },
      // Hiding the primary call removes its dependent upload. Hiding only the
      // backup upload intentionally leaves the backup call available.
      hidden_tools: ["api_call__primary", "api_upload__backup"],
    });
    expect(resolveIntegrationToolCatalog({ integration }).map((e) => e.name)).toEqual([
      "api_call__backup",
    ]);
  });

  it("local source WITH upload_protocols: the pair is appended after the mcp tools", () => {
    const integration = localSourceManifest({});
    (integration as unknown as { _meta: unknown })._meta = {
      "dev.appstrate/api": { auths: { primary: { upload_protocols: ["s3-multipart"] } } },
    };
    const out = resolveIntegrationToolCatalog({
      integration,
      mcpServerTools: [{ name: "kv_set" }],
    });
    expect(out.map((e) => e.name)).toEqual(["kv_set", API_CALL_TOOL_NAME, API_UPLOAD_TOOL_NAME]);
  });

  it("local source without mcp-server tools: falls back to integration.tools_policy keys", () => {
    const out = resolveIntegrationToolCatalog({
      integration: localSourceManifest({
        tools: { policy_only: { required_scopes: { primary: ["read"] } } },
      }),
    });
    expect(out.map((e) => e.name)).toEqual(["policy_only"]);
    expect(out[0]!.policy?.required_scopes).toEqual({ primary: ["read"] });
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
        tools: { fetch_echo: { required_scopes: { primary: ["read"] } } }, // policy only for one tool
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

  // Regression — issue #881: importing an agent that selected `api_upload`
  // failed with `unknown_tool` even though the runtime exposed the tool.
  it("api source with upload_protocols: accepts api_upload", () => {
    const errors = validateAgentIntegrationScopes(
      { id: "@me/api-integ", tools: [API_CALL_TOOL_NAME, API_UPLOAD_TOOL_NAME] },
      driveLikeManifest(),
    );
    expect(errors).toEqual([]);
  });

  it("api source without upload_protocols: still rejects api_upload", () => {
    const errors = validateAgentIntegrationScopes(
      { id: "@me/api-integ", tools: [API_UPLOAD_TOOL_NAME] },
      apiSourceManifest(),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("unknown_tool");
  });
});

describe("api_call / api_upload tool-name helpers", () => {
  it("derives the companion name for the bare and per-auth forms", () => {
    expect(apiUploadToolNameFor(API_CALL_TOOL_NAME)).toBe(API_UPLOAD_TOOL_NAME);
    expect(apiUploadToolNameFor("api_call__primary")).toBe("api_upload__primary");
  });

  // Lockstep guard: `runtime-pi/sidecar/mcp.ts` derives the advertised upload
  // tool name with this exact substitution. If the two drift, the catalog and
  // runtime advertise different names even though dispatch pairing itself is
  // marker-driven and namespace-scoped.
  it("matches the sidecar's own derivation", () => {
    for (const name of [API_CALL_TOOL_NAME, "api_call__primary", "api_call__backup"]) {
      expect(apiUploadToolNameFor(name)).toBe(name.replace(/^api_call/, "api_upload"));
    }
  });

  it("classifies both families without overlap", () => {
    for (const name of [API_CALL_TOOL_NAME, "api_call__k"]) {
      expect(isApiCallToolName(name)).toBe(true);
      expect(isApiUploadToolName(name)).toBe(false);
    }
    for (const name of [API_UPLOAD_TOOL_NAME, "api_upload__k"]) {
      expect(isApiUploadToolName(name)).toBe(true);
      expect(isApiCallToolName(name)).toBe(false);
    }
  });

  it("does not classify unrelated tools that merely share a prefix", () => {
    for (const name of ["api_calls", "api_call_extra", "api_uploader", "kv_set"]) {
      expect(isApiCallToolName(name)).toBe(false);
      expect(isApiUploadToolName(name)).toBe(false);
    }
  });
});
