// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { validateManifest, extractSkillMeta, extractManifestMetadata } from "../src/validation.ts";
import type { Manifest } from "../src/validation.ts";

// ─────────────────────────────────────────────
// Helpers — minimal valid manifests
// ─────────────────────────────────────────────

function validAgentManifest(overrides?: Record<string, unknown>) {
  return {
    name: "@test/my-agent",
    version: "1.0.0",
    type: "agent",
    schemaVersion: "1.0",
    displayName: "My Agent",
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

// ─────────────────────────────────────────────
// validateManifest
// ─────────────────────────────────────────────

describe("validateManifest", () => {
  it("valid agent manifest", () => {
    const result = validateManifest(validAgentManifest());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.manifest).toBeDefined();
  });

  it("valid skill manifest", () => {
    const result = validateManifest(validSkillManifest());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("invalid manifest — missing name", () => {
    const result = validateManifest(validSkillManifest({ name: undefined }));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("invalid manifest — missing version", () => {
    const result = validateManifest(validSkillManifest({ version: undefined }));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("missing type field surfaces all base-schema errors", () => {
    // Without a `type`, validateManifest falls through to the base schema and
    // lets Zod aggregate every missing/invalid field in one pass, instead of
    // short-circuiting on `type` alone.
    const { type: _, ...noType } = validAgentManifest();
    const result = validateManifest(noType);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("type:"))).toBe(true);
  });

  it("empty manifest surfaces every missing base field at once", () => {
    // The base `manifestSchema` requires name/version/type. Without `type`,
    // dispatch falls through to the base schema and Zod emits all three
    // missing-field errors together instead of stopping on `type`.
    const result = validateManifest({});
    expect(result.valid).toBe(false);
    const fields = result.errors.map((e) => e.split(":")[0]);
    expect(fields).toContain("type");
    expect(fields).toContain("name");
    expect(fields).toContain("version");
  });

  it("invalid scoped name format", () => {
    const result = validateManifest(validSkillManifest({ name: "bad-name" }));
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("@scope/name") || e.includes("@scope/package-name")),
    ).toBe(true);
  });

  it("slug-only name (without scope) is rejected", () => {
    const result = validateManifest(validSkillManifest({ name: "my-skill" }));
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("@scope/name") || e.includes("@scope/package-name")),
    ).toBe(true);
  });

  it("invalid semver version", () => {
    const result = validateManifest(validSkillManifest({ version: "not-a-version" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("semver"))).toBe(true);
  });

  it("agent manifest valid without optional default fields", () => {
    // Minimal agent manifest — no dependencies, timeout
    const manifest = {
      name: "@test/minimal",
      version: "1.0.0",
      type: "agent",
      schemaVersion: "1.0",
      displayName: "Minimal Agent",
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

  it("agent with dependencies (skills/providers) + runtimeTools", () => {
    const result = validateManifest(
      validAgentManifest({
        dependencies: {
          providers: { "@test/google": "^1.0.0" },
          skills: { "@test/skill": "^1.0.0", "@test/other": "~2.3.0" },
        },
        runtimeTools: ["log", "note"],
      }),
    );
    expect(result.valid).toBe(true);
    const m = result.manifest as Record<string, unknown>;
    const deps = m.dependencies as Record<string, unknown>;
    expect(deps.skills).toEqual({ "@test/skill": "^1.0.0", "@test/other": "~2.3.0" });
    expect(deps.providers).toEqual({ "@test/google": "^1.0.0" });
    // The former `dependencies.tools` package map is gone; selectable runtime
    // tools are declared via the top-level `runtimeTools` field instead.
    expect(m.runtimeTools).toEqual(["log", "note"]);
  });

  it("agent with no output schema is valid without the `output` runtime tool", () => {
    // Side-effect-only run: do a task and finish, no result to return.
    const result = validateManifest(validAgentManifest({ runtimeTools: ["log"] }));
    expect(result.valid).toBe(true);
  });

  it("rejects an output schema when the `output` runtime tool is not selected", () => {
    const result = validateManifest(
      validAgentManifest({
        output: { schema: { type: "object", properties: { x: { type: "string" } } } },
        runtimeTools: ["log"],
      }),
    );
    expect(result.valid).toBe(false);
    // Error is surfaced on the runtimeTools field so the editor can render it.
    expect(result.errors.some((e) => e.startsWith("runtimeTools:"))).toBe(true);
  });

  it("accepts an output schema when the `output` runtime tool is selected", () => {
    const result = validateManifest(
      validAgentManifest({
        output: { schema: { type: "object", properties: { x: { type: "string" } } } },
        runtimeTools: ["output", "log"],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("agent with integrations declared as bare version string (legacy)", () => {
    const result = validateManifest(
      validAgentManifest({
        dependencies: {
          integrations: { "@test/gmail-mcp": "^1.0.0" },
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("agent with integrations selection in the top-level `integrations` block", () => {
    const result = validateManifest(
      validAgentManifest({
        dependencies: { integrations: { "@test/gmail-mcp": "^1.0.0" } },
        integrations: {
          "@test/gmail-mcp": {
            tools: ["list_messages", "get_message"],
            scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          },
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects an integration dependency value that's not a bare string", () => {
    const result = validateManifest(
      validAgentManifest({
        dependencies: {
          integrations: { "@test/gmail-mcp": { version: "^1.0.0" } },
        },
      }),
    );
    expect(result.valid).toBe(false);
  });

  it("rejects agent integration tool names that don't match snake_case", () => {
    const result = validateManifest(
      validAgentManifest({
        dependencies: { integrations: { "@test/gmail-mcp": "^1.0.0" } },
        integrations: {
          "@test/gmail-mcp": { tools: ["List-Messages"] },
        },
      }),
    );
    expect(result.valid).toBe(false);
  });

  it("agent with built-in skill using wildcard version", () => {
    const result = validateManifest(
      validAgentManifest({
        dependencies: {
          skills: { "@appstrate/built-in-skill": "*" },
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("old array format for skills in dependencies is rejected", () => {
    const result = validateManifest(
      validAgentManifest({
        dependencies: {
          skills: ["@test/skill"],
        },
      }),
    );
    expect(result.valid).toBe(false);
  });

  // ─── schemaVersion format validation ───

  it("rejects schemaVersion with patch segment (1.0.0)", () => {
    const result = validateManifest(validAgentManifest({ schemaVersion: "1.0.0" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
  });

  it("rejects schemaVersion without minor segment (1)", () => {
    const result = validateManifest(validAgentManifest({ schemaVersion: "1" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
  });

  it("rejects schemaVersion with v prefix (v1.0)", () => {
    const result = validateManifest(validAgentManifest({ schemaVersion: "v1.0" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
  });

  it("rejects schemaVersion with wrong major (2.0)", () => {
    const result = validateManifest(validAgentManifest({ schemaVersion: "2.0" }));
    expect(result.valid).toBe(false);
  });

  it("accepts schemaVersion with higher minor (1.99)", () => {
    const result = validateManifest(validAgentManifest({ schemaVersion: "1.99" }));
    expect(result.valid).toBe(true);
  });

  // ─── Default manifest validation (all package types) ───

  it("default agent manifest (Hello World) is valid", () => {
    // Mirrors HELLO_WORLD_MANIFEST from strate/apps/api/src/services/default-agent.ts
    const manifest = {
      name: "@test-org/hello-world",
      version: "1.0.0",
      type: "agent",
      schemaVersion: "1.0",
      displayName: "Hello World",
      author: "Appstrate",
      description: "A demo agent",
      keywords: ["demo", "example", "getting-started"],
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("default agent manifest (agent-service fallback) is valid", () => {
    // Mirrors dbRowToLoadedAgent fallback in strate/apps/api/src/services/agent-service.ts
    // author is empty — tolerated by core for local drafts (AFPS requires it for publication)
    const manifest = {
      name: "@test-org/fallback-agent",
      version: "0.0.0",
      type: "agent",
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

  it("agent manifest without author is accepted (tolerant local editing)", () => {
    const { author: _, ...noAuthor } = validAgentManifest();
    const result = validateManifest(noAuthor);
    expect(result.valid).toBe(true);
  });

  it("default agent manifest (frontend defaultFormState) is valid", () => {
    // Mirrors assemblePayload output from strate/apps/web/src/components/agent-editor/utils.ts
    const manifest = {
      name: "@test-org/my-agent",
      version: "1.0.0",
      type: "agent",
      schemaVersion: "1.0",
      displayName: "My Agent",
      description: "An agent",
      author: "user@example.com",
      dependencies: { providers: {} },
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("default skill manifest (content-module-factory) is valid", () => {
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

  it("preserves unknown fields at all nesting levels (passthrough)", () => {
    const manifest = {
      ...validAgentManifest(),
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
  it("full manifest — all metadata extracted", () => {
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

  it("displayName — extracted when present", () => {
    const manifest = {
      name: "@test/my-agent",
      version: "1.0.0",
      type: "agent" as const,
      displayName: "My Custom Agent",
    } as Partial<Manifest>;
    const metadata = extractManifestMetadata(manifest);
    expect(metadata.displayName).toBe("My Custom Agent");
  });

  it("empty manifest — returns empty object", () => {
    const metadata = extractManifestMetadata({});
    expect(metadata.description).toBeUndefined();
    expect(metadata.keywords).toBeUndefined();
    expect(metadata.license).toBeUndefined();
    expect(metadata.repositoryUrl).toBeUndefined();
    expect(metadata.displayName).toBeUndefined();
  });

  it("partial manifest — only defined fields included", () => {
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
  it("valid frontmatter", () => {
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

  it("frontmatter with quoted values", () => {
    const content = `---
name: "quoted-name"
description: 'quoted description'
---`;
    const result = extractSkillMeta(content);
    expect(result.name).toBe("quoted-name");
    expect(result.description).toBe("quoted description");
  });

  it("frontmatter without name", () => {
    const content = `---
description: A skill without name
---`;
    const result = extractSkillMeta(content);
    expect(result.name).toBe("");
    expect(result.warnings.some((w) => w.includes("name"))).toBe(true);
  });

  it("no frontmatter", () => {
    const content = "Just some markdown content";
    const result = extractSkillMeta(content);
    expect(result.name).toBe("");
    expect(result.description).toBe("");
    expect(result.warnings.some((w) => w.includes("frontmatter"))).toBe(true);
  });
});
