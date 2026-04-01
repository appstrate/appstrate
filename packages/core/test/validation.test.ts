import { describe, expect, test } from "bun:test";
import {
  validateManifest,
  extractSkillMeta,
  validateToolSource,
  extractManifestMetadata,
  getDefaultAdminCredentialSchema,
} from "../src/validation.ts";
import type { Manifest } from "../src/validation.ts";

// ─────────────────────────────────────────────
// Helpers — minimal valid manifests
// ─────────────────────────────────────────────

function validFlowManifest(overrides?: Record<string, unknown>) {
  return {
    name: "@test/my-flow",
    version: "1.0.0",
    type: "flow",
    schemaVersion: "1.0",
    displayName: "My Flow",
    author: "test",
    ...overrides,
  };
}

function validSkillManifest(overrides?: Record<string, unknown>) {
  return {
    name: "@test/my-skill",
    version: "1.0.0",
    type: "skill",
    ...overrides,
  };
}

function validToolManifest(overrides?: Record<string, unknown>) {
  return {
    name: "@test/my-tool",
    version: "1.0.0",
    type: "tool",
    entrypoint: "tool.ts",
    tool: {
      name: "my_tool",
      description: "A test tool",
      inputSchema: { type: "object", properties: {} },
    },
    ...overrides,
  };
}

function validProviderManifest(overrides?: Record<string, unknown>) {
  return {
    name: "@test/my-provider",
    version: "1.0.0",
    type: "provider",
    displayName: "My Provider",
    definition: {
      authMode: "oauth2",
      oauth2: {
        authorizationUrl: "https://example.com/authorize",
        tokenUrl: "https://example.com/token",
        defaultScopes: ["read"],
      },
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────
// validateManifest
// ─────────────────────────────────────────────

describe("validateManifest", () => {
  test("valid flow manifest", () => {
    const result = validateManifest(validFlowManifest());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.manifest).toBeDefined();
  });

  test("valid skill manifest", () => {
    const result = validateManifest(validSkillManifest());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("valid tool manifest", () => {
    const result = validateManifest(validToolManifest());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("invalid manifest — missing name", () => {
    const result = validateManifest(validSkillManifest({ name: undefined }));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("invalid manifest — missing version", () => {
    const result = validateManifest(validSkillManifest({ version: undefined }));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("missing type field returns explicit error", () => {
    const { type: _, ...noType } = validFlowManifest();
    const result = validateManifest(noType);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(["type: Required field is missing"]);
  });

  test("invalid scoped name format", () => {
    const result = validateManifest(validSkillManifest({ name: "bad-name" }));
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("@scope/name") || e.includes("@scope/package-name")),
    ).toBe(true);
  });

  test("slug-only name (without scope) is rejected", () => {
    const result = validateManifest(validSkillManifest({ name: "my-skill" }));
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("@scope/name") || e.includes("@scope/package-name")),
    ).toBe(true);
  });

  test("invalid semver version", () => {
    const result = validateManifest(validSkillManifest({ version: "not-a-version" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("semver"))).toBe(true);
  });

  test("flow manifest valid without optional default fields", () => {
    // Minimal flow manifest — no dependencies, timeout
    const manifest = {
      name: "@test/minimal",
      version: "1.0.0",
      type: "flow",
      schemaVersion: "1.0",
      displayName: "Minimal Flow",
      author: "test",
      // dependencies, timeout, providersConfiguration intentionally omitted
    };

    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);

    // Zod output should NOT inject defaults anymore
    const m = result.manifest as Record<string, unknown>;
    expect(m.dependencies).toBeUndefined();
    expect(m.timeout).toBeUndefined();
    expect(m.providersConfiguration).toBeUndefined();
  });

  test("flow with dependencies (skills/tools/providers)", () => {
    const result = validateManifest(
      validFlowManifest({
        dependencies: {
          providers: { "@test/google": "^1.0.0" },
          skills: { "@test/skill": "^1.0.0", "@test/other": "~2.3.0" },
          tools: { "@test/ext": ">=0.1.0" },
        },
      }),
    );
    expect(result.valid).toBe(true);
    const deps = (result.manifest as Record<string, unknown>).dependencies as Record<
      string,
      unknown
    >;
    expect(deps.skills).toEqual({ "@test/skill": "^1.0.0", "@test/other": "~2.3.0" });
    expect(deps.tools).toEqual({ "@test/ext": ">=0.1.0" });
  });

  test("flow with built-in skill using wildcard version", () => {
    const result = validateManifest(
      validFlowManifest({
        dependencies: {
          skills: { "@appstrate/built-in-skill": "*" },
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  test("old array format for skills in dependencies is rejected", () => {
    const result = validateManifest(
      validFlowManifest({
        dependencies: {
          skills: ["@test/skill"],
        },
      }),
    );
    expect(result.valid).toBe(false);
  });

  test("flow with providersConfiguration", () => {
    const result = validateManifest(
      validFlowManifest({
        dependencies: {
          providers: { "@test/google": "^1.0.0" },
        },
        providersConfiguration: {
          "@test/google": {
            scopes: ["gmail.readonly", "gmail.send"],
          },
        },
      }),
    );
    expect(result.valid).toBe(true);
    const m = result.manifest as Record<string, unknown>;
    const cfg = m.providersConfiguration as Record<string, Record<string, unknown>>;
    expect(cfg["@test/google"]!.scopes).toEqual(["gmail.readonly", "gmail.send"]);
  });

  test("valid provider manifest (oauth2)", () => {
    const result = validateManifest(validProviderManifest());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.manifest).toBeDefined();
  });

  test("valid provider manifest (api_key)", () => {
    const result = validateManifest(
      validProviderManifest({
        definition: {
          authMode: "api_key",
          credentials: { schema: { apiKey: { type: "string", label: "API Key" } } },
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  test("valid provider manifest (basic)", () => {
    const result = validateManifest(
      validProviderManifest({
        definition: {
          authMode: "basic",
          credentials: {
            schema: {
              username: { type: "string" },
              password: { type: "string" },
            },
          },
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  test("valid provider manifest (oauth1)", () => {
    const result = validateManifest(
      validProviderManifest({
        definition: {
          authMode: "oauth1",
          oauth1: {
            requestTokenUrl: "https://example.com/request-token",
            accessTokenUrl: "https://example.com/access-token",
          },
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  test("provider oauth2 — missing authorizationUrl", () => {
    const result = validateManifest(
      validProviderManifest({
        definition: {
          authMode: "oauth2",
          oauth2: { tokenUrl: "https://example.com/token" },
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("authorizationUrl"))).toBe(true);
  });

  test("provider oauth2 — missing tokenUrl", () => {
    const result = validateManifest(
      validProviderManifest({
        definition: {
          authMode: "oauth2",
          oauth2: { authorizationUrl: "https://example.com/authorize" },
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("tokenUrl"))).toBe(true);
  });

  test("provider oauth2 — missing oauth2 object", () => {
    const result = validateManifest(
      validProviderManifest({
        definition: { authMode: "oauth2" },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("oauth2"))).toBe(true);
  });

  test("provider oauth1 — missing requestTokenUrl", () => {
    const result = validateManifest(
      validProviderManifest({
        definition: {
          authMode: "oauth1",
          oauth1: { accessTokenUrl: "https://example.com/access-token" },
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("requestTokenUrl"))).toBe(true);
  });

  test("provider api_key — missing credentials", () => {
    const result = validateManifest(
      validProviderManifest({
        definition: { authMode: "api_key" },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("credentials"))).toBe(true);
  });

  test("provider — missing definition", () => {
    const { definition: _, ...noDefinition } = validProviderManifest();
    const result = validateManifest(noDefinition);
    expect(result.valid).toBe(false);
  });

  test("provider — invalid authMode", () => {
    const result = validateManifest(
      validProviderManifest({
        definition: { authMode: "invalid_mode" },
      }),
    );
    expect(result.valid).toBe(false);
  });

  test("provider with setupGuide", () => {
    const result = validateManifest(
      validProviderManifest({
        setupGuide: {
          callbackUrlHint: "https://example.com/callback",
          steps: [
            { label: "Create app", url: "https://example.com/apps" },
            { label: "Copy credentials" },
          ],
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  test("flow with dependencies.providers", () => {
    const result = validateManifest(
      validFlowManifest({
        dependencies: {
          providers: { "@acme/slack": "^1.0.0" },
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  // ─── schemaVersion format validation ───

  test("rejects schemaVersion with patch segment (1.0.0)", () => {
    const result = validateManifest(validFlowManifest({ schemaVersion: "1.0.0" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
  });

  test("rejects schemaVersion without minor segment (1)", () => {
    const result = validateManifest(validFlowManifest({ schemaVersion: "1" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
  });

  test("rejects schemaVersion with v prefix (v1.0)", () => {
    const result = validateManifest(validFlowManifest({ schemaVersion: "v1.0" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
  });

  test("rejects schemaVersion with wrong major (2.0)", () => {
    const result = validateManifest(validFlowManifest({ schemaVersion: "2.0" }));
    expect(result.valid).toBe(false);
  });

  test("accepts schemaVersion with higher minor (1.99)", () => {
    const result = validateManifest(validFlowManifest({ schemaVersion: "1.99" }));
    expect(result.valid).toBe(true);
  });

  // ─── Default manifest validation (all package types) ───

  test("default flow manifest (Hello World) is valid", () => {
    // Mirrors HELLO_WORLD_MANIFEST from strate/apps/api/src/services/default-flow.ts
    const manifest = {
      name: "@test-org/hello-world",
      version: "1.0.0",
      type: "flow",
      schemaVersion: "1.0",
      displayName: "Hello World",
      author: "Appstrate",
      description: "A demo flow",
      keywords: ["demo", "example", "getting-started"],
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("default flow manifest (flow-service fallback) is valid", () => {
    // Mirrors dbRowToLoadedFlow fallback in strate/apps/api/src/services/flow-service.ts
    // author is empty — tolerated by core for local drafts (AFPS requires it for publication)
    const manifest = {
      name: "@test-org/fallback-flow",
      version: "0.0.0",
      type: "flow",
      schemaVersion: "1.0",
      displayName: "Fallback",
      author: "",
      description: "",
      dependencies: { providers: {} },
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("flow manifest without author is accepted (tolerant local editing)", () => {
    const { author: _, ...noAuthor } = validFlowManifest();
    const result = validateManifest(noAuthor);
    expect(result.valid).toBe(true);
  });

  test("default flow manifest (frontend defaultFormState) is valid", () => {
    // Mirrors assemblePayload output from strate/apps/web/src/components/flow-editor/utils.ts
    const manifest = {
      name: "@test-org/my-flow",
      version: "1.0.0",
      type: "flow",
      schemaVersion: "1.0",
      displayName: "My Flow",
      description: "A flow",
      author: "user@example.com",
      dependencies: { providers: {} },
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("default skill manifest (content-module-factory) is valid", () => {
    // Mirrors makeContentPackageModule("skill") from strate/apps/web
    const manifest = {
      name: "@test-org/my-skill",
      version: "1.0.0",
      type: "skill",
      schemaVersion: "1.0",
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("default tool manifest (content-module-factory + createOrgItem enrichment) is valid", () => {
    // Mirrors makeContentPackageModule("tool") + createOrgItem tool enrichment
    const manifest = {
      name: "@test-org/my-tool",
      version: "1.0.0",
      type: "tool",
      schemaVersion: "1.0",
      entrypoint: "tool.ts",
      tool: {
        name: "my-tool",
        description: "Tool",
        inputSchema: { type: "object", properties: {} },
      },
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("default provider manifest (POST /api/providers) is valid", () => {
    // Mirrors the manifest built by strate/apps/api/src/routes/providers.ts
    const manifest = {
      name: "@test-org/my-provider",
      version: "1.0.0",
      type: "provider",
      displayName: "My Provider",
      description: "A custom provider",
      author: "user@example.com",
      definition: {
        authMode: "oauth2",
        oauth2: {
          authorizationUrl: "https://example.com/authorize",
          tokenUrl: "https://example.com/token",
          defaultScopes: [],
          scopeSeparator: " ",
          pkceEnabled: true,
          tokenAuthMethod: "client_secret_post",
        },
        credentialHeaderName: "",
        credentialHeaderPrefix: "",
        authorizedUris: [],
        allowAllUris: false,
      },
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("default provider manifest (api_key mode) is valid", () => {
    const manifest = {
      name: "@test-org/api-provider",
      version: "1.0.0",
      type: "provider",
      displayName: "API Provider",
      definition: {
        authMode: "api_key",
        credentials: {
          schema: {
            type: "object",
            properties: { apiKey: { type: "string", description: "API Key" } },
            required: ["apiKey"],
          },
        },
        credentialHeaderName: "Authorization",
        credentialHeaderPrefix: "Bearer ",
        authorizedUris: ["https://api.example.com/*"],
      },
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("preserves unknown fields at all nesting levels (passthrough)", () => {
    const manifest = {
      ...validFlowManifest(),
      customTopLevel: "preserved",
      timeout: 300,
      dependencies: {
        providers: { "@test/google": "^1.0.0" },
        skills: {},
        tools: {},
        customDepsField: "preserved",
      },
      providersConfiguration: {
        "@test/google": {
          scopes: ["gmail.readonly"],
          customConfigField: true,
        },
      },
    };

    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    const m = result.manifest as Record<string, unknown>;
    expect(m.customTopLevel).toBe("preserved");
    expect(m.timeout).toBe(300);

    const deps = m.dependencies as Record<string, unknown>;
    expect(deps.customDepsField).toBe("preserved");

    const cfg = m.providersConfiguration as Record<string, Record<string, unknown>>;
    expect(cfg["@test/google"]!.customConfigField).toBe(true);
  });
});

// ─────────────────────────────────────────────
// extractManifestMetadata
// ─────────────────────────────────────────────

describe("extractManifestMetadata", () => {
  test("full manifest — all metadata extracted", () => {
    const manifest = {
      name: "@test/my-skill",
      version: "1.0.0",
      type: "skill" as const,
      description: "A useful skill",
      keywords: ["ai", "tool"],
      license: "MIT",
      repository: "https://github.com/test/repo",
    } as Partial<Manifest>;
    const metadata = extractManifestMetadata(manifest);
    expect(metadata.description).toBe("A useful skill");
    expect(metadata.keywords).toEqual(["ai", "tool"]);
    expect(metadata.license).toBe("MIT");
    expect(metadata.repositoryUrl).toBe("https://github.com/test/repo");
  });

  test("displayName — extracted when present", () => {
    const manifest = {
      name: "@test/my-flow",
      version: "1.0.0",
      type: "flow" as const,
      displayName: "My Custom Flow",
    } as Partial<Manifest>;
    const metadata = extractManifestMetadata(manifest);
    expect(metadata.displayName).toBe("My Custom Flow");
  });

  test("empty manifest — returns empty object", () => {
    const metadata = extractManifestMetadata({});
    expect(metadata.description).toBeUndefined();
    expect(metadata.keywords).toBeUndefined();
    expect(metadata.license).toBeUndefined();
    expect(metadata.repositoryUrl).toBeUndefined();
    expect(metadata.displayName).toBeUndefined();
  });

  test("partial manifest — only defined fields included", () => {
    const manifest = {
      name: "@test/pkg",
      version: "1.0.0",
      type: "skill" as const,
      description: "Only description",
    } as Partial<Manifest>;
    const metadata = extractManifestMetadata(manifest);
    expect(metadata.description).toBe("Only description");
    expect(metadata.keywords).toBeUndefined();
    expect(metadata.license).toBeUndefined();
    expect(metadata.repositoryUrl).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// extractSkillMeta
// ─────────────────────────────────────────────

describe("extractSkillMeta", () => {
  test("valid frontmatter", () => {
    const content = `---
name: my-skill
description: A useful skill
---
# Content here`;
    const result = extractSkillMeta(content);
    expect(result.name).toBe("my-skill");
    expect(result.description).toBe("A useful skill");
    expect(result.warnings).toHaveLength(0);
  });

  test("frontmatter with quoted values", () => {
    const content = `---
name: "quoted-name"
description: 'quoted description'
---`;
    const result = extractSkillMeta(content);
    expect(result.name).toBe("quoted-name");
    expect(result.description).toBe("quoted description");
  });

  test("frontmatter without name", () => {
    const content = `---
description: A skill without name
---`;
    const result = extractSkillMeta(content);
    expect(result.name).toBe("");
    expect(result.warnings.some((w) => w.includes("name"))).toBe(true);
  });

  test("no frontmatter", () => {
    const content = "Just some markdown content";
    const result = extractSkillMeta(content);
    expect(result.name).toBe("");
    expect(result.description).toBe("");
    expect(result.warnings.some((w) => w.includes("frontmatter"))).toBe(true);
  });
});

// ─────────────────────────────────────────────
// validateToolSource
// ─────────────────────────────────────────────

describe("validateToolSource", () => {
  const validTool = `
import { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "my-tool",
    description: "Does stuff",
    parameters: {},
    execute(_toolCallId, params, signal) {
      return { content: [{ type: "text", text: "hello" }] };
    }
  });
}`;

  test("valid tool source", () => {
    const result = validateToolSource(validTool);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("missing export default", () => {
    const source = `function setup(pi) { pi.registerTool({ execute(_id, p, s) { return { content: [] }; } }); }`;
    const result = validateToolSource(source);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("export default"))).toBe(true);
  });

  test("missing registerTool — warning only", () => {
    const source = `export default function(pi) { return { content: [{ type: "text", text: "x" }] }; }`;
    const result = validateToolSource(source);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("registerTool"))).toBe(true);
  });

  test("execute with single param — error", () => {
    const source = `
export default function(pi) {
  pi.registerTool({
    name: "t",
    execute(params) {
      return { content: [{ type: "text", text: "x" }] };
    }
  });
}`;
    const result = validateToolSource(source);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("only one parameter"))).toBe(true);
  });

  test("unbalanced braces — no false positive (brace counting removed)", () => {
    const source = `export default function(pi) {
  pi.registerTool({
    name: "t",
    execute(_id, params, signal) {
      return { content: [{ type: "text", text: "x" }] };
    }
  });`;
    const result = validateToolSource(source);
    // Brace counting was removed because it produced false positives
    // (e.g. braces inside template literals or comments). The source
    // is otherwise structurally valid, so validation should pass.
    expect(result.valid).toBe(true);
  });

  test("empty source", () => {
    const result = validateToolSource("   ");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("empty"))).toBe(true);
  });
});

// ─────────────────────────────────────────────
// getDefaultAdminCredentialSchema
// ─────────────────────────────────────────────

describe("getDefaultAdminCredentialSchema", () => {
  test("oauth2 returns clientId/clientSecret schema", () => {
    const schema = getDefaultAdminCredentialSchema("oauth2");
    expect(schema).not.toBeNull();
    expect(schema!.type).toBe("object");
    expect(schema!.properties.clientId).toBeDefined();
    expect(schema!.properties.clientSecret).toBeDefined();
    expect(schema!.required).toEqual(["clientId", "clientSecret"]);
  });

  test("oauth1 returns consumerKey/consumerSecret schema", () => {
    const schema = getDefaultAdminCredentialSchema("oauth1");
    expect(schema).not.toBeNull();
    expect(schema!.properties.consumerKey).toBeDefined();
    expect(schema!.properties.consumerSecret).toBeDefined();
    expect(schema!.required).toEqual(["consumerKey", "consumerSecret"]);
  });

  test("api_key returns null", () => {
    expect(getDefaultAdminCredentialSchema("api_key")).toBeNull();
  });

  test("basic returns null", () => {
    expect(getDefaultAdminCredentialSchema("basic")).toBeNull();
  });

  test("custom returns null", () => {
    expect(getDefaultAdminCredentialSchema("custom")).toBeNull();
  });

  test("unknown mode returns null", () => {
    expect(getDefaultAdminCredentialSchema("whatever")).toBeNull();
  });
});
