// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the AFPS integration manifest schema (Phase 1.0,
 * INTEGRATIONS_PROPOSAL §4.1.1). Exercises the runtime-discriminated
 * cases (entryPoint vs package vs url), D31/D32 enforcement, multi-auth
 * delivery, and dispatch through `validateManifest`.
 */

import { describe, expect, it } from "bun:test";
import {
  expandScopesGranted,
  missingScopesForConnection,
  integrationManifestSchema,
  integrationServerTypeEnum,
  getAvailableScopes,
  getDeclaredToolNames,
  getApiCallConfig,
  API_CALL_TOOL_NAME,
  validateAgentIntegrationScopes,
  requiredAuthKeysForAgent,
  requiredScopesForAgent,
  type IntegrationManifest,
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

describe("integrationManifestSchema — happy paths", () => {
  it("accepts the minimal node manifest", () => {
    const parsed = integrationManifestSchema.parse(baseManifest());
    expect(parsed.type).toBe("integration");
    expect(parsed.server!.type).toBe("node");
    expect(parsed.server!.entryPoint).toBe("./server/index.js");
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
    expect(parsed.server!.type).toBe("docker");
    const pkg = parsed.server!.package;
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
    });
    expect(() => integrationManifestSchema.parse(m)).not.toThrow();
  });

  it("accepts a minimal binary manifest", () => {
    const m = baseManifest({
      server: { type: "binary", entryPoint: "./bin/foo" },
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
    expect(parsed.server!.type).toBe("npx");
    expect(parsed.server!.package?.registryType).toBe("npm");
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

  it("accepts implies referencing other catalog values", () => {
    const m = oauthBase({
      availableScopes: [
        { value: "read", label: "Read" },
        { value: "write", label: "Write", implies: ["read"] },
        { value: "admin", label: "Admin", implies: ["write", "read"] },
      ],
    });
    expect(integrationManifestSchema.safeParse(m).success).toBe(true);
  });

  it("rejects implies referencing a value not in the catalog", () => {
    const m = oauthBase({
      availableScopes: [
        { value: "read", label: "Read" },
        { value: "write", label: "Write", implies: ["ghost"] },
      ],
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message).join("|")).toMatch(/ghost/);
    }
  });

  it("rejects self-imply", () => {
    const m = oauthBase({
      availableScopes: [{ value: "read", label: "Read", implies: ["read"] }],
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message).join("|")).toMatch(/cannot imply itself/);
    }
  });
});

describe("expandScopesGranted", () => {
  function manifestWithImplies(): IntegrationManifest {
    return integrationManifestSchema.parse({
      manifestVersion: "1.1",
      type: "integration",
      name: "@official/github",
      version: "1.0.0",
      displayName: "GitHub",
      server: { type: "node", entryPoint: "./server/index.js" },
      auths: {
        oauth: {
          type: "oauth2",
          authorizationUrl: "https://github.com/login/oauth/authorize",
          tokenUrl: "https://github.com/login/oauth/access_token",
          authorizedUris: ["https://api.github.com/*"],
          delivery: { http: { valueFrom: "accessToken" } },
          availableScopes: [
            { value: "read:org", label: "Read orgs" },
            { value: "write:org", label: "Write orgs", implies: ["read:org"] },
            { value: "admin:org", label: "Admin orgs", implies: ["write:org", "read:org"] },
            { value: "public_repo", label: "Public repos" },
            { value: "repo", label: "All repos", implies: ["public_repo"] },
          ],
        },
      },
    });
  }

  it("returns granted verbatim (deduplicated) when the auth has no catalog", () => {
    const m = integrationManifestSchema.parse({
      manifestVersion: "1.1",
      type: "integration",
      name: "@official/x",
      version: "1.0.0",
      displayName: "X",
      server: { type: "node", entryPoint: "./server/index.js" },
      auths: {
        oauth: {
          type: "oauth2",
          authorizationUrl: "https://i/a",
          tokenUrl: "https://i/t",
          authorizedUris: ["https://api.example.com/*"],
          delivery: { http: { valueFrom: "accessToken" } },
        },
      },
    });
    expect(expandScopesGranted(["x", "y", "x"], m, "oauth").sort()).toEqual(["x", "y"]);
  });

  it("expands one-hop implications", () => {
    const m = manifestWithImplies();
    expect(expandScopesGranted(["repo"], m, "oauth").sort()).toEqual(["public_repo", "repo"]);
  });

  it("expands transitively (admin:org → write:org → read:org)", () => {
    const m = manifestWithImplies();
    expect(expandScopesGranted(["admin:org"], m, "oauth").sort()).toEqual([
      "admin:org",
      "read:org",
      "write:org",
    ]);
  });

  it("returns granted unchanged when no implies declared", () => {
    const m = manifestWithImplies();
    expect(expandScopesGranted(["read:org"], m, "oauth").sort()).toEqual(["read:org"]);
  });

  it("returns granted verbatim for an unknown auth key", () => {
    const m = manifestWithImplies();
    expect(expandScopesGranted(["whatever"], m, "ghost-auth")).toEqual(["whatever"]);
  });
});

describe("missingScopesForConnection", () => {
  // One integration, two auths: an oauth2 auth that carries a scope catalog
  // and an api_key auth that does not. Scopes only apply to the oauth2 side.
  function dualAuthManifest(): IntegrationManifest {
    return integrationManifestSchema.parse({
      manifestVersion: "1.1",
      type: "integration",
      name: "@official/github",
      version: "1.0.0",
      displayName: "GitHub",
      server: { type: "node", entryPoint: "./server/index.js" },
      auths: {
        oauth: {
          type: "oauth2",
          authorizationUrl: "https://github.com/login/oauth/authorize",
          tokenUrl: "https://github.com/login/oauth/access_token",
          authorizedUris: ["https://api.github.com/*"],
          delivery: { http: { valueFrom: "accessToken" } },
          availableScopes: [
            { value: "read:org", label: "Read orgs" },
            { value: "write:org", label: "Write orgs", implies: ["read:org"] },
          ],
        },
        token: {
          type: "api_key",
          authorizedUris: ["https://api.github.com/*"],
          credentials: {
            schema: {
              type: "object",
              properties: { api_key: { type: "string" } },
              required: ["api_key"],
            },
          },
          delivery: { env: { GITHUB_TOKEN: { from: "api_key", sensitive: true } } },
        },
      },
    });
  }

  it("reports scopes the oauth2 connection's grant lacks", () => {
    const m = dualAuthManifest();
    expect(
      missingScopesForConnection({
        manifest: m,
        authKey: "oauth",
        granted: ["read:org"],
        agentTools: undefined,
        agentScopes: ["read:org", "write:org"],
      }),
    ).toEqual(["write:org"]);
  });

  it("returns [] for an oauth2 connection that already covers the required scopes", () => {
    const m = dualAuthManifest();
    // `write:org` implies `read:org`, so a grant of write:org covers both.
    expect(
      missingScopesForConnection({
        manifest: m,
        authKey: "oauth",
        granted: ["write:org"],
        agentTools: undefined,
        agentScopes: ["read:org", "write:org"],
      }),
    ).toEqual([]);
  });

  it("returns [] for a non-oauth2 (api_key) connection even when the agent declares scopes", () => {
    const m = dualAuthManifest();
    // api_key auths grant access wholesale — scopes are an OAuth2 concept and
    // never apply, so the agent's declared scopes are never "missing" here.
    expect(
      missingScopesForConnection({
        manifest: m,
        authKey: "token",
        granted: [],
        agentTools: undefined,
        agentScopes: ["read:org", "write:org"],
      }),
    ).toEqual([]);
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

// ─────────────────────────────────────────────
// Niveau 2 Phase 1 — install-time validation helpers
// (pure functions consumed by the apps/api scope-validation service)
// ─────────────────────────────────────────────

describe("getAvailableScopes / getDeclaredToolNames", () => {
  function gmailManifest(): IntegrationManifest {
    return integrationManifestSchema.parse(
      baseManifest({
        auths: {
          primary: {
            type: "oauth2",
            authorizationUrl: "https://idp/a",
            tokenUrl: "https://idp/t",
            authorizedUris: ["https://api/*"],
            delivery: { http: {} },
            availableScopes: [
              { value: "read", label: "Read" },
              { value: "write", label: "Write" },
            ],
          },
        },
        tools: {
          list_messages: { requiredScopes: ["read"] },
          send_message: { requiredScopes: ["write"] },
          ping: {},
        },
      }),
    );
  }

  it("getAvailableScopes returns the union of catalog values across auths", () => {
    const m = gmailManifest();
    expect([...getAvailableScopes(m)].sort()).toEqual(["read", "write"]);
  });

  it("getAvailableScopes returns [] when no auth declares a catalog", () => {
    const m = integrationManifestSchema.parse(baseManifest()); // no auths
    expect(getAvailableScopes(m)).toEqual([]);
  });

  it("getDeclaredToolNames returns the keys of the top-level tools record", () => {
    const m = gmailManifest();
    expect([...getDeclaredToolNames(m)].sort()).toEqual(["list_messages", "ping", "send_message"]);
  });

  it("getDeclaredToolNames returns [] for manifests without a tools block", () => {
    const m = integrationManifestSchema.parse(baseManifest());
    expect(getDeclaredToolNames(m)).toEqual([]);
  });
});

describe("validateAgentIntegrationScopes", () => {
  function catalogedManifest(): IntegrationManifest {
    return integrationManifestSchema.parse(
      baseManifest({
        auths: {
          primary: {
            type: "oauth2",
            authorizationUrl: "https://idp/a",
            tokenUrl: "https://idp/t",
            authorizedUris: ["https://api/*"],
            delivery: { http: {} },
            availableScopes: [
              { value: "read", label: "Read" },
              { value: "write", label: "Write" },
            ],
          },
        },
        tools: {
          list_messages: { requiredScopes: ["read"] },
          send_message: { requiredScopes: ["write"] },
        },
      }),
    );
  }

  it("returns no errors when selection is empty (legacy bare-version-string case)", () => {
    expect(validateAgentIntegrationScopes({ id: "@a/i" }, catalogedManifest())).toEqual([]);
  });

  it("accepts a subset selection of declared tools and catalog scopes", () => {
    const errors = validateAgentIntegrationScopes(
      { id: "@a/i", tools: ["list_messages"], scopes: ["read"] },
      catalogedManifest(),
    );
    expect(errors).toEqual([]);
  });

  it("flags an unknown tool selected by the agent", () => {
    const errors = validateAgentIntegrationScopes(
      { id: "@a/i", tools: ["list_messages", "delete_message"] },
      catalogedManifest(),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("unknown_tool");
    expect(errors[0]!.field).toBe("integrations.@a/i.tools");
    expect(errors[0]!.message).toContain("delete_message");
  });

  it("flags every scope outside the catalog (accumulates errors)", () => {
    const errors = validateAgentIntegrationScopes(
      { id: "@a/i", scopes: ["read", "admin", "root"] },
      catalogedManifest(),
    );
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.code === "scope_not_in_catalog")).toBe(true);
    expect(errors.map((e) => e.message).join(" ")).toMatch(/admin/);
    expect(errors.map((e) => e.message).join(" ")).toMatch(/root/);
  });

  it("skips tool subset check when the integration declares no tools block", () => {
    const noTools = integrationManifestSchema.parse(
      baseManifest({
        auths: {
          primary: {
            type: "oauth2",
            authorizationUrl: "https://idp/a",
            tokenUrl: "https://idp/t",
            authorizedUris: ["https://api/*"],
            delivery: { http: {} },
            availableScopes: [{ value: "read", label: "Read" }],
          },
        },
      }),
    );
    const errors = validateAgentIntegrationScopes(
      { id: "@a/i", tools: ["anything_goes"] },
      noTools,
    );
    expect(errors).toEqual([]);
  });

  it("skips scope subset check when no auth declares a catalog", () => {
    const noCatalog = integrationManifestSchema.parse(
      baseManifest({
        auths: {
          primary: {
            type: "oauth2",
            authorizationUrl: "https://idp/a",
            tokenUrl: "https://idp/t",
            authorizedUris: ["https://api/*"],
            delivery: { http: {} },
          },
        },
      }),
    );
    const errors = validateAgentIntegrationScopes(
      { id: "@a/i", scopes: ["anything-the-idp-accepts"] },
      noCatalog,
    );
    expect(errors).toEqual([]);
  });

  it("accepts the synthetic api_call tool alongside native tools (attachable apiCall)", () => {
    const m = integrationManifestSchema.parse(
      baseManifest({
        server: { type: "node", entryPoint: "./server.js" },
        auths: {
          session: {
            type: "custom",
            authorizedUris: ["https://api.example.com/**"],
            credentials: { schema: { type: "object", required: ["token"] } },
            delivery: { http: { headerName: "Authorization", valueFrom: "accessToken" } },
          },
        },
        tools: { whoami: { requiredAuthKey: "session" } },
        apiCall: { authKey: "session" },
      }),
    );
    // api_call is synthetic (not in `tools`) but valid because the manifest
    // declares an apiCall capability; whoami is a native tool.
    expect(
      validateAgentIntegrationScopes({ id: "@a/kijiji", tools: ["whoami", "api_call"] }, m),
    ).toEqual([]);
  });

  it("still flags api_call when the integration declares no apiCall capability", () => {
    const errors = validateAgentIntegrationScopes(
      { id: "@a/i", tools: ["api_call"] },
      catalogedManifest(),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("unknown_tool");
  });
});

describe("integrationManifestSchema — apiCall capability (generic credential-injecting tool)", () => {
  const oauthAuth = {
    type: "oauth2" as const,
    authorizationUrl: "https://idp/a",
    tokenUrl: "https://idp/t",
    authorizedUris: ["https://api.example.com/*"],
    delivery: { http: {} },
  };

  it("accepts a serverless apiCall integration (migrated-provider shape)", () => {
    const m = baseManifest({
      server: undefined,
      apiCall: { authKey: "primary" },
      auths: { primary: oauthAuth },
    });
    const parsed = integrationManifestSchema.parse(m);
    expect(parsed.server).toBeUndefined();
    expect(getApiCallConfig(parsed)).not.toBeNull();
  });

  it("accepts apiCall alongside a spawned server (attachable shape)", () => {
    const m = baseManifest({
      apiCall: { authKey: "primary" },
      auths: { primary: oauthAuth },
    });
    const parsed = integrationManifestSchema.parse(m);
    expect(parsed.server!.type).toBe("node");
    expect(getApiCallConfig(parsed)?.authKey).toBe("primary");
  });

  it("an MCP server integration with no apiCall block does not expose api_call", () => {
    const m = baseManifest({ auths: { primary: oauthAuth } });
    const parsed = integrationManifestSchema.parse(m);
    expect(parsed.server!.type).toBe("node");
    expect(getApiCallConfig(parsed)).toBeNull();
  });

  it("rejects an integration with neither server nor apiCall", () => {
    const r = integrationManifestSchema.safeParse(baseManifest({ server: undefined }));
    expect(r.success).toBe(false);
  });

  it("rejects an apiCall block whose authKey matches no declared auth", () => {
    const r = integrationManifestSchema.safeParse(
      baseManifest({ server: undefined, apiCall: { authKey: "primary" } }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects apiCall.authKey that matches no auth", () => {
    const r = integrationManifestSchema.safeParse(
      baseManifest({
        server: undefined,
        apiCall: { authKey: "ghost" },
        auths: { primary: oauthAuth },
      }),
    );
    expect(r.success).toBe(false);
  });

  it("names the auth explicitly when multiple auths are declared", () => {
    const r = integrationManifestSchema.safeParse(
      baseManifest({
        server: undefined,
        apiCall: { authKey: "secondary" },
        auths: { primary: oauthAuth, secondary: oauthAuth },
      }),
    );
    expect(r.success).toBe(true);
    if (r.success) expect(getApiCallConfig(r.data)?.authKey).toBe("secondary");
  });

  it("accepts apiCall.uploadProtocols and surfaces them via getApiCallConfig", () => {
    const m = baseManifest({
      server: undefined,
      apiCall: { authKey: "primary", uploadProtocols: ["google-resumable"] },
      auths: { primary: oauthAuth },
    });
    const parsed = integrationManifestSchema.parse(m);
    const cfg = getApiCallConfig(parsed);
    expect(cfg).toEqual({ authKey: "primary", uploadProtocols: ["google-resumable"] });
  });

  it("getApiCallConfig returns the block authKey and null when no apiCall", () => {
    const withCall = integrationManifestSchema.parse(
      baseManifest({ server: undefined, apiCall: { authKey: "only" }, auths: { only: oauthAuth } }),
    );
    expect(getApiCallConfig(withCall)?.authKey).toBe("only");
    const noCall = integrationManifestSchema.parse(baseManifest());
    expect(getApiCallConfig(noCall)).toBeNull();
  });

  it("exposes a stable generic tool name", () => {
    expect(API_CALL_TOOL_NAME).toBe("api_call");
  });
});

describe("integrationManifestSchema — allowAllUris (migrated provider parity)", () => {
  it("accepts an auth with empty authorizedUris when allowAllUris is set", () => {
    const m = baseManifest({
      server: undefined,
      apiCall: { authKey: "primary" },
      auths: {
        primary: {
          type: "custom",
          authorizedUris: [],
          allowAllUris: true,
          credentials: { schema: { type: "object", properties: { token: { type: "string" } } } },
          delivery: { env: { TOKEN: { from: "token" } } },
        },
      },
    });
    expect(() => integrationManifestSchema.parse(m)).not.toThrow();
  });

  it("rejects an auth with empty authorizedUris and no allowAllUris", () => {
    const m = baseManifest({
      auths: {
        primary: {
          type: "oauth2",
          authorizationUrl: "https://idp/a",
          tokenUrl: "https://idp/t",
          authorizedUris: [],
          delivery: { http: {} },
        },
      },
    });
    expect(integrationManifestSchema.safeParse(m).success).toBe(false);
  });
});

describe("requiredAuthKeysForAgent / requiredScopesForAgent — apiCall scope-only", () => {
  // apiCall integrations expose no `tools` — the agent's
  // selected oauth `scopes` are the only "active usage" signal. The gate must
  // treat scope selection like tool selection or these integrations become
  // structurally unconnectable.
  const apiCallManifest = (): IntegrationManifest =>
    ({
      manifestVersion: "1.1",
      type: "integration",
      name: "@official/github",
      version: "1.0.0",
      displayName: "GitHub",
      apiCall: { authKey: "primary" },
      auths: {
        primary: {
          type: "oauth2",
          required: true,
          authorizationUrl: "https://github.com/login/oauth/authorize",
          tokenUrl: "https://github.com/login/oauth/access_token",
          authorizedUris: [],
          availableScopes: [
            { value: "repo", label: "Repo" },
            { value: "read:org", label: "Read org" },
          ],
        },
      },
    }) as unknown as IntegrationManifest;

  it("treats scope selection as active (no tools)", () => {
    const m = apiCallManifest();
    expect(requiredAuthKeysForAgent(m, [], ["repo"])).toEqual(["primary"]);
    expect(requiredAuthKeysForAgent(m, undefined, ["repo"])).toEqual(["primary"]);
  });

  it("stays inert when neither tools nor scopes are selected", () => {
    expect(requiredAuthKeysForAgent(apiCallManifest(), [], [])).toEqual([]);
    expect(requiredAuthKeysForAgent(apiCallManifest(), undefined, undefined)).toEqual([]);
  });

  it("requiredScopesForAgent surfaces explicitly-selected scopes for tool-less integrations", () => {
    const m = apiCallManifest();
    expect(
      requiredScopesForAgent({
        manifest: m,
        authKey: "primary",
        agentTools: [],
        agentScopes: ["repo", "read:org"],
      }),
    ).toEqual(["repo", "read:org"]);
  });

  it("requiredScopesForAgent returns [] when nothing selected", () => {
    expect(
      requiredScopesForAgent({
        manifest: apiCallManifest(),
        authKey: "primary",
        agentTools: undefined,
        agentScopes: undefined,
      }),
    ).toEqual([]);
  });
});

describe("integrationManifestSchema — connect (Login)", () => {
  function withAuth(auth: Record<string, unknown>): Record<string, unknown> {
    return baseManifest({ auths: { session: auth } });
  }
  const validConnect = {
    steps: [
      {
        request: {
          method: "POST",
          url: "https://idp.example.com/token",
          body: "grant_type=password&username={{email}}&password={{password}}",
        },
        extract: {
          access_token: { from: "json", path: "$.access_token" },
          expires_in: { from: "json", path: "$.expires_in" },
        },
        output: ["access_token", "expires_in"],
      },
    ],
    expiresInOutput: "expires_in",
    identityOutputs: ["access_token"],
  };
  const customAuth = (connect: unknown): Record<string, unknown> => ({
    type: "custom",
    credentials: { schema: { type: "object" } },
    authorizedUris: ["https://idp.example.com/**"],
    delivery: { http: { headerName: "Authorization", valueFrom: "access_token" } },
    connect,
  });

  it("accepts a valid custom + connect.steps auth", () => {
    const r = integrationManifestSchema.safeParse(withAuth(customAuth(validConnect)));
    expect(r.success).toBe(true);
  });

  it("rejects connect on a non-custom auth", () => {
    const r = integrationManifestSchema.safeParse(
      withAuth({
        type: "api_key",
        credentials: { schema: { type: "object" } },
        authorizedUris: ["https://idp.example.com/**"],
        delivery: { http: { headerName: "X-Key", valueFrom: "api_key" } },
        connect: validConnect,
      }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects output referencing an undeclared extractor", () => {
    const r = integrationManifestSchema.safeParse(
      withAuth(
        customAuth({
          steps: [
            {
              request: { method: "POST", url: "https://idp.example.com/token" },
              extract: { access_token: { from: "json", path: "$.access_token" } },
              output: ["nonexistent"],
            },
          ],
        }),
      ),
    );
    expect(r.success).toBe(false);
  });

  it("rejects connect with no declared outputs", () => {
    const r = integrationManifestSchema.safeParse(
      withAuth(
        customAuth({
          steps: [
            {
              request: { method: "POST", url: "https://idp.example.com/token" },
              extract: { access_token: { from: "json", path: "$.access_token" } },
            },
          ],
        }),
      ),
    );
    expect(r.success).toBe(false);
  });

  it("rejects expiresInOutput that is not a declared output", () => {
    const r = integrationManifestSchema.safeParse(
      withAuth(
        customAuth({
          steps: [
            {
              request: { method: "POST", url: "https://idp.example.com/token" },
              extract: { access_token: { from: "json", path: "$.access_token" } },
              output: ["access_token"],
            },
          ],
          expiresInOutput: "expires_in",
        }),
      ),
    );
    expect(r.success).toBe(false);
  });
});

describe("integrationManifestSchema — connect.tool (Orchestrated) + delivery gating (§4.6)", () => {
  function withAuth(auth: Record<string, unknown>): Record<string, unknown> {
    return baseManifest({ auths: { session: auth } });
  }
  const orchestratedAuth = (
    connect: Record<string, unknown>,
    delivery: Record<string, unknown> = {
      http: { headerName: "Cookie", valueFrom: "JSESSIONID" },
    },
  ): Record<string, unknown> => ({
    type: "custom",
    credentials: { schema: { type: "object" } },
    authorizedUris: ["https://saas.example.com/**"],
    delivery,
    connect,
  });

  it("accepts a valid custom + connect.tool auth", () => {
    const r = integrationManifestSchema.safeParse(
      withAuth(
        orchestratedAuth({
          tool: "login",
          runAt: "run-start",
          reauthOn: [401],
          persistLoginSecret: true,
          produces: ["JSESSIONID", "AWSALB"],
        }),
      ),
    );
    expect(r.success).toBe(true);
  });

  it("rejects declaring both steps and tool", () => {
    const r = integrationManifestSchema.safeParse(
      withAuth(
        orchestratedAuth({
          tool: "login",
          runAt: "run-start",
          produces: ["JSESSIONID"],
          steps: [
            {
              request: { method: "POST", url: "https://saas.example.com/login" },
              extract: { JSESSIONID: { from: "cookie", name: "JSESSIONID" } },
              output: ["JSESSIONID"],
            },
          ],
        }),
      ),
    );
    expect(r.success).toBe(false);
  });

  it("rejects connect.tool without runAt", () => {
    const r = integrationManifestSchema.safeParse(
      withAuth(orchestratedAuth({ tool: "login", produces: ["JSESSIONID"] })),
    );
    expect(r.success).toBe(false);
  });

  it("requires produces when persistLoginSecret is set", () => {
    const r = integrationManifestSchema.safeParse(
      withAuth(orchestratedAuth({ tool: "login", runAt: "run-start", persistLoginSecret: true })),
    );
    expect(r.success).toBe(false);
  });

  it("rejects orchestrated-only fields on a steps connect", () => {
    const r = integrationManifestSchema.safeParse(
      withAuth(
        orchestratedAuth(
          {
            runAt: "link",
            steps: [
              {
                request: { method: "POST", url: "https://saas.example.com/login" },
                extract: { JSESSIONID: { from: "cookie", name: "JSESSIONID" } },
                output: ["JSESSIONID"],
              },
            ],
          },
          { http: { headerName: "Cookie", valueFrom: "JSESSIONID" } },
        ),
      ),
    );
    expect(r.success).toBe(false);
  });

  it("GATING: rejects delivery referencing a field that is not a declared output", () => {
    // `mot_de_passe` is a bootstrap input (login secret), never an injectable.
    const r = integrationManifestSchema.safeParse(
      withAuth(
        orchestratedAuth(
          { tool: "login", runAt: "run-start", produces: ["JSESSIONID"] },
          { http: { headerName: "Cookie", valueFrom: "mot_de_passe" } },
        ),
      ),
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toContain("not a declared connect output");
    }
  });

  it("GATING: rejects a delivery template token that is not a declared output", () => {
    const r = integrationManifestSchema.safeParse(
      withAuth(
        orchestratedAuth(
          { tool: "login", runAt: "run-start", produces: ["JSESSIONID"] },
          { http: { headerName: "Cookie", valueFrom: { template: "sid={{secret_pwd}}" } } },
        ),
      ),
    );
    expect(r.success).toBe(false);
  });

  it("GATING: accepts delivery referencing only declared outputs", () => {
    const r = integrationManifestSchema.safeParse(
      withAuth(
        orchestratedAuth(
          { tool: "login", runAt: "run-start", produces: ["JSESSIONID", "AWSALB"] },
          {
            http: {
              headerName: "Cookie",
              valueFrom: { template: "JSESSIONID={{JSESSIONID}}; AWSALB={{AWSALB}}" },
            },
          },
        ),
      ),
    );
    expect(r.success).toBe(true);
  });
});

describe("integrationManifestSchema — attachable apiCall capability", () => {
  // A node MCP server with a custom session auth + the additive `apiCall` block.
  function nodeWithApiCall(overrides: Record<string, unknown> = {}) {
    return baseManifest({
      server: { type: "node", entryPoint: "./server.js" },
      auths: {
        session: {
          type: "custom",
          authorizedUris: ["https://api.example.com/**"],
          credentials: { schema: { type: "object", required: ["token"] } },
          delivery: { http: { headerName: "Authorization", valueFrom: "accessToken" } },
        },
      },
      apiCall: { authKey: "session" },
      ...overrides,
    });
  }

  it("accepts a node server with an attachable apiCall block", () => {
    const r = integrationManifestSchema.safeParse(nodeWithApiCall());
    expect(r.success).toBe(true);
  });

  it("getApiCallConfig resolves the block alongside a spawned server", () => {
    const m = integrationManifestSchema.parse(
      nodeWithApiCall({ apiCall: { authKey: "session", uploadProtocols: ["tus"] } }),
    );
    expect(getApiCallConfig(m)).toEqual({ authKey: "session", uploadProtocols: ["tus"] });
  });

  it("getApiCallConfig resolves a serverless apiCall block (no server)", () => {
    const m = integrationManifestSchema.parse(
      baseManifest({
        server: undefined,
        apiCall: { authKey: "session" },
        auths: {
          session: {
            type: "custom",
            authorizedUris: ["https://api.example.com/**"],
            credentials: { schema: { type: "object", required: ["token"] } },
            delivery: { http: { headerName: "Authorization", valueFrom: "accessToken" } },
          },
        },
      }),
    );
    expect(getApiCallConfig(m)).toEqual({ authKey: "session", uploadProtocols: [] });
  });

  it("rejects an apiCall block whose authKey matches no auth", () => {
    const r = integrationManifestSchema.safeParse(
      nodeWithApiCall({ apiCall: { authKey: "ghost" } }),
    );
    expect(r.success).toBe(false);
  });

  it("requiredAuthKeysForAgent pins the apiCall auth when api_call is selected (multi-auth)", () => {
    const m = integrationManifestSchema.parse(
      baseManifest({
        server: { type: "node", entryPoint: "./server.js" },
        auths: {
          session: {
            type: "custom",
            authorizedUris: ["https://api.example.com/**"],
            credentials: { schema: { type: "object", required: ["token"] } },
            delivery: { http: { headerName: "Authorization", valueFrom: "accessToken" } },
          },
          other: {
            type: "api_key",
            authorizedUris: ["https://other.example.com/**"],
            credentials: { schema: { type: "object", required: ["key"] } },
            delivery: { env: { TOKEN: { from: "api_key" } } },
          },
        },
        apiCall: { authKey: "session" },
      }),
    );
    expect(requiredAuthKeysForAgent(m, ["api_call"])).toEqual(["session"]);
  });
});
