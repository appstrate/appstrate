// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the AFPS integration manifest schema (Phase 1.0,
 * INTEGRATIONS_PROPOSAL §4.1.1). Exercises the runtime-discriminated
 * cases (entryPoint vs package vs url), D31/D32 enforcement, multi-auth
 * delivery, and dispatch through `validateManifest`.
 */

import { describe, expect, it } from "bun:test";
import {
  integrationManifestSchema,
  integrationServerTypeEnum,
  caTrustEnvEnum,
} from "../src/integration.ts";
import { validateManifest } from "../src/validation.ts";

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: "1.1",
    type: "integration",
    name: "@official/gmail",
    version: "1.0.0",
    displayName: "Gmail",
    server: {
      type: "node",
      entryPoint: "./server/index.js",
    },
    ...overrides,
  };
}

describe("integrationServerTypeEnum", () => {
  it("accepts every runtime + author sugar", () => {
    for (const t of ["node", "bun", "python", "uv", "binary", "docker", "http", "npx", "uvx"]) {
      expect(integrationServerTypeEnum.parse(t)).toBe(t as never);
    }
  });

  it("rejects unknown runtimes", () => {
    expect(() => integrationServerTypeEnum.parse("deno")).toThrow();
  });
});

describe("caTrustEnvEnum", () => {
  it("covers the documented runtime CA trust env vars", () => {
    for (const t of [
      "SSL_CERT_FILE",
      "NODE_EXTRA_CA_CERTS",
      "CURL_CA_BUNDLE",
      "REQUESTS_CA_BUNDLE",
      "NONE",
    ]) {
      expect(caTrustEnvEnum.parse(t)).toBe(t as never);
    }
  });

  it("rejects values outside the closed enum", () => {
    expect(() => caTrustEnvEnum.parse("CA_BUNDLE")).toThrow();
  });
});

describe("integrationManifestSchema — happy paths", () => {
  it("accepts the minimal node manifest", () => {
    const parsed = integrationManifestSchema.parse(baseManifest());
    expect(parsed.type).toBe("integration");
    expect(parsed.server.type).toBe("node");
    expect(parsed.server.entryPoint).toBe("./server/index.js");
  });

  it("accepts a docker manifest with digest", () => {
    const m = baseManifest({
      server: {
        type: "docker",
        package: {
          registryType: "oci",
          identifier: "ghcr.io/vendor/mcp-server",
          digest: "sha256:" + "a".repeat(64),
        },
      },
    });
    const parsed = integrationManifestSchema.parse(m);
    expect(parsed.server.type).toBe("docker");
    const pkg = parsed.server.package;
    expect(pkg).toBeDefined();
    if (pkg?.registryType === "oci") {
      expect(pkg.digest).toMatch(/^sha256:/);
    } else {
      throw new Error("expected oci registryType");
    }
  });

  it("accepts a remote http manifest", () => {
    const m = baseManifest({
      server: { type: "http", url: "https://api.example.com/mcp/{tenantId}" },
      transport: { type: "streamable-http" },
    });
    expect(() => integrationManifestSchema.parse(m)).not.toThrow();
  });

  it("accepts a binary manifest when httpClient is declared", () => {
    const m = baseManifest({
      server: {
        type: "binary",
        entryPoint: "./bin/foo",
        httpClient: { caTrustEnv: "SSL_CERT_FILE" },
      },
    });
    expect(() => integrationManifestSchema.parse(m)).not.toThrow();
  });

  it("accepts a binary manifest with caTrustEnv: NONE (opt-in egress unobservable)", () => {
    // The schema accepts NONE; the runtime install flow is responsible
    // for surfacing the warning + requiring explicit user opt-in.
    const m = baseManifest({
      server: {
        type: "binary",
        entryPoint: "./bin/foo",
        httpClient: { caTrustEnv: "NONE" },
      },
    });
    expect(() => integrationManifestSchema.parse(m)).not.toThrow();
  });

  it("accepts a manifest with one oauth2 auth + http delivery", () => {
    const m = baseManifest({
      auths: {
        primary: {
          type: "oauth2",
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          audience: "https://gmail.googleapis.com",
          scopes: ["gmail.send"],
          authorizedUris: ["https://gmail.googleapis.com/*"],
          delivery: {
            http: {
              headerName: "Authorization",
              headerPrefix: "Bearer ",
              valueFrom: "accessToken",
            },
          },
        },
      },
    });
    const parsed = integrationManifestSchema.parse(m);
    expect(parsed.auths?.primary?.type).toBe("oauth2");
    expect(parsed.auths?.primary?.delivery.http?.headerName).toBe("Authorization");
  });

  it("accepts multi-auth (github + linear)", () => {
    const m = baseManifest({
      auths: {
        github: {
          type: "oauth2",
          authorizationUrl: "https://github.com/login/oauth/authorize",
          tokenUrl: "https://github.com/login/oauth/access_token",
          authorizedUris: ["https://api.github.com/*"],
          delivery: { http: { valueFrom: "accessToken" } },
        },
        linear: {
          type: "oauth2",
          authorizationUrl: "https://linear.app/oauth/authorize",
          tokenUrl: "https://api.linear.app/oauth/token",
          authorizedUris: ["https://api.linear.app/*"],
          delivery: { http: { valueFrom: "accessToken" } },
        },
      },
    });
    expect(() => integrationManifestSchema.parse(m)).not.toThrow();
  });

  it("accepts an api_key auth with credentials.schema + env delivery", () => {
    const m = baseManifest({
      auths: {
        primary: {
          type: "api_key",
          authorizedUris: ["https://api.example.com/*"],
          credentials: {
            schema: {
              type: "object",
              properties: { api_key: { type: "string" } },
              required: ["api_key"],
            },
          },
          delivery: {
            env: {
              EXAMPLE_API_KEY: { from: "api_key", sensitive: true },
            },
          },
        },
      },
    });
    expect(() => integrationManifestSchema.parse(m)).not.toThrow();
  });
});

describe("integrationManifestSchema — author sugars (npx/uvx)", () => {
  it("accepts npx with package(npm) — bundler input", () => {
    const m = baseManifest({
      server: {
        type: "npx",
        package: {
          registryType: "npm",
          identifier: "@modelcontextprotocol/server-filesystem",
          version: "^1.0.0",
        },
      },
    });
    const parsed = integrationManifestSchema.parse(m);
    expect(parsed.server.type).toBe("npx");
    expect(parsed.server.package?.registryType).toBe("npm");
  });

  it("accepts npx with entryPoint — bundler output (intermediate)", () => {
    const m = baseManifest({
      server: { type: "npx", entryPoint: "./server/dist/index.js" },
    });
    expect(() => integrationManifestSchema.parse(m)).not.toThrow();
  });

  it("rejects npx with both entryPoint and package", () => {
    const m = baseManifest({
      server: {
        type: "npx",
        entryPoint: "./server/x.js",
        package: { registryType: "npm", identifier: "x", version: "1.0.0" },
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("rejects npx with neither entryPoint nor package", () => {
    const m = baseManifest({ server: { type: "npx" } });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("rejects npx with a pypi package", () => {
    const m = baseManifest({
      server: {
        type: "npx",
        package: { registryType: "pypi", identifier: "x", version: "1.0.0" },
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("accepts uvx with package(pypi)", () => {
    const m = baseManifest({
      server: {
        type: "uvx",
        package: { registryType: "pypi", identifier: "mcp-server-git", version: "0.6.2" },
      },
    });
    expect(() => integrationManifestSchema.parse(m)).not.toThrow();
  });

  it("rejects uvx with an npm package", () => {
    const m = baseManifest({
      server: {
        type: "uvx",
        package: { registryType: "npm", identifier: "x", version: "1.0.0" },
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("rejects docker with an npm package", () => {
    const m = baseManifest({
      server: {
        type: "docker",
        package: { registryType: "npm", identifier: "x", version: "1.0.0" },
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });
});

describe("integrationManifestSchema — server discrimination", () => {
  it("rejects entryPoint when type is docker", () => {
    const m = baseManifest({
      server: {
        type: "docker",
        entryPoint: "./oops.js",
        package: {
          registryType: "oci",
          identifier: "x",
          digest: "sha256:" + "a".repeat(64),
        },
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("rejects docker without a digest", () => {
    const m = baseManifest({
      server: {
        type: "docker",
        package: { registryType: "oci", identifier: "x", digest: "latest" },
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("rejects http without a url", () => {
    const m = baseManifest({ server: { type: "http" } });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("rejects node without an entryPoint", () => {
    const m = baseManifest({ server: { type: "node" } });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("rejects binary without httpClient.caTrustEnv (D32)", () => {
    const m = baseManifest({
      server: { type: "binary", entryPoint: "./bin/foo" },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message).join("|");
      expect(messages).toMatch(/D32|caTrustEnv|httpClient/);
    }
  });
});

describe("integrationManifestSchema — auth discrimination", () => {
  it("rejects oauth2 with neither explicit endpoints nor discovery", () => {
    const m = baseManifest({
      auths: {
        primary: {
          type: "oauth2",
          authorizedUris: ["https://api.example.com/*"],
          delivery: { http: { valueFrom: "accessToken" } },
        },
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("accepts oauth2 with discovery alone (RFC 9728)", () => {
    const m = baseManifest({
      auths: {
        primary: {
          type: "oauth2",
          discovery: {
            protectedResourceMetadataUrl:
              "https://api.example.com/.well-known/oauth-protected-resource",
          },
          authorizedUris: ["https://api.example.com/*"],
          delivery: { http: { valueFrom: "accessToken" } },
        },
      },
    });
    expect(() => integrationManifestSchema.parse(m)).not.toThrow();
  });

  it("rejects api_key without credentials.schema", () => {
    const m = baseManifest({
      auths: {
        primary: {
          type: "api_key",
          authorizedUris: ["https://api.example.com/*"],
          delivery: { env: { TOKEN: { from: "api_key" } } },
        },
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("rejects an auth with empty delivery", () => {
    const m = baseManifest({
      auths: {
        primary: {
          type: "oauth2",
          authorizationUrl: "https://x/a",
          tokenUrl: "https://x/t",
          authorizedUris: ["https://api.example.com/*"],
          delivery: {},
        },
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("rejects an auth with empty authorizedUris", () => {
    const m = baseManifest({
      auths: {
        primary: {
          type: "oauth2",
          authorizationUrl: "https://x/a",
          tokenUrl: "https://x/t",
          authorizedUris: [],
          delivery: { http: { valueFrom: "accessToken" } },
        },
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("rejects auth keys that don't match the required pattern", () => {
    const m = baseManifest({
      auths: {
        "Primary-Key": {
          type: "oauth2",
          authorizationUrl: "https://x/a",
          tokenUrl: "https://x/t",
          authorizedUris: ["https://api.example.com/*"],
          delivery: { http: { valueFrom: "accessToken" } },
        },
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });
});

describe("integrationManifestSchema — serverAuth", () => {
  it("rejects serverAuth on stdio transport", () => {
    const m = baseManifest({
      serverAuth: {
        type: "oauth2-mcp",
        resource: "https://mcp.vendor.com",
        discovery: "auto",
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("accepts serverAuth on streamable-http transport", () => {
    const m = baseManifest({
      server: { type: "http", url: "https://mcp.vendor.com" },
      transport: { type: "streamable-http" },
      serverAuth: {
        type: "oauth2-mcp",
        resource: "https://mcp.vendor.com",
        discovery: "auto",
      },
    });
    expect(() => integrationManifestSchema.parse(m)).not.toThrow();
  });
});

describe("integrationManifestSchema — naming + required fields", () => {
  it("rejects a non-scoped name", () => {
    const m = baseManifest({ name: "just-a-name" });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("rejects an invalid manifestVersion", () => {
    const m = baseManifest({ manifestVersion: "2.0" });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("rejects a manifest missing displayName", () => {
    const { displayName: _drop, ...rest } = baseManifest();
    const r = integrationManifestSchema.safeParse(rest);
    expect(r.success).toBe(false);
  });

  it("rejects a manifest with wrong type", () => {
    const m = baseManifest({ type: "agent" });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });
});

describe("validateManifest — dispatch to integration schema", () => {
  it("routes a valid integration manifest through the integration schema", () => {
    const res = validateManifest(baseManifest());
    expect(res.valid).toBe(true);
    if (res.valid) {
      expect(res.manifest.type).toBe("integration");
    }
  });

  it("surfaces integration-specific errors when validation fails", () => {
    const res = validateManifest(baseManifest({ server: { type: "node" } }));
    expect(res.valid).toBe(false);
    if (!res.valid) {
      const joined = res.errors.join("|");
      expect(joined).toMatch(/entryPoint/);
    }
  });
});

describe("integrationManifestSchema — author/repository union", () => {
  it("accepts author as plain string or object", () => {
    expect(() => integrationManifestSchema.parse(baseManifest({ author: "Pierre" }))).not.toThrow();
    expect(() =>
      integrationManifestSchema.parse(
        baseManifest({ author: { name: "Pierre", email: "p@x.io" } }),
      ),
    ).not.toThrow();
  });

  it("accepts repository as plain string or {type, url}", () => {
    expect(() =>
      integrationManifestSchema.parse(baseManifest({ repository: "https://x.io/r" })),
    ).not.toThrow();
    expect(() =>
      integrationManifestSchema.parse(
        baseManifest({ repository: { type: "git", url: "https://x.io/r" } }),
      ),
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────
// Niveau 2 scope model — auths.{k}.availableScopes catalog
// + top-level tools.{name} metadata
// ─────────────────────────────────────────────

describe("integrationManifestSchema — availableScopes catalog", () => {
  function oauthBase(authOverrides: Record<string, unknown> = {}): Record<string, unknown> {
    return baseManifest({
      auths: {
        primary: {
          type: "oauth2",
          authorizationUrl: "https://idp/a",
          tokenUrl: "https://idp/t",
          authorizedUris: ["https://api.example.com/*"],
          delivery: { http: { valueFrom: "accessToken" } },
          ...authOverrides,
        },
      },
    });
  }

  it("accepts a manifest with availableScopes catalog", () => {
    const m = oauthBase({
      availableScopes: [
        { value: "read", label: "Read", description: "Read everything" },
        { value: "write", label: "Write" },
      ],
    });
    const parsed = integrationManifestSchema.parse(m);
    expect(
      parsed.auths?.primary && "availableScopes" in parsed.auths.primary
        ? parsed.auths.primary.availableScopes?.length
        : 0,
    ).toBe(2);
  });

  it("rejects availableScopes items missing value", () => {
    const m = oauthBase({
      availableScopes: [{ label: "Read" }],
    });
    expect(integrationManifestSchema.safeParse(m).success).toBe(false);
  });

  it("rejects default scopes outside the catalog", () => {
    const m = oauthBase({
      scopes: ["delete"],
      availableScopes: [{ value: "read", label: "Read" }],
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
    if (!r.success) {
      const joined = r.error.issues.map((i) => i.message).join("|");
      expect(joined).toMatch(/availableScopes/);
    }
  });

  it("accepts default scopes that are a subset of the catalog", () => {
    const m = oauthBase({
      scopes: ["read"],
      availableScopes: [
        { value: "read", label: "Read" },
        { value: "write", label: "Write" },
      ],
    });
    expect(integrationManifestSchema.safeParse(m).success).toBe(true);
  });

  it("skips catalog validation when availableScopes is omitted", () => {
    const m = oauthBase({ scopes: ["any-scope-string"] });
    expect(integrationManifestSchema.safeParse(m).success).toBe(true);
  });
});

describe("integrationManifestSchema — tools.{name} metadata", () => {
  function gmailLike(toolsOverride: Record<string, unknown>): Record<string, unknown> {
    return baseManifest({
      auths: {
        primary: {
          type: "oauth2",
          authorizationUrl: "https://idp/a",
          tokenUrl: "https://idp/t",
          authorizedUris: ["https://api.example.com/*"],
          delivery: { http: {} },
          availableScopes: [
            { value: "read", label: "Read" },
            { value: "send", label: "Send" },
          ],
        },
      },
      tools: toolsOverride,
    });
  }

  it("accepts well-formed tools with requiredScopes + urlPatterns", () => {
    const m = gmailLike({
      list_messages: {
        requiredScopes: ["read"],
        urlPatterns: [{ pattern: "https://api.example.com/list", methods: ["GET"] }],
      },
    });
    expect(integrationManifestSchema.safeParse(m).success).toBe(true);
  });

  it("rejects tool names that violate the snake_case pattern", () => {
    const m = gmailLike({ "List-Messages": { requiredScopes: ["read"] } });
    expect(integrationManifestSchema.safeParse(m).success).toBe(false);
  });

  it("rejects requiredScopes not in the targeted auth catalog", () => {
    const m = gmailLike({ list_messages: { requiredScopes: ["delete"] } });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
    if (!r.success) {
      const joined = r.error.issues.map((i) => i.message).join("|");
      expect(joined).toMatch(/availableScopes/);
    }
  });

  it("rejects requiredScopes when multi-auth and requiredAuthKey is missing", () => {
    const m = baseManifest({
      auths: {
        primary: {
          type: "oauth2",
          authorizationUrl: "https://idp/a",
          tokenUrl: "https://idp/t",
          authorizedUris: ["https://api/*"],
          delivery: { http: {} },
        },
        secondary: {
          type: "oauth2",
          authorizationUrl: "https://idp2/a",
          tokenUrl: "https://idp2/t",
          authorizedUris: ["https://api2/*"],
          delivery: { http: {} },
        },
      },
      tools: { do_thing: { requiredScopes: ["x"] } },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
    if (!r.success) {
      const joined = r.error.issues.map((i) => i.message).join("|");
      expect(joined).toMatch(/requiredAuthKey/);
    }
  });

  it("rejects a requiredAuthKey that doesn't match any auths.{key}", () => {
    const m = gmailLike({
      list_messages: { requiredAuthKey: "doesnotexist", requiredScopes: ["read"] },
    });
    expect(integrationManifestSchema.safeParse(m).success).toBe(false);
  });

  it("rejects an invalid HTTP method in urlPatterns", () => {
    const m = gmailLike({
      list_messages: {
        requiredScopes: ["read"],
        urlPatterns: [{ pattern: "https://api/x", methods: ["TRACE"] }],
      },
    });
    expect(integrationManifestSchema.safeParse(m).success).toBe(false);
  });

  it("accepts tools without requiredScopes (legacy default behaviour)", () => {
    const m = gmailLike({ list_messages: {} });
    expect(integrationManifestSchema.safeParse(m).success).toBe(true);
  });
});

describe("integrationManifestSchema — system package gmail-mcp manifest", () => {
  it("validates the live integration-gmail-mcp manifest with catalog + tools", async () => {
    const path = new URL(
      "../../../scripts/system-packages/integration-gmail-mcp-1.0.0/manifest.json",
      import.meta.url,
    );
    const raw = JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
    const r = integrationManifestSchema.safeParse(raw);
    if (!r.success) {
      throw new Error(
        "gmail-mcp manifest failed validation:\n" +
          r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"),
      );
    }
    expect(r.success).toBe(true);
  });
});
