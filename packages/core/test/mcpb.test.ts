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
  type McpbProjectionErrorCode,
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

function expectRefused(run: () => unknown, code: McpbProjectionErrorCode, message?: RegExp): void {
  let caught: unknown;
  try {
    run();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(McpbProjectionError);
  expect((caught as McpbProjectionError).code).toBe(code);
  if (message) expect((caught as McpbProjectionError).message).toMatch(message);
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
    expect(m.author).toEqual({ name: "Example" });
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
    expectRefused(
      () =>
        integrationFromMcpb(
          {
            ...FETCH_MCPB,
            user_config: { region: { type: "string", title: "Region", description: "r" } },
          },
          "acme",
        ),
      "mcpb_unsupported_user_config",
      /user_config\.region is not sensitive and has no default/,
    );
  });

  it("refuses a credential referenced from args", () => {
    const mcpb = structuredClone(FETCH_MCPB);
    mcpb.server.mcp_config.args.push("--key=${user_config.api_key}");
    expectRefused(() => integrationFromMcpb(mcpb, "acme"), "mcpb_unsupported_user_config");
  });

  it("refuses a credential referenced from command", () => {
    const mcpb = structuredClone(FETCH_MCPB);
    mcpb.server.mcp_config.command = "${user_config.api_key}";
    expectRefused(() => integrationFromMcpb(mcpb, "acme"), "mcpb_unsupported_user_config");
  });

  it("refuses a credential referenced from a platform override, args or env", () => {
    for (const override of [
      { args: ["--key=${user_config.api_key}"] },
      { env: { API_KEY: "${user_config.api_key}" } },
      { command: "${user_config.api_key}" },
    ]) {
      const mcpb = structuredClone(FETCH_MCPB) as Record<string, any>;
      mcpb.server.mcp_config.platform_overrides = { linux: override };
      expectRefused(() => integrationFromMcpb(mcpb, "acme"), "mcpb_unsupported_user_config");
    }
  });

  it("inlines a non-sensitive default inside a platform override", () => {
    const mcpb = structuredClone(FETCH_MCPB) as Record<string, any>;
    mcpb.server.mcp_config.platform_overrides = {
      win32: {
        command: "node.exe",
        args: ["--timeout=${user_config.timeout}"],
        env: { TIMEOUT: "${user_config.timeout}" },
      },
    };
    const m = integrationFromMcpb(mcpb, "acme") as unknown as Record<string, any>;
    expectValidIntegration(m as unknown as IntegrationManifest);
    expect(m.source.server.mcp_config.platform_overrides).toEqual({
      win32: { command: "node.exe", args: ["--timeout=30"], env: { TIMEOUT: "30" } },
    });
  });

  it("refuses a reference to an undeclared user_config entry", () => {
    const mcpb = structuredClone(FETCH_MCPB);
    mcpb.server.mcp_config.args.push("--region=${user_config.region}");
    expectRefused(
      () => integrationFromMcpb(mcpb, "acme"),
      "mcpb_invalid_manifest",
      /user_config\.region/,
    );
  });

  it("refuses a multiple entry and a sensitive entry that is not a string", () => {
    expectRefused(
      () =>
        integrationFromMcpb(
          {
            ...FETCH_MCPB,
            user_config: {
              dirs: {
                type: "directory",
                title: "Dirs",
                description: "d",
                multiple: true,
                default: [],
              },
            },
          },
          "acme",
        ),
      "mcpb_unsupported_user_config",
      /multiple/,
    );
    expectRefused(
      () =>
        integrationFromMcpb(
          {
            ...FETCH_MCPB,
            user_config: {
              api_key: { type: "number", title: "Key", description: "k", sensitive: true },
            },
          },
          "acme",
        ),
      "mcpb_unsupported_user_config",
      /not a string/,
    );
  });

  it("refuses a sensitive key outside [A-Za-z0-9_]", () => {
    expectRefused(
      () =>
        integrationFromMcpb(
          {
            ...FETCH_MCPB,
            user_config: {
              "api-key": { type: "string", title: "Key", description: "k", sensitive: true },
            },
          },
          "acme",
        ),
      "mcpb_unsupported_user_config",
      /letters, digits and underscores/,
    );
  });

  it("refuses a placeholder left in an env value, and keeps one in args", () => {
    for (const placeholder of [
      "${__dirname}/data",
      "${HOME}",
      "${DESKTOP}",
      "${DOCUMENTS}",
      "${DOWNLOADS}",
      "a${pathSeparator}b",
      "a${/}b",
    ]) {
      const mcpb = structuredClone(FETCH_MCPB);
      (mcpb.server.mcp_config.env as Record<string, string>).DATA_DIR = placeholder;
      expectRefused(
        () => integrationFromMcpb(mcpb, "acme"),
        "mcpb_unsupported_placeholder",
        /DATA_DIR/,
      );
    }
    const inOverride = structuredClone(FETCH_MCPB) as Record<string, any>;
    inOverride.server.mcp_config.platform_overrides = { linux: { env: { D: "${__dirname}" } } };
    expectRefused(() => integrationFromMcpb(inOverride, "acme"), "mcpb_unsupported_placeholder");
    // A credential composite keeps the same rule for what surrounds the reference.
    const composite = structuredClone(FETCH_MCPB);
    composite.server.mcp_config.env.AUTH_HEADER = "${HOME}:${user_config.api_key}";
    expectRefused(() => integrationFromMcpb(composite, "acme"), "mcpb_unsupported_placeholder");
    const m = integrationFromMcpb(FETCH_MCPB, "acme") as unknown as Record<string, any>;
    expect(m.source.server.mcp_config.args[0]).toBe("${__dirname}/server/index.js");
  });

  it("accepts compatibility.platforms with linux and refuses it without", () => {
    expectRefused(
      () => integrationFromMcpb({ ...FETCH_MCPB, compatibility: { platforms: ["win32"] } }, "acme"),
      "mcpb_unsupported_platform",
    );
    expectRefused(
      () => integrationFromMcpb({ ...FETCH_MCPB, compatibility: { platforms: [] } }, "acme"),
      "mcpb_unsupported_platform",
    );
    const accepted = integrationFromMcpb(
      {
        ...FETCH_MCPB,
        compatibility: { platforms: ["darwin", "linux"], runtimes: { node: ">=20" } },
      },
      "acme",
    ) as unknown as Record<string, unknown>;
    expect(accepted.compatibility).toBeUndefined();
    expectValidIntegration(accepted as unknown as IntegrationManifest);
  });

  it("accepts any manifest_version string", () => {
    expectValidIntegration(integrationFromMcpb({ ...FETCH_MCPB, manifest_version: "9.9" }, "acme"));
  });

  it("refuses a non-string env value instead of dropping it", () => {
    const mcpb = structuredClone(FETCH_MCPB) as Record<string, any>;
    mcpb.server.mcp_config.env.RETRIES = 3;
    expectRefused(() => integrationFromMcpb(mcpb, "acme"), "mcpb_invalid_manifest", /env/);
  });

  it("refuses a manifest missing a required MCPB field", () => {
    const { author: _author, ...withoutAuthor } = FETCH_MCPB;
    expectRefused(
      () => integrationFromMcpb(withoutAuthor, "acme"),
      "mcpb_invalid_manifest",
      /author\.name/,
    );
  });

  it("keeps the author object", () => {
    const author = { name: "Example", email: "dev@example.com", url: "https://example.com" };
    const m = integrationFromMcpb({ ...FETCH_MCPB, author: { ...author, extra: 1 } }, "acme");
    expect((m as unknown as Record<string, unknown>).author).toEqual(author);
    expectValidIntegration(m);
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

  it("marks a credential sensitive whatever the delivery entry says", () => {
    const manifest = localIntegration();
    (manifest as unknown as Record<string, any>).auths.primary.delivery.env = {
      API_KEY: { value: "{$credential.api_key}", sensitive: false },
    };
    const mcpb = mcpbFromIntegration(manifest);
    expectStrictMcpb(mcpb);
    expect(mcpb.user_config?.api_key).toMatchObject({ sensitive: true, required: true });
    const reimported = integrationFromMcpb(mcpb, "acme");
    expectValidIntegration(reimported);
    expect(mcpbFromIntegration(reimported)).toEqual(mcpb);
  });

  it("picks the MCPB fields: extra keys under server and mcp_config do not reach the export", () => {
    const manifest = localIntegration();
    const server = (manifest as unknown as Record<string, any>).source.server;
    server.extra = true;
    server.mcp_config.extra = true;
    server.mcp_config.platform_overrides = {
      win32: { command: "node.exe", args: ["a"], env: { A: "b" }, extra: true },
      bad: "not an object",
    };
    const mcpb = mcpbFromIntegration(manifest);
    expectStrictMcpb(mcpb);
    expect(mcpb.server).toEqual({
      type: "node",
      entry_point: "server/index.js",
      mcp_config: {
        command: "node",
        args: ["server/index.js"],
        env: { LOG_LEVEL: "info", API_KEY: "${user_config.api_key}" },
        platform_overrides: { win32: { command: "node.exe", args: ["a"], env: { A: "b" } } },
      },
    });
  });

  it("converts the author both ways and never emits an at-sign fallback", () => {
    const object = mcpbFromIntegration(
      localIntegration({
        author: { name: "Acme", email: "dev@acme.test", url: "https://acme.test", extra: 1 },
      }),
    );
    expectStrictMcpb(object);
    expect(object.author).toEqual({
      name: "Acme",
      email: "dev@acme.test",
      url: "https://acme.test",
    });
    expect(mcpbFromIntegration(localIntegration({ author: "Acme" })).author).toEqual({
      name: "Acme",
    });
    const fallback = mcpbFromIntegration(localIntegration({ author: undefined }));
    expectStrictMcpb(fallback);
    expect(fallback.author).toEqual({ name: "acme" });
  });

  it("refuses delivery over HTTP", () => {
    const http = localIntegration();
    (http as unknown as Record<string, any>).auths.primary.delivery = {
      http: { in: "header", name: "Authorization", value: "{$credential.api_key}" },
    };
    expectRefused(
      () => mcpbFromIntegration(http),
      "mcpb_unsupported_auth",
      /over HTTP or as a file/,
    );
  });

  it("refuses delivery as a file", () => {
    const files = localIntegration();
    (files as unknown as Record<string, any>).auths.primary.delivery = {
      files: [{ path: "key.txt", value: "{$credential.api_key}" }],
    };
    expectRefused(
      () => mcpbFromIntegration(files),
      "mcpb_unsupported_auth",
      /over HTTP or as a file/,
    );
  });

  it("refuses a second auth method, connection variables and a non-local source", () => {
    const two = localIntegration();
    (two as unknown as Record<string, any>).auths.secondary = (
      two as unknown as Record<string, any>
    ).auths.primary;
    expectRefused(
      () => mcpbFromIntegration(two),
      "mcpb_unsupported_auth",
      /more than one auth method/,
    );
    expectRefused(
      () => mcpbFromIntegration(localIntegration({ variables: { schema: { type: "object" } } })),
      "mcpb_unsupported_variables",
      /connection variables/,
    );
    expectRefused(
      () => mcpbFromIntegration(localIntegration({ source: { kind: "none" } })),
      "mcpb_not_local",
      /source\.kind is local/,
    );
  });

  it("refuses a local server without mcp_config.command as not local", () => {
    const manifest = localIntegration();
    delete (manifest as unknown as Record<string, any>).source.server.mcp_config;
    expectRefused(() => mcpbFromIntegration(manifest), "mcpb_not_local");
    const noCommand = localIntegration();
    delete (noCommand as unknown as Record<string, any>).source.server.mcp_config.command;
    expectRefused(() => mcpbFromIntegration(noCommand), "mcpb_not_local");
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
