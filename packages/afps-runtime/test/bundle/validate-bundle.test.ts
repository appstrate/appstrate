// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { buildBundleFromCatalog } from "../../src/bundle/build.ts";
import { InMemoryPackageCatalog, emptyPackageCatalog } from "../../src/bundle/catalog.ts";
import {
  computeRecordEntries,
  recordIntegrity,
  serializeRecord,
} from "../../src/bundle/integrity.ts";
import { validateBundle } from "../../src/bundle/validate-bundle.ts";
import type { BundlePackage, PackageIdentity } from "../../src/bundle/types.ts";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makePkg(
  identity: PackageIdentity,
  manifest: Record<string, unknown>,
  extras: Record<string, Uint8Array> = {},
): BundlePackage {
  const files = new Map<string, Uint8Array>([
    ["manifest.json", enc(JSON.stringify(manifest))],
    ...Object.entries(extras),
  ]);
  return {
    identity,
    manifest,
    files,
    integrity: recordIntegrity(serializeRecord(computeRecordEntries(files))),
  };
}

const VALID_AGENT = {
  name: "@me/root",
  version: "1.0.0",
  type: "agent",
  schema_version: "0.1",
  display_name: "Root",
  author: "tester",
};

const VALID_SKILL = {
  name: "@me/a",
  version: "1.0.0",
  type: "skill",
  schema_version: "0.1",
};

/**
 * SKILL.md fixture with valid YAML frontmatter `name`. AFPS §3.3 requires
 * skill packages to declare a `name` frontmatter — the validator + the
 * runtime bundle loader both reject SKILL.md without it (covered by the
 * dedicated conformance cases).
 */
const VALID_SKILL_MD = enc("---\nname: skill\n---\nbody");

/** A valid AFPS mcp-server manifest (MCPB shape + root identity). */
const VALID_MCP_SERVER = {
  manifest_version: "0.3",
  name: "@me/mcp",
  version: "1.0.0",
  type: "mcp-server",
  schema_version: "0.1",
  display_name: "My MCP Server",
  server: {
    type: "node",
    entry_point: "server/index.js",
    mcp_config: { command: "node", args: ["server/index.js"] },
  },
};

/** A valid AFPS integration manifest (snake_case, `source` discriminant). */
const VALID_INTEGRATION = {
  name: "@me/integ",
  version: "1.0.0",
  type: "integration",
  schema_version: "0.1",
  display_name: "My Integration",
  source: { kind: "api", api: {} },
  auths: {
    api: {
      type: "api_key",
      credentials: { schema: { type: "object", properties: { token: { type: "string" } } } },
      authorized_uris: ["https://api.example.com/**"],
      delivery: { env: { API_TOKEN: { value: "{$credential.token}" } } },
    },
  },
};

describe("validateBundle (AFPS)", () => {
  it("accepts a valid single-package agent bundle", async () => {
    const root = makePkg("@me/root@1.0.0" as PackageIdentity, VALID_AGENT, {
      "prompt.md": enc("Hello {{input.task}}."),
    });
    const bundle = await buildBundleFromCatalog(root, emptyPackageCatalog);
    const result = validateBundle(bundle);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("rejects a non-agent root by default", async () => {
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...VALID_AGENT, type: "skill" },
      { "prompt.md": enc("hi") },
    );
    const bundle = await buildBundleFromCatalog(root, emptyPackageCatalog);
    const result = validateBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "UNSUPPORTED_TYPE")).toBe(true);
  });

  it("rejects a schema_version with an unsupported MAJOR (afps-spec regex)", async () => {
    // The v0 afps-spec schema constrains schema_version to /^0\./, so a 1.x
    // value surfaces as a MANIFEST_SCHEMA error on schema_version.
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...VALID_AGENT, schema_version: "1.1" },
      { "prompt.md": enc("p") },
    );
    const bundle = await buildBundleFromCatalog(root, emptyPackageCatalog);
    const result = validateBundle(bundle);
    expect(
      result.issues.some(
        (i) => i.code === "MANIFEST_SCHEMA" && i.path === "manifest.schema_version",
      ),
    ).toBe(true);
  });

  it("rejects an AFPS 1.x camelCase manifest (the migration's headline contract)", async () => {
    // Spec-fidelity gate: the snake_case migration's whole point is that the
    // wire-format casing flipped. A fully-camelCased 1.x manifest must NOT
    // be silently accepted — it must hit MANIFEST_SCHEMA errors on both
    // `schemaVersion` (unknown field via missing `schema_version`) and the
    // 1.x-style top-level keys (`displayName`, `fileConstraints`, …).
    const legacyCamelCaseManifest = {
      name: "@me/root",
      version: "1.0.0",
      type: "agent",
      schemaVersion: "1.1",
      displayName: "Legacy Agent",
      // 1.x wrapper keys that don't exist in the current AFPS shape:
      input: {
        schema: { type: "object", properties: { task: { type: "string" } } },
        fileConstraints: { upload: { accept: ["text/plain"], maxSize: 1024 } },
        uiHints: { task: { placeholder: "Type something" } },
        propertyOrder: ["task"],
      },
    };
    const root = makePkg("@me/root@1.0.0" as PackageIdentity, legacyCamelCaseManifest, {
      "prompt.md": enc("p"),
    });
    const bundle = await buildBundleFromCatalog(root, emptyPackageCatalog);
    const result = validateBundle(bundle);

    expect(result.valid).toBe(false);
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    // The missing snake_case `schema_version` must be flagged — that's the
    // strongest single signal the migration's contract is enforced.
    expect(
      result.issues.some(
        (i) =>
          (i.code === "MANIFEST_SCHEMA" || i.code === "SCHEMA_VERSION_MISSING") &&
          i.path.includes("schema_version"),
      ),
    ).toBe(true);
  });

  it("rejects a manifest that mixes 1.x camelCase + 2.0 snake_case wrapper keys", async () => {
    // A half-migrated manifest where someone renamed schema_version → "0.1"
    // but kept 1.x wrapper keys (fileConstraints, uiHints, …) must still fail.
    // The afps-spec schema rejects unknown keys at the wrapper level via
    // strict object validation — this pins that no 1.x relic survives the
    // schema_version=0.1 declaration.
    const mixedManifest = {
      name: "@me/root",
      version: "1.0.0",
      type: "agent",
      schema_version: "0.1",
      display_name: "Half-migrated Agent",
      input: {
        schema: { type: "object", properties: { task: { type: "string" } } },
        // 2.0 expects file_constraints; this 1.x camelCase form must be rejected.
        fileConstraints: { upload: { accept: ["text/plain"] } },
      },
    };
    const root = makePkg("@me/root@1.0.0" as PackageIdentity, mixedManifest, {
      "prompt.md": enc("p"),
    });
    const bundle = await buildBundleFromCatalog(root, emptyPackageCatalog);
    const result = validateBundle(bundle);

    // Either the schema rejects fileConstraints as unknown OR it strips it
    // silently. Strict-object semantics in AFPS mandate the former; this
    // test pins that contract.
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(
      errors.length > 0 ||
        // Tolerant alternative: passes but the camelCase key is stripped at
        // round-trip so it cannot affect runtime behaviour. Either is OK as
        // long as it's not silently kept.
        result.issues.some((i) => i.code === "MANIFEST_SCHEMA"),
    ).toBe(true);
  });

  it("flags an unsupported MAJOR via the runtime supportedMajors policy", async () => {
    // A structurally-valid v0 manifest, but the runtime restricts to majors [3].
    const root = makePkg("@me/root@1.0.0" as PackageIdentity, VALID_AGENT, {
      "prompt.md": enc("p"),
    });
    const bundle = await buildBundleFromCatalog(root, emptyPackageCatalog);
    const result = validateBundle(bundle, { supportedMajors: [3] });
    expect(
      result.issues.some(
        (i) => i.code === "SCHEMA_VERSION_UNSUPPORTED" && i.path === "manifest.schema_version",
      ),
    ).toBe(true);
  });

  it("flags a missing schema_version on an agent (via afps-spec schema)", async () => {
    const manifestWithoutSchemaVersion: Record<string, unknown> = { ...VALID_AGENT };
    delete manifestWithoutSchemaVersion.schema_version;
    const root = makePkg("@me/root@1.0.0" as PackageIdentity, manifestWithoutSchemaVersion, {
      "prompt.md": enc("p"),
    });
    const bundle = await buildBundleFromCatalog(root, emptyPackageCatalog);
    const result = validateBundle(bundle);
    // afps-spec/schema makes schema_version REQUIRED for agents at the Zod
    // level, so MANIFEST_SCHEMA fires — either code is an error signal.
    const fired = result.issues.some(
      (i) =>
        (i.code === "SCHEMA_VERSION_MISSING" || i.code === "MANIFEST_SCHEMA") &&
        i.path.includes("schema_version"),
    );
    expect(fired).toBe(true);
  });

  it("flags broken Mustache templates", async () => {
    const root = makePkg("@me/root@1.0.0" as PackageIdentity, VALID_AGENT, {
      "prompt.md": enc("{{#unclosed"),
    });
    const bundle = await buildBundleFromCatalog(root, emptyPackageCatalog);
    const result = validateBundle(bundle);
    expect(result.issues.some((i) => i.code === "TEMPLATE_SYNTAX")).toBe(true);
  });

  it("warns on cycles (non-fatal)", async () => {
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      {
        ...VALID_AGENT,
        dependencies: { skills: { "@me/a": "^1" } },
      },
      { "prompt.md": enc("p") },
    );
    const a = makePkg(
      "@me/a@1.0.0" as PackageIdentity,
      {
        ...VALID_SKILL,
        dependencies: { skills: { "@me/b": "^1" } },
      },
      { "SKILL.md": VALID_SKILL_MD },
    );
    const b = makePkg(
      "@me/b@1.0.0" as PackageIdentity,
      {
        name: "@me/b",
        version: "1.0.0",
        type: "skill",
        schema_version: "0.1",
        dependencies: { skills: { "@me/a": "^1" } },
      },
      { "SKILL.md": VALID_SKILL_MD },
    );
    const cat = new InMemoryPackageCatalog([a, b]);
    const bundle = await buildBundleFromCatalog(root, cat);
    const result = validateBundle(bundle);
    expect(result.valid).toBe(true); // warnings, not errors
    expect(result.issues.some((i) => i.code === "CYCLE_DETECTED")).toBe(true);
  });

  it("warns on divergent versions of the same package", async () => {
    // Hand-build a bundle with two versions of the same package — this
    // normally shouldn't happen, but the validator is the last line of
    // defence.
    const root = makePkg("@me/root@1.0.0" as PackageIdentity, VALID_AGENT, {
      "prompt.md": enc("p"),
    });
    const a1 = makePkg(
      "@me/dup@1.0.0" as PackageIdentity,
      { name: "@me/dup", version: "1.0.0", type: "skill", schema_version: "0.1" },
      { "SKILL.md": VALID_SKILL_MD },
    );
    const a2 = makePkg(
      "@me/dup@1.1.0" as PackageIdentity,
      { name: "@me/dup", version: "1.1.0", type: "skill", schema_version: "0.1" },
      { "SKILL.md": VALID_SKILL_MD },
    );
    const bundle = await buildBundleFromCatalog(root, emptyPackageCatalog);
    // Splice both versions in manually (buildBundleFromCatalog would
    // have deduped; we're testing the validator's independent check).
    const spliced = {
      ...bundle,
      packages: new Map([...bundle.packages, [a1.identity, a1], [a2.identity, a2]]),
    };
    const result = validateBundle(spliced);
    expect(result.issues.some((i) => i.code === "VERSION_DIVERGENCE")).toBe(true);
  });

  // ── 4-type model coverage: non-root dependency packages ──

  it("accepts a valid skill dependency", async () => {
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...VALID_AGENT, dependencies: { skills: { "@me/a": "^1" } } },
      { "prompt.md": enc("p") },
    );
    const skill = makePkg("@me/a@1.0.0" as PackageIdentity, VALID_SKILL, {
      "SKILL.md": VALID_SKILL_MD,
    });
    const bundle = await buildBundleFromCatalog(root, new InMemoryPackageCatalog([skill]));
    const result = validateBundle(bundle);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("accepts a valid mcp-server dependency (MCPB manifest, _meta identity)", async () => {
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...VALID_AGENT, dependencies: { mcp_servers: { "@me/mcp": "^1" } } },
      { "prompt.md": enc("p") },
    );
    const mcp = makePkg("@me/mcp@1.0.0" as PackageIdentity, VALID_MCP_SERVER, {
      "server/index.js": enc("//"),
    });
    const bundle = await buildBundleFromCatalog(root, new InMemoryPackageCatalog([mcp]));
    const result = validateBundle(bundle);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("rejects an mcp-server with a corrupt root identity (unscoped name)", async () => {
    // AFPS lifted the scoped identity to the manifest root. The schema's
    // root `name` regex enforces `@scope/name`, so an unscoped value MUST be
    // rejected.
    const badMcp = {
      ...VALID_MCP_SERVER,
      name: "not-scoped",
    };
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...VALID_AGENT, dependencies: { mcp_servers: { "@me/mcp": "^1" } } },
      { "prompt.md": enc("p") },
    );
    const mcp = makePkg("@me/mcp@1.0.0" as PackageIdentity, badMcp, {
      "server/index.js": enc("//"),
    });
    const bundle = await buildBundleFromCatalog(root, new InMemoryPackageCatalog([mcp]));
    const result = validateBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "MANIFEST_SCHEMA" && i.path.includes("name"))).toBe(
      true,
    );
  });

  it("flags an mcp-server with no root type as unsupported", async () => {
    // Without `type: "mcp-server"` at the root (AFPS §3.4), the package
    // is genuinely unidentifiable and surfaces as UNSUPPORTED_TYPE.
    const orphan = { ...VALID_MCP_SERVER } as Record<string, unknown>;
    delete orphan.type;
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...VALID_AGENT, dependencies: { mcp_servers: { "@me/mcp": "^1" } } },
      { "prompt.md": enc("p") },
    );
    const mcp = makePkg("@me/mcp@1.0.0" as PackageIdentity, orphan, {
      "server/index.js": enc("//"),
    });
    const bundle = await buildBundleFromCatalog(root, new InMemoryPackageCatalog([mcp]));
    const result = validateBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "UNSUPPORTED_TYPE")).toBe(true);
  });

  it("accepts a valid integration dependency (AFPS snake_case)", async () => {
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...VALID_AGENT, dependencies: { integrations: { "@me/integ": "^1" } } },
      { "prompt.md": enc("p") },
    );
    const integ = makePkg("@me/integ@1.0.0" as PackageIdentity, VALID_INTEGRATION);
    const bundle = await buildBundleFromCatalog(root, new InMemoryPackageCatalog([integ]));
    const result = validateBundle(bundle);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("rejects an integration with no auth methods", async () => {
    const badInteg = { ...VALID_INTEGRATION, auths: {} };
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...VALID_AGENT, dependencies: { integrations: { "@me/integ": "^1" } } },
      { "prompt.md": enc("p") },
    );
    const integ = makePkg("@me/integ@1.0.0" as PackageIdentity, badInteg);
    const bundle = await buildBundleFromCatalog(root, new InMemoryPackageCatalog([integ]));
    const result = validateBundle(bundle);
    expect(result.valid).toBe(false);
    expect(
      result.issues.some((i) => i.code === "MANIFEST_SCHEMA" && i.path.includes("auths")),
    ).toBe(true);
  });

  it("rejects an integration with an invalid source discriminant", async () => {
    const badInteg = { ...VALID_INTEGRATION, source: { kind: "nonsense" } };
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...VALID_AGENT, dependencies: { integrations: { "@me/integ": "^1" } } },
      { "prompt.md": enc("p") },
    );
    const integ = makePkg("@me/integ@1.0.0" as PackageIdentity, badInteg);
    const bundle = await buildBundleFromCatalog(root, new InMemoryPackageCatalog([integ]));
    const result = validateBundle(bundle);
    expect(result.valid).toBe(false);
    expect(
      result.issues.some((i) => i.code === "MANIFEST_SCHEMA" && i.path.includes("source")),
    ).toBe(true);
  });

  it("accepts a skill dependency that omits schema_version (optional for non-agents)", async () => {
    const skillNoVersion: Record<string, unknown> = { ...VALID_SKILL };
    delete skillNoVersion.schema_version;
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...VALID_AGENT, dependencies: { skills: { "@me/a": "^1" } } },
      { "prompt.md": enc("p") },
    );
    const skill = makePkg("@me/a@1.0.0" as PackageIdentity, skillNoVersion, {
      "SKILL.md": VALID_SKILL_MD,
    });
    const bundle = await buildBundleFromCatalog(root, new InMemoryPackageCatalog([skill]));
    const result = validateBundle(bundle);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("flags an unsupported MAJOR on a skill dependency via supportedMajors policy", async () => {
    // A structurally-valid v0 skill, but the runtime restricts to majors [3].
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...VALID_AGENT, dependencies: { skills: { "@me/a": "^1" } } },
      { "prompt.md": enc("p") },
    );
    const skill = makePkg("@me/a@1.0.0" as PackageIdentity, VALID_SKILL, {
      "SKILL.md": VALID_SKILL_MD,
    });
    const bundle = await buildBundleFromCatalog(root, new InMemoryPackageCatalog([skill]));
    const result = validateBundle(bundle, { supportedMajors: [0, 3] });
    // root agent is 0.1 (ok); skill is 0.1 too, so [0,3] passes. Restrict to [3].
    const restricted = validateBundle(bundle, { supportedMajors: [3] });
    expect(result.valid).toBe(true);
    expect(
      restricted.issues.some(
        (i) =>
          i.code === "SCHEMA_VERSION_UNSUPPORTED" &&
          i.identity === ("@me/a@1.0.0" as PackageIdentity),
      ),
    ).toBe(true);
  });

  it("flags an unknown package type on a dependency", async () => {
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...VALID_AGENT, dependencies: { skills: { "@me/x": "^1" } } },
      { "prompt.md": enc("p") },
    );
    const bogus = makePkg("@me/x@1.0.0" as PackageIdentity, {
      name: "@me/x",
      version: "1.0.0",
      type: "tool", // removed AFPS package type
      schema_version: "0.1",
    });
    const bundle = await buildBundleFromCatalog(root, new InMemoryPackageCatalog([bogus]));
    const result = validateBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "UNSUPPORTED_TYPE")).toBe(true);
  });

  // ── §3.3 / §3.4 companion-file enforcement — direct validator coverage ──
  // The conformance harness (L1.10/L1.11/L1.13) exercises these through the
  // loadBundle route; these tests pin the validateBundle()-level contract so
  // a regression in the shared companion-files helper that returned `null`
  // for an entire type (e.g. mcp-server) would be caught by the unit suite
  // independently of the conformance harness.

  it("flags an agent missing prompt.md with COMPANION_FILE_MISSING", async () => {
    // Agent root without prompt.md companion (AFPS §3.3 requires it).
    const root = makePkg("@me/root@1.0.0" as PackageIdentity, VALID_AGENT);
    const bundle = await buildBundleFromCatalog(root, emptyPackageCatalog);
    const result = validateBundle(bundle);
    expect(result.valid).toBe(false);
    const issue = result.issues.find((i) => i.code === "COMPANION_FILE_MISSING");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
    expect(issue?.identity).toBe("@me/root@1.0.0" as PackageIdentity);
  });

  it("flags a skill missing SKILL.md with COMPANION_FILE_MISSING", async () => {
    // Skill dependency without SKILL.md companion (AFPS §3.3 requires it).
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...VALID_AGENT, dependencies: { skills: { "@me/a": "^1" } } },
      { "prompt.md": enc("p") },
    );
    const skill = makePkg("@me/a@1.0.0" as PackageIdentity, VALID_SKILL);
    const bundle = await buildBundleFromCatalog(root, new InMemoryPackageCatalog([skill]));
    const result = validateBundle(bundle);
    expect(result.valid).toBe(false);
    const issue = result.issues.find(
      (i) =>
        i.code === "COMPANION_FILE_MISSING" && i.identity === ("@me/a@1.0.0" as PackageIdentity),
    );
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
  });

  it("flags an mcp-server missing server.entry_point payload with COMPANION_FILE_MISSING", async () => {
    // mcp-server manifest references `server/index.js` via entry_point, but
    // the file is absent from the package (AFPS §3.4 requires the payload).
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...VALID_AGENT, dependencies: { mcp_servers: { "@me/mcp": "^1" } } },
      { "prompt.md": enc("p") },
    );
    const mcp = makePkg("@me/mcp@1.0.0" as PackageIdentity, VALID_MCP_SERVER);
    const bundle = await buildBundleFromCatalog(root, new InMemoryPackageCatalog([mcp]));
    const result = validateBundle(bundle);
    expect(result.valid).toBe(false);
    const issue = result.issues.find(
      (i) =>
        i.code === "COMPANION_FILE_MISSING" && i.identity === ("@me/mcp@1.0.0" as PackageIdentity),
    );
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
  });
});
