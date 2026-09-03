// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  validateManifest,
  dropRetiredRuntimeTools,
  extractSkillMeta,
  agentManifestSchema,
  SUPPORTED_SCHEMA_VERSION_MAJOR,
} from "../src/validation.ts";
import { agentManifestSchema as afpsAgentManifestSchema } from "@afps-spec/schema";

// ─────────────────────────────────────────────
// Helpers — minimal valid manifests
// ─────────────────────────────────────────────

function validAgentManifest(overrides?: Record<string, unknown>) {
  return {
    name: "@test/my-agent",
    version: "1.0.0",
    type: "agent",
    schema_version: "0.1",
    display_name: "My Agent",
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

  it("missing type field rejects with a typed Unknown package type error", () => {
    // Without a `type`, validateManifest fails fast with a single typed Zod
    // issue keyed on `type` rather than running the permissive base schema.
    // This makes the dispatcher's contract explicit: `type` is the AFPS
    // discriminator and MUST be one of agent|skill|mcp-server|integration.
    const { type: _, ...noType } = validAgentManifest();
    const result = validateManifest(noType);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^type:.*Unknown package type/);
  });

  it("empty manifest emits the single dispatcher-level Unknown package type error", () => {
    // The dispatcher fails fast before the base schema runs, so we get one
    // typed error instead of an aggregate of name/version/type misses.
    const result = validateManifest({});
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^type:.*Unknown package type/);
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
      schema_version: "0.1",
      display_name: "Minimal Agent",
      author: "test",
      // dependencies, timeout, integrations_configuration intentionally omitted
    };

    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);

    // Zod output should NOT inject defaults anymore
    const m = result.manifest as Record<string, unknown>;
    expect(m.dependencies).toBeUndefined();
    expect(m.timeout).toBeUndefined();
    expect(m.integrations_configuration).toBeUndefined();
  });

  it("agent with dependencies (skills/mcp_servers/integrations) + runtime_tools", () => {
    const result = validateManifest(
      validAgentManifest({
        dependencies: {
          integrations: { "@test/gmail": "^1.0.0" },
          mcp_servers: { "@test/fetch": "^1.0.0" },
          skills: { "@test/skill": "^1.0.0", "@test/other": "~2.3.0" },
        },
        runtime_tools: ["log", "note"],
      }),
    );
    expect(result.valid).toBe(true);
    const m = result.manifest as Record<string, unknown>;
    const deps = m.dependencies as Record<string, unknown>;
    expect(deps.skills).toEqual({ "@test/skill": "^1.0.0", "@test/other": "~2.3.0" });
    expect(deps.integrations).toEqual({ "@test/gmail": "^1.0.0" });
    expect(deps.mcp_servers).toEqual({ "@test/fetch": "^1.0.0" });
    // Selectable runtime tools are the top-level snake_case `runtime_tools`.
    expect(m.runtime_tools).toEqual(["log", "note"]);
  });

  // `report` was a selectable runtime tool until it was replaced by durable
  // `outputs/` files. How an unknown id is treated depends on the
  // DIRECTION of the call, and both halves matter:
  //
  //   - author input (default) MUST reject — `["lgo"]` is a typo, and
  //     dropping it silently ships an agent missing its tool with no signal;
  //   - reading something already persisted MUST drop — a published ZIP is
  //     immutable, so rejecting would make a legacy agent unrunnable forever.
  it("rejects a retired runtime tool id on the author path (default policy)", () => {
    const result = validateManifest(
      validAgentManifest({ runtime_tools: ["report", "log", "output"] }),
    );
    expect(result.valid).toBe(false);
    // Surfaced on the runtime_tools field so the editor can render it.
    expect(result.errors.some((e) => e.startsWith("runtime_tools"))).toBe(true);
  });

  it("rejects a misspelled runtime tool id on the author path", () => {
    const result = validateManifest(validAgentManifest({ runtime_tools: ["lgo", "log"] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("runtime_tools"))).toBe(true);
  });

  it("drops a retired runtime tool id on the read path and reports what went", () => {
    const result = validateManifest(
      validAgentManifest({ runtime_tools: ["report", "log", "output"] }),
      { retiredRuntimeTools: "drop" },
    );
    expect(result.valid).toBe(true);
    expect((result.manifest as Record<string, unknown>).runtime_tools).toEqual(["log", "output"]);
    expect(result.valid && result.droppedRuntimeTools).toEqual(["report"]);
  });

  // The field is REMOVED, not emptied — the editor's `setRuntimeTools` drops it
  // on an empty selection too, so both writers emit the same bytes for an agent
  // left with no runtime tools.
  it("drops a retired runtime tool id even when it is the only one declared", () => {
    const result = validateManifest(validAgentManifest({ runtime_tools: ["report"] }), {
      retiredRuntimeTools: "drop",
    });
    expect(result.valid).toBe(true);
    expect((result.manifest as Record<string, unknown>).runtime_tools).toBeUndefined();
    expect(result.valid && result.droppedRuntimeTools).toEqual(["report"]);
  });

  // AFPS 1.x had `dependencies.tools` / `dependencies.providers`; AFPS 2.0
  // renamed them to `mcp_servers` / `integrations`. Every reader destructures
  // exactly `{ skills, mcp_servers, integrations }`, so the retired spelling is
  // inert — accepting it silently ships an agent whose dependency is never
  // resolved (#1021). Same direction split as the runtime-tools policy:
  // author input rejects, an already-persisted manifest is tolerated.
  it("rejects dependencies.tools on the author path, naming the replacement key", () => {
    const result = validateManifest(
      validAgentManifest({ dependencies: { tools: { "@appstrate/report": "^1.0.0" } } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toStartWith("dependencies.tools:");
    expect(result.errors[0]).toContain("dependencies.mcp_servers");
  });

  it("rejects dependencies.providers on the author path, naming the replacement key", () => {
    const result = validateManifest(
      validAgentManifest({ dependencies: { providers: { "@appstrate/gmail": "^1.0.0" } } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toStartWith("dependencies.providers:");
    expect(result.errors[0]).toContain("dependencies.integrations");
  });

  it("rejects every retired dependency key at once", () => {
    const result = validateManifest(
      validAgentManifest({ dependencies: { tools: {}, providers: {}, skills: {} } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  // Not agent-specific: any package type may declare `dependencies`.
  it("rejects a retired dependency key on a non-agent manifest", () => {
    const result = validateManifest(
      validSkillManifest({ dependencies: { tools: { "@test/x": "^1.0.0" } } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toStartWith("dependencies.tools:");
  });

  // THE anti-regression: a published manifest carrying the retired key is
  // re-validated on every run (`registry-run-resolver`). Rejecting it there
  // would 500 the run of an agent that can never be repaired in place, because
  // a published artifact is immutable + integrity-checked.
  it("tolerates a retired dependency key on the read path, untouched", () => {
    const stored = validAgentManifest({
      dependencies: {
        tools: { "@appstrate/report": "^1.0.0" },
        skills: { "@test/skill": "^1.0.0" },
      },
    });
    const result = validateManifest(stored, { retiredRuntimeTools: "drop" });
    expect(result.valid).toBe(true);
    const deps = (result.manifest as Record<string, unknown>).dependencies as Record<
      string,
      unknown
    >;
    // Tolerated means LEFT ALONE — this validator never rewrites stored bytes.
    expect(deps.tools).toEqual({ "@appstrate/report": "^1.0.0" });
    expect(deps.skills).toEqual({ "@test/skill": "^1.0.0" });
  });

  // The fix must not close `dependencies`: AFPS §10 mandates extensibility for
  // objects it does not explicitly close, so an unknown extension key stays legal.
  it("accepts the three canonical dependency maps plus an unrelated extension key", () => {
    const result = validateManifest(
      validAgentManifest({
        dependencies: {
          skills: { "@test/skill": "^1.0.0" },
          mcp_servers: { "@test/fetch": "^1.0.0" },
          integrations: { "@test/gmail": "^1.0.0" },
          _meta: { "dev.appstrate/note": "still legal" },
        },
      }),
    );
    expect(result.valid).toBe(true);
    const deps = (result.manifest as Record<string, unknown>).dependencies as Record<
      string,
      unknown
    >;
    expect(deps._meta).toEqual({ "dev.appstrate/note": "still legal" });
  });

  it("reports no dropped runtime tools when every id is known", () => {
    const result = validateManifest(validAgentManifest({ runtime_tools: ["log"] }), {
      retiredRuntimeTools: "drop",
    });
    expect(result.valid).toBe(true);
    expect(result.valid && result.droppedRuntimeTools).toEqual([]);
  });

  // The version-snapshot path serialises the result of this helper into an
  // integrity-hashed ZIP, so it must be structural: no Zod re-parse, no key
  // reordering, no injected defaults — otherwise publish dedup (#896) breaks.
  it("dropRetiredRuntimeTools preserves key order and unknown fields", () => {
    const stored = {
      name: "@test/my-agent",
      runtime_tools: ["report", "log"],
      custom_field: "must-survive",
      version: "1.0.0",
      type: "agent",
    };
    const { manifest, dropped } = dropRetiredRuntimeTools(stored);
    expect(dropped).toEqual(["report"]);
    expect(Object.keys(manifest)).toEqual(Object.keys(stored));
    expect(manifest.custom_field).toBe("must-survive");
    expect(manifest.runtime_tools).toEqual(["log"]);
  });

  // Absent and `[]` parse identically, but they are different bytes and the
  // agent editor's writer also drops the field on an empty selection — so the
  // two write paths must agree or one manifest gets two integrity hashes.
  it("dropRetiredRuntimeTools removes the key when nothing survives", () => {
    const stored = { type: "agent", name: "@test/a", runtime_tools: ["report"] };
    const { manifest, dropped } = dropRetiredRuntimeTools(stored);
    expect(dropped).toEqual(["report"]);
    expect("runtime_tools" in manifest).toBe(false);
    expect(manifest).toEqual({ type: "agent", name: "@test/a" });
  });

  it("dropRetiredRuntimeTools returns the same reference when nothing is retired", () => {
    const stored = { type: "agent", runtime_tools: ["log"] };
    expect(dropRetiredRuntimeTools(stored).manifest).toBe(stored);
  });

  // Settled empty-array representation. The helper deletes the key when a DROP
  // empties the list (test above), but an author-written `runtime_tools: []` is
  // left ALONE — it is a dropper, not a canonicaliser, and rewriting the bytes
  // of a manifest with nothing retired in it is exactly the blast-radius
  // widening the structural contract forbids (the result is serialised into an
  // integrity-hashed artifact by the publish path). Absent and `[]` stay two
  // accepted spellings; the guarantee is only that no platform writer mints the
  // second. Pinned here so neither direction can drift silently.
  it("dropRetiredRuntimeTools leaves an author-written empty runtime_tools untouched", () => {
    const stored = { type: "agent", name: "@test/a", runtime_tools: [] };
    const { manifest, dropped } = dropRetiredRuntimeTools(stored);
    expect(dropped).toEqual([]);
    // Same reference — no copy, no key deletion.
    expect(manifest).toBe(stored);
    expect("runtime_tools" in manifest).toBe(true);
    expect(manifest.runtime_tools).toEqual([]);
  });

  it("dropRetiredRuntimeTools leaves non-agent manifests untouched", () => {
    const stored = { type: "skill", runtime_tools: ["report"] };
    const { manifest, dropped } = dropRetiredRuntimeTools(stored);
    expect(manifest).toBe(stored);
    expect(dropped).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // An id the platform does not know: refused by direction, never guessed.
  //
  // `runtime_tools` is persisted inside agent manifests, including published
  // ZIPs that are immutable by construction, so the two directions cannot
  // share one rule. Author input is REJECTED (the author can still fix it);
  // a stored manifest has the id DROPPED and REPORTED (a hard rejection would
  // make the agent permanently unrunnable). `publish_document` — the retired
  // pre-#1177 spelling that used to be aliased forward — is the worked
  // example: it is now simply unknown.
  // -------------------------------------------------------------------------

  it("a stored manifest naming a retired id has it dropped AND reported", () => {
    const result = validateManifest(
      validAgentManifest({ runtime_tools: ["log", "publish_document"] }),
      { retiredRuntimeTools: "drop" },
    );
    expect(result.valid).toBe(true);
    // Reported — this is what makes the removal auditable instead of silent.
    expect(result.valid && result.droppedRuntimeTools).toEqual(["publish_document"]);
    // Dropped, NOT resolved to `publish_file`. The agent keeps its other tools.
    expect((result.manifest as Record<string, unknown>).runtime_tools).toEqual(["log"]);
  });

  it("an author saving a retired id is refused rather than corrected", () => {
    const result = validateManifest(validAgentManifest({ runtime_tools: ["publish_document"] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("runtime_tools"))).toBe(true);
  });

  it("dropRetiredRuntimeTools strips the unknown id and leaves the rest byte-identical", () => {
    // What the publish path serialises into the integrity-hashed ZIP: key
    // order and unknown fields survive, only the unknown id disappears.
    const stored = {
      name: "@test/my-agent",
      runtime_tools: ["log", "publish_document"],
      custom_field: "must-survive",
      type: "agent",
    };
    const { manifest, dropped } = dropRetiredRuntimeTools(stored);
    expect(dropped).toEqual(["publish_document"]);
    expect(Object.keys(manifest)).toEqual(Object.keys(stored));
    expect(manifest.custom_field).toBe("must-survive");
    expect(manifest.runtime_tools).toEqual(["log"]);
  });

  it("dropping the only id removes the key rather than leaving it empty", () => {
    const { manifest, dropped } = dropRetiredRuntimeTools({
      type: "agent",
      name: "@test/a",
      runtime_tools: ["publish_document"],
    });
    expect(dropped).toEqual(["publish_document"]);
    expect(manifest.runtime_tools).toBeUndefined();
  });

  it("an unknown id is rejected on the author path alongside a valid one", () => {
    const result = validateManifest(validAgentManifest({ runtime_tools: ["publish_file", "lgo"] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("runtime_tools"))).toBe(true);
  });

  it("agent with no output schema is valid without the `output` runtime tool", () => {
    // Side-effect-only run: do a task and finish, no result to return.
    const result = validateManifest(validAgentManifest({ runtime_tools: ["log"] }));
    expect(result.valid).toBe(true);
  });

  it("rejects an output schema when the `output` runtime tool is not selected", () => {
    const result = validateManifest(
      validAgentManifest({
        output: { schema: { type: "object", properties: { x: { type: "string" } } } },
        runtime_tools: ["log"],
      }),
    );
    expect(result.valid).toBe(false);
    // Error is surfaced on the runtime_tools field so the editor can render it.
    expect(result.errors.some((e) => e.startsWith("runtime_tools:"))).toBe(true);
  });

  it("accepts an output schema when the `output` runtime tool is selected", () => {
    const result = validateManifest(
      validAgentManifest({
        output: { schema: { type: "object", properties: { x: { type: "string" } } } },
        runtime_tools: ["output", "log"],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("agent with integrations declared as bare version string (canonical §4.1 form)", () => {
    const result = validateManifest(
      validAgentManifest({
        dependencies: {
          integrations: { "@test/gmail-mcp": "^1.0.0" },
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("accepts an integration dependency as a bare semver string (AFPS §4.1)", () => {
    const result = validateManifest(
      validAgentManifest({
        dependencies: {
          integrations: { "@test/gmail-mcp": "^1.0.0" },
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("accepts per-integration config in integrations_configuration with scopes + auth_key (§4.4)", () => {
    const result = validateManifest(
      validAgentManifest({
        dependencies: {
          integrations: { "@test/gmail-mcp": "^1.0.0" },
        },
        integrations_configuration: {
          "@test/gmail-mcp": {
            scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
            auth_key: "oauth",
          },
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("accepts the tools wildcard '*' in integrations_configuration (issue #547)", () => {
    const result = validateManifest(
      validAgentManifest({
        dependencies: {
          integrations: { "@test/gmail-mcp": "^1.0.0" },
        },
        integrations_configuration: {
          "@test/gmail-mcp": { tools: "*", auth_key: "primary" },
        },
      }),
    );
    expect(result.valid).toBe(true);
    const cfg = (
      result.manifest as { integrations_configuration?: Record<string, { tools?: unknown }> }
    ).integrations_configuration;
    expect(cfg?.["@test/gmail-mcp"]?.tools).toBe("*");
  });

  it("accepts an explicit tools array in integrations_configuration", () => {
    const result = validateManifest(
      validAgentManifest({
        dependencies: {
          integrations: { "@test/gmail-mcp": "^1.0.0" },
        },
        integrations_configuration: {
          "@test/gmail-mcp": { tools: ["send_email", "list_threads"] },
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects a non-wildcard string for integrations_configuration tools", () => {
    const result = validateManifest(
      validAgentManifest({
        dependencies: {
          integrations: { "@test/gmail-mcp": "^1.0.0" },
        },
        integrations_configuration: {
          "@test/gmail-mcp": { tools: "all" as unknown as string[] },
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("tools"))).toBe(true);
  });

  it("accepts skill + mcp_server dependency values as bare semver strings (§4.1)", () => {
    const result = validateManifest(
      validAgentManifest({
        dependencies: {
          skills: { "@test/skill": "^1.0.0" },
          mcp_servers: { "@test/mcp": "^2.0.0" },
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects an integration dependency in object form (§4.1)", () => {
    const result = validateManifest(
      validAgentManifest({
        dependencies: {
          integrations: {
            "@test/gmail-mcp": { version: "^1.0.0" } as unknown as string,
          },
        },
      }),
    );
    expect(result.valid).toBe(false);
  });

  it("rejects an integrations_configuration entry with no matching dependency (§4.4)", () => {
    const result = validateManifest(
      validAgentManifest({
        dependencies: {
          integrations: { "@test/gmail-mcp": "^1.0.0" },
        },
        integrations_configuration: {
          "@test/orphan": { tools: ["x"] },
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

  // ─── schema_version format validation (AFPS 0.x) ───

  it("rejects schema_version with patch segment (0.1.0)", () => {
    const result = validateManifest(validAgentManifest({ schema_version: "0.1.0" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("schema_version"))).toBe(true);
  });

  it("rejects schema_version without minor segment (0)", () => {
    const result = validateManifest(validAgentManifest({ schema_version: "0" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("schema_version"))).toBe(true);
  });

  it("rejects schema_version with v prefix (v0.1)", () => {
    const result = validateManifest(validAgentManifest({ schema_version: "v0.1" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("schema_version"))).toBe(true);
  });

  it("rejects schema_version with wrong major (1.0)", () => {
    const result = validateManifest(validAgentManifest({ schema_version: "1.0" }));
    expect(result.valid).toBe(false);
  });

  it("accepts schema_version with higher minor (0.99)", () => {
    const result = validateManifest(validAgentManifest({ schema_version: "0.99" }));
    expect(result.valid).toBe(true);
  });

  // ─── Default manifest validation (all package types) ───

  it("default agent manifest (Hello World) is valid", () => {
    // Mirrors HELLO_WORLD_MANIFEST from strate/apps/api/src/services/default-agent.ts
    const manifest = {
      name: "@test-org/hello-world",
      version: "1.0.0",
      type: "agent",
      schema_version: "0.1",
      display_name: "Hello World",
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
      schema_version: "0.1",
      display_name: "Fallback",
      author: "",
      description: "",
      dependencies: { integrations: {} },
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
      schema_version: "0.1",
      display_name: "My Agent",
      description: "An agent",
      author: "user@example.com",
      dependencies: { integrations: {} },
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
      schema_version: "0.1",
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
        integrations: { "@test/google": "^1.0.0" },
        skills: {},
        mcp_servers: {},
        customDepsField: "preserved",
      },
      integrations_configuration: {
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

    const cfg = m.integrations_configuration as Record<string, Record<string, unknown>>;
    expect(cfg["@test/google"]!.customConfigField).toBe(true);
  });
});

// ─────────────────────────────────────────────
// validateManifest — all four AFPS package types
// ─────────────────────────────────────────────

describe("validateManifest — package-type dispatch", () => {
  it("dispatches an integration manifest", () => {
    const r = validateManifest({
      name: "@test/gmail",
      version: "1.0.0",
      type: "integration",
      schema_version: "0.1",
      display_name: "Gmail",
      source: { kind: "remote", remote: { url: "https://x/mcp", transport: "streamable-http" } },
      auths: {
        oauth: {
          type: "oauth2",
          issuer: "https://idp",
          authorized_uris: ["https://api/**"],
          delivery: {
            http: { in: "header", name: "Authorization", value: "{$credential.access_token}" },
          },
        },
      },
    });
    expect(r.valid).toBe(true);
  });

  it("dispatches an mcp-server manifest via root identity (AFPS §3.4)", () => {
    const r = validateManifest({
      manifest_version: "0.3",
      name: "@test/fetch-json",
      version: "1.0.0",
      type: "mcp-server",
      schema_version: "0.1",
      display_name: "Fetch JSON",
      server: {
        type: "node",
        entry_point: "server/index.js",
        mcp_config: { command: "node", args: ["server/index.js"] },
      },
    });
    expect(r.valid).toBe(true);
  });

  it("rejects an mcp-server manifest with no root identity", () => {
    const r = validateManifest({
      manifest_version: "0.3",
      name: "@test/fetch-json",
      version: "1.0.0",
      // missing type: "mcp-server"
      server: {
        type: "node",
        entry_point: "server/index.js",
        mcp_config: { command: "node" },
      },
    });
    // No root `type` → dispatcher fails fast with the typed Unknown-package-type
    // error (AFPS requires `type` as the discriminator).
    expect(r.valid).toBe(false);
  });

  it("rejects an mcp-server with uv server type on manifest_version 0.3", () => {
    const r = validateManifest({
      manifest_version: "0.3",
      name: "@test/uv-srv",
      version: "1.0.0",
      type: "mcp-server",
      schema_version: "0.1",
      server: { type: "uv", entry_point: "main.py", mcp_config: { command: "uv" } },
    });
    expect(r.valid).toBe(false);
  });
});

// ─────────────────────────────────────────────
// validateManifest — v2 §3.1 common fields
// ─────────────────────────────────────────────

describe("validateManifest — v2 common fields (§3.1)", () => {
  it("accepts a manifest declaring every v2 common field at once", () => {
    const result = validateManifest(
      validSkillManifest({
        long_description: "Detailed prose",
        homepage: "https://example.com",
        documentation: "https://docs.example.com",
        support: "https://example.com/issues",
        icon: "icon.png",
        icons: [{ src: "icon-128.png", size: "128x128", theme: "dark" }],
        screenshots: ["s1.png"],
        privacy_policies: ["https://example.com/privacy"],
        compatibility: { platforms: ["darwin"], runtimes: { node: ">=18" } },
        author: "Jane Doe",
        repository: "https://github.com/test/repo",
        _meta: { "com.example.x": { foo: "bar" } },
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("author — accepts structured object form", () => {
    const result = validateManifest(
      validSkillManifest({
        author: { name: "Jane Doe", email: "jane@example.com", url: "https://jane.example" },
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("author — accepts bare string form", () => {
    const result = validateManifest(validSkillManifest({ author: "Jane Doe" }));
    expect(result.valid).toBe(true);
  });

  it("repository — accepts structured object form", () => {
    const result = validateManifest(
      validSkillManifest({
        repository: {
          type: "git",
          url: "https://github.com/test/repo.git",
          directory: "packages/pkg",
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("repository — accepts bare string form", () => {
    const result = validateManifest(
      validSkillManifest({ repository: "https://github.com/test/repo" }),
    );
    expect(result.valid).toBe(true);
  });

  it("icons — rejects malformed size", () => {
    // The base manifestSchema (used when type doesn't dispatch elsewhere) and
    // the skill schema both inherit the icon-object regex from AFPS. Bad size
    // strings must surface as validation errors.
    const result = validateManifest(
      validSkillManifest({ icons: [{ src: "icon.png", size: "not-a-size" }] }),
    );
    expect(result.valid).toBe(false);
  });

  it("_meta — accepts reverse-DNS-namespaced keys (round-trips)", () => {
    const result = validateManifest(
      validSkillManifest({
        _meta: {
          "com.example.publisher": { reviewedBy: "ops" },
          "dev.afps.audit": { trail: ["a", "b"] },
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("_meta — rejects scalar values under a namespace key (§10.1 strictness)", () => {
    // AFPS §10.1: `_meta.<reverse-dns-key>` MUST be a JSON object. The canonical
    // schema enforces this — the previous appstrate-local laxer copy accepted
    // strings/numbers/booleans which was a spec gap. Audit finding 1.15.
    const result = validateManifest(
      validSkillManifest({
        _meta: {
          "dev.appstrate/foo": "string-not-object",
        },
      }),
    );
    expect(result.valid).toBe(false);
  });

  it("_meta — rejects arrays and other non-object values under a namespace key", () => {
    const result = validateManifest(
      validSkillManifest({
        _meta: {
          "com.example.x": [1, 2, 3],
        },
      }),
    );
    expect(result.valid).toBe(false);
  });

  it("common-field shapes — accept the canonical agent-full example (drift snapshot)", () => {
    // Audit 1.15 drift gate: the local common-field shapes (authorObject /
    // repositoryObject / iconObject / compatibilityObject) must accept anything
    // the canonical AFPS `agentManifestSchema` accepts. We pin a representative
    // sample derived from `afps-spec/examples/agent-full/manifest.json` and
    // assert BOTH schemas validate it. If `@afps-spec/schema` ever tightens one
    // of these shapes (e.g. requires `repository.directory`), the local copy
    // will silently keep accepting the looser shape and this test will catch
    // the divergence on the next CI run.
    const sample = {
      name: "@example/customer-intake",
      version: "1.2.0",
      type: "agent",
      schema_version: "0.1",
      display_name: "Customer Intake Assistant",
      description: "Collects inbound requests and prepares a structured summary.",
      keywords: ["workflow", "intake", "support"],
      license: "MIT",
      repository: "https://example.com/afps/customer-intake",
      author: "AFPS Examples",
      icons: [{ src: "icon-128.png", size: "128x128", theme: "dark" as const }],
      compatibility: {
        platforms: ["darwin", "linux"] as Array<"darwin" | "linux">,
        runtimes: { node: ">=18" },
      },
    };

    // Canonical schema must accept it.
    const canonical = afpsAgentManifestSchema.safeParse(sample);
    expect(canonical.success).toBe(true);

    // Local schema (via validateManifest dispatch) must accept it too.
    const local = validateManifest(sample);
    expect(local.valid).toBe(true);
  });

  it("common-field shapes — author/repository object forms parity (drift snapshot)", () => {
    const sample = {
      name: "@example/pkg",
      version: "1.0.0",
      type: "agent" as const,
      schema_version: "0.1",
      display_name: "Pkg",
      author: { name: "Jane", email: "jane@example.com", url: "https://jane.example" },
      repository: {
        type: "git",
        url: "https://github.com/test/repo.git",
        directory: "packages/pkg",
      },
    };
    const canonical = afpsAgentManifestSchema.safeParse(sample);
    expect(canonical.success).toBe(true);

    const local = validateManifest(sample);
    expect(local.valid).toBe(true);
  });

  // ── schema_version MAJOR-policy (§2.4) ──

  it("schema_version — agent schema rejects forward-major (3.0) at the Zod boundary", () => {
    // Per AFPS §2.4, consumers MUST reject manifests whose MAJOR exceeds the
    // highest supported. The lift into the common manifest schema means
    // programmatic `safeParse` calls now fail at the schema boundary, not only
    // at the bundle/DB layer.
    const result = agentManifestSchema.safeParse({
      name: "@test/my-agent",
      version: "1.0.0",
      type: "agent",
      schema_version: "3.0",
      display_name: "My Agent",
      author: "test",
    });
    expect(result.success).toBe(false);
  });

  it("schema_version — agent schema accepts higher MINOR (0.5) as best-effort (§2.4)", () => {
    const result = agentManifestSchema.safeParse({
      name: "@test/my-agent",
      version: "1.0.0",
      type: "agent",
      schema_version: "0.5",
      display_name: "My Agent",
      author: "test",
    });
    expect(result.success).toBe(true);
  });

  it("schema_version — SUPPORTED_SCHEMA_VERSION_MAJOR is 0", () => {
    // Constant pinning so a future bump becomes a deliberate code edit.
    expect(SUPPORTED_SCHEMA_VERSION_MAJOR).toBe(0);
  });

  // ── _meta strict-reject malformed namespace keys (AFPS 0.1, §2 + §10.1) ──

  it("_meta — hard-rejects malformed namespace key (§2 — malformed key = malformed package)", () => {
    // AFPS 0.1 makes the upstream `metaSchema` STRICT. A key like `nodots/foo`
    // violates Appendix B's META_NAMESPACE_KEY regex (a `/`-prefixed key's
    // namespace must contain at least one `.`), so it is a malformed key — and
    // a malformed key makes the package malformed, which consumers MUST reject
    // (§2). Only WELL-FORMED unknown namespaces are tolerated (§10.1); malformed
    // keys are rejected at parse time, no warning emitted.
    const result = validateManifest(
      validSkillManifest({
        _meta: {
          "nodots/foo": { foo: "bar" },
        },
      }),
    );
    expect(result.valid).toBe(false);
    // The rejection must reference the `_meta` path / offending key.
    expect(result.errors.some((e) => e.includes("_meta") || e.includes("nodots/foo"))).toBe(true);
  });

  it("_meta — bare key with no namespace prefix is accepted (matches META_NAMESPACE_KEY)", () => {
    // The Appendix B regex makes the namespace prefix optional; a bare key
    // like `bare-key` is structurally valid (`[A-Za-z0-9._-]+`). No warning,
    // no reject.
    const result = validateManifest(
      validSkillManifest({
        _meta: {
          "bare-key": { foo: "bar" },
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("_meta — still hard-rejects the reserved MCP prefixes (§10)", () => {
    // Producers MUST NOT use `mcp/` / `modelcontextprotocol/`. The §10 reservation
    // is strictly stronger than §10.1's "don't reject unknown keys" rule.
    const result = validateManifest(
      validSkillManifest({
        _meta: {
          "mcp/foo": { bar: "baz" },
        },
      }),
    );
    expect(result.valid).toBe(false);
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

  // These two lock the delegation to `parseSkillFrontmatter`: a
  // Windows-authored SKILL.md the gate accepts must not read as metadata-less
  // here, and a BOM'd one must read as nothing at all.
  it("reads CRLF line endings", () => {
    const result = extractSkillMeta("---\r\nname: my-skill\r\ndescription: A skill\r\n---\r\nBody");
    expect(result.name).toBe("my-skill");
    expect(result.description).toBe("A skill");
    expect(result.warnings).toHaveLength(0);
  });

  it("reads nothing behind a UTF-8 BOM, exactly as the runtime does", () => {
    const result = extractSkillMeta("\uFEFF---\nname: my-skill\ndescription: A skill\n---\nBody");
    expect(result.name).toBe("");
    expect(result.description).toBe("");
    expect(result.warnings.some((w) => w.includes("frontmatter"))).toBe(true);
  });
});
