// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import Ajv from "ajv";
import mcpbV03 from "./fixtures/mcpb/mcpb-manifest-v0.3.schema.json";
import mcpbV04 from "./fixtures/mcpb/mcpb-manifest-v0.4.schema.json";
import {
  integrationFromMcpb,
  isMcpbManifest,
  mcpbFromIntegration,
  McpbProjectionError,
  type McpbManifest,
} from "../src/mcpb.ts";
import type { IntegrationManifest } from "../src/integration.ts";
import { validateManifest } from "../src/validation.ts";

const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addFormat("email", true);
ajv.addFormat("uri", true);
const validators = { "0.3": ajv.compile(mcpbV03), "0.4": ajv.compile(mcpbV04) };

function expectStrictMcpb(mcpb: McpbManifest): void {
  const validate = validators[mcpb.manifest_version];
  const ok = validate(mcpb);
  expect(validate.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
}

function expectValidIntegration(manifest: IntegrationManifest): void {
  const result = validateManifest(manifest);
  expect(result.valid ? [] : result.errors).toEqual([]);
}

const FETCH_MCPB = {
  manifest_version: "0.3",
  name: "Fetch JSON",
  display_name: "Fetch JSON",
  version: "1.2.0",
  description: "Fetches JSON documents",
  author: { name: "Example" },
  license: "MIT",
  keywords: ["http"],
  server: {
    type: "node",
    entry_point: "server/index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/index.js", "--timeout=${user_config.timeout}"],
      env: {
        API_KEY: "${user_config.api_key}",
        AUTH_HEADER: "Bearer ${user_config.api_key}",
        LOG_LEVEL: "info",
      },
    },
  },
  tools: [{ name: "fetch_json", description: "Fetch a JSON document" }],
  user_config: {
    api_key: {
      type: "string",
      title: "API key",
      description: "Upstream key",
      sensitive: true,
      required: true,
    },
    timeout: { type: "number", title: "Timeout", description: "Seconds", default: 30 },
  },
};

function localIntegration(overrides: Record<string, unknown> = {}): IntegrationManifest {
  return {
    name: "@acme/fetch-json",
    version: "1.2.0",
    type: "integration",
    schema_version: "0.3",
    display_name: "Fetch JSON",
    description: "Fetches JSON documents",
    author: "Acme",
    source: {
      kind: "local",
      server: {
        type: "node",
        entry_point: "server/index.js",
        mcp_config: { command: "node", args: ["server/index.js"], env: { LOG_LEVEL: "info" } },
        tools: [{ name: "fetch_json", description: "Fetch a JSON document" }],
      },
    },
    auths: {
      primary: {
        type: "custom",
        credentials: {
          schema: {
            type: "object",
            properties: { api_key: { type: "string", title: "API key", writeOnly: true } },
            required: ["api_key"],
          },
        },
        delivery: { env: { API_KEY: { value: "{$credential.api_key}", sensitive: true } } },
      },
    },
    ...overrides,
  } as unknown as IntegrationManifest;
}

describe("isMcpbManifest", () => {
  it("tells an MCPB manifest from an AFPS one", () => {
    expect(isMcpbManifest(FETCH_MCPB)).toBe(true);
    expect(isMcpbManifest(localIntegration())).toBe(false);
    expect(isMcpbManifest({ dxt_version: "0.1", name: "x" })).toBe(true);
    expect(isMcpbManifest(null)).toBe(false);
  });
});

describe("integrationFromMcpb", () => {
  it("builds a valid local integration: sensitive entries become credentials delivered in env", () => {
    const manifest = integrationFromMcpb(FETCH_MCPB, "acme");
    expectValidIntegration(manifest);
    const m = manifest as unknown as Record<string, any>;
    expect(m.name).toBe("@acme/fetch-json");
    expect(m.author).toBe("Example");
    expect(m.source.server).toEqual({
      type: "node",
      entry_point: "server/index.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/index.js", "--timeout=30"],
        env: { LOG_LEVEL: "info" },
      },
      tools: [{ name: "fetch_json", description: "Fetch a JSON document" }],
    });
    expect(m.auths.primary.credentials.schema).toEqual({
      type: "object",
      properties: {
        api_key: { type: "string", title: "API key", description: "Upstream key", writeOnly: true },
      },
      required: ["api_key"],
    });
    expect(m.auths.primary.delivery.env).toEqual({
      API_KEY: { value: "{$credential.api_key}", sensitive: true },
      AUTH_HEADER: { value: "Bearer {$credential.api_key}", sensitive: true },
    });
  });

  it("declares no auth when nothing is sensitive", () => {
    const manifest = integrationFromMcpb(
      {
        ...FETCH_MCPB,
        user_config: undefined,
        server: {
          ...FETCH_MCPB.server,
          mcp_config: { command: "node", args: ["server/index.js"] },
        },
      },
      "acme",
    );
    expectValidIntegration(manifest);
    expect((manifest as unknown as Record<string, unknown>).auths).toBeUndefined();
  });

  it("refuses a non-sensitive setting with no default", () => {
    expect(() =>
      integrationFromMcpb(
        {
          ...FETCH_MCPB,
          user_config: { region: { type: "string", title: "Region", description: "r" } },
        },
        "acme",
      ),
    ).toThrow(/user_config\.region is not sensitive and has no default/);
  });

  it("refuses a credential referenced from args", () => {
    const mcpb = structuredClone(FETCH_MCPB);
    mcpb.server.mcp_config.args.push("--key=${user_config.api_key}");
    expect(() => integrationFromMcpb(mcpb, "acme")).toThrow(McpbProjectionError);
  });

  it("refuses a manifest missing a required MCPB field", () => {
    const { author: _author, ...withoutAuthor } = FETCH_MCPB;
    expect(() => integrationFromMcpb(withoutAuthor, "acme")).toThrow(/author\.name/);
  });
});

describe("mcpbFromIntegration", () => {
  it("emits a strict MCPB manifest (official schema) with env credentials as user_config", () => {
    const mcpb = mcpbFromIntegration(localIntegration());
    expectStrictMcpb(mcpb);
    expect(mcpb.manifest_version).toBe("0.3");
    expect(mcpb.name).toBe("fetch-json");
    expect(mcpb.author).toEqual({ name: "Acme" });
    expect(mcpb.server.mcp_config.env).toEqual({
      LOG_LEVEL: "info",
      API_KEY: "${user_config.api_key}",
    });
    expect(mcpb.user_config).toEqual({
      api_key: {
        type: "string",
        title: "API key",
        description: "API key",
        sensitive: true,
        required: true,
      },
    });
    expect(mcpb.tools).toEqual([{ name: "fetch_json", description: "Fetch a JSON document" }]);
  });

  it("asks once for a credential several variables receive, and keeps a composite value", () => {
    const manifest = localIntegration();
    (manifest as unknown as Record<string, any>).auths.primary.delivery.env = {
      API_KEY: { value: "{$credential.api_key}", sensitive: true },
      AUTH_HEADER: { value: "Bearer {$credential.api_key}" },
    };
    const mcpb = mcpbFromIntegration(manifest);
    expectStrictMcpb(mcpb);
    expect(mcpb.server.mcp_config.env).toEqual({
      LOG_LEVEL: "info",
      API_KEY: "${user_config.api_key}",
      AUTH_HEADER: "Bearer ${user_config.api_key}",
    });
    expect(Object.keys(mcpb.user_config ?? {})).toEqual(["api_key"]);
    expect(mcpb.user_config?.api_key?.sensitive).toBe(true);
  });

  it("uses manifest_version 0.4 for a uv server", () => {
    const manifest = localIntegration();
    (manifest as unknown as Record<string, any>).source.server.type = "uv";
    const mcpb = mcpbFromIntegration(manifest);
    expect(mcpb.manifest_version).toBe("0.4");
    expectStrictMcpb(mcpb);
  });

  it("emits an unauthenticated integration with no user_config", () => {
    const mcpb = mcpbFromIntegration(localIntegration({ auths: undefined }));
    expectStrictMcpb(mcpb);
    expect(mcpb.user_config).toBeUndefined();
  });

  it("keeps icon only when it is a PNG shipped in the archive", () => {
    const manifest = localIntegration({ icon: "icon.png" });
    expect(mcpbFromIntegration(manifest).icon).toBeUndefined();
    expect(mcpbFromIntegration(manifest, new Set(["icon.png"])).icon).toBe("icon.png");
    expect(
      mcpbFromIntegration(localIntegration({ icon: "mdi:web" }), new Set(["mdi:web"])).icon,
    ).toBeUndefined();
  });

  it("refuses what MCPB cannot carry", () => {
    const http = localIntegration();
    (http as unknown as Record<string, any>).auths.primary.delivery = {
      http: { in: "header", name: "Authorization", value: "{$credential.api_key}" },
    };
    expect(() => mcpbFromIntegration(http)).toThrow(/over HTTP or as a file/);
    const two = localIntegration();
    (two as unknown as Record<string, any>).auths.secondary = (
      two as unknown as Record<string, any>
    ).auths.primary;
    expect(() => mcpbFromIntegration(two)).toThrow(/more than one auth method/);
    expect(() =>
      mcpbFromIntegration(localIntegration({ variables: { schema: { type: "object" } } })),
    ).toThrow(/connection variables/);
    expect(() => mcpbFromIntegration(localIntegration({ source: { kind: "none" } }))).toThrow(
      /source\.kind is local/,
    );
  });
});

describe("round trip", () => {
  it("import → export → import is stable", () => {
    const first = integrationFromMcpb(FETCH_MCPB, "acme");
    const exported = mcpbFromIntegration(first);
    expectStrictMcpb(exported);
    const second = integrationFromMcpb(exported, "acme");
    expectValidIntegration(second);
    expect(second).toEqual(first);
    expect(mcpbFromIntegration(second)).toEqual(exported);
  });
});
