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
  schema_version: "2.0",
  display_name: "Root",
  author: "tester",
};

const VALID_SKILL = {
  name: "@me/a",
  version: "1.0.0",
  type: "skill",
  schema_version: "2.0",
};

/** A valid AFPS 2.0 mcp-server manifest (MCPB shape + _meta identity). */
const VALID_MCP_SERVER = {
  manifest_version: "0.3",
  name: "my-mcp-server",
  version: "1.0.0",
  display_name: "My MCP Server",
  server: {
    type: "node",
    entry_point: "server/index.js",
    mcp_config: { command: "node", args: ["server/index.js"] },
  },
  _meta: { "dev.afps/mcp-server": { name: "@me/mcp", type: "mcp-server" } },
};

/** A valid AFPS 2.0 integration manifest (snake_case, `source` discriminant). */
const VALID_INTEGRATION = {
  name: "@me/integ",
  version: "1.0.0",
  type: "integration",
  schema_version: "2.0",
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

describe("validateBundle (AFPS 2.0)", () => {
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
    // The v2 afps-spec schema constrains schema_version to /^2\./, so a 1.x
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

  it("flags an unsupported MAJOR via the runtime supportedMajors policy", async () => {
    // A structurally-valid v2 manifest, but the runtime restricts to majors [3].
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
      { "SKILL.md": enc("a") },
    );
    const b = makePkg(
      "@me/b@1.0.0" as PackageIdentity,
      {
        name: "@me/b",
        version: "1.0.0",
        type: "skill",
        schema_version: "2.0",
        dependencies: { skills: { "@me/a": "^1" } },
      },
      { "SKILL.md": enc("b") },
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
      { name: "@me/dup", version: "1.0.0", type: "skill", schema_version: "2.0" },
      { "SKILL.md": enc("a") },
    );
    const a2 = makePkg(
      "@me/dup@1.1.0" as PackageIdentity,
      { name: "@me/dup", version: "1.1.0", type: "skill", schema_version: "2.0" },
      { "SKILL.md": enc("b") },
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
      "SKILL.md": enc("s"),
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

  it("rejects an mcp-server with a corrupt _meta AFPS identity (unscoped name)", async () => {
    // Keep an explicit top-level `type: "mcp-server"` annotation so the package
    // routes to the mcp-server schema, but corrupt the _meta identity contract
    // (unscoped name) — the schema MUST reject it.
    const badMcp = {
      ...VALID_MCP_SERVER,
      type: "mcp-server",
      _meta: { "dev.afps/mcp-server": { name: "not-scoped", type: "mcp-server" } },
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
    expect(
      result.issues.some(
        (i) => i.code === "MANIFEST_SCHEMA" && i.path.includes("dev.afps/mcp-server"),
      ),
    ).toBe(true);
  });

  it("flags an mcp-server with no AFPS identity signal as unsupported", async () => {
    // No top-level `type` and no _meta["dev.afps/mcp-server"] → the package is
    // genuinely unidentifiable, so it surfaces as UNSUPPORTED_TYPE.
    const orphan = { ...VALID_MCP_SERVER } as Record<string, unknown>;
    delete orphan._meta;
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

  it("accepts a valid integration dependency (AFPS 2.0 snake_case)", async () => {
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
      "SKILL.md": enc("s"),
    });
    const bundle = await buildBundleFromCatalog(root, new InMemoryPackageCatalog([skill]));
    const result = validateBundle(bundle);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("flags an unsupported MAJOR on a skill dependency via supportedMajors policy", async () => {
    // A structurally-valid v2 skill, but the runtime restricts to majors [3].
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...VALID_AGENT, dependencies: { skills: { "@me/a": "^1" } } },
      { "prompt.md": enc("p") },
    );
    const skill = makePkg("@me/a@1.0.0" as PackageIdentity, VALID_SKILL, {
      "SKILL.md": enc("s"),
    });
    const bundle = await buildBundleFromCatalog(root, new InMemoryPackageCatalog([skill]));
    const result = validateBundle(bundle, { supportedMajors: [2, 3] });
    // root agent is 2.0 (ok); skill is 2.0 too, so [2,3] passes. Restrict to [3].
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
      schema_version: "2.0",
    });
    const bundle = await buildBundleFromCatalog(root, new InMemoryPackageCatalog([bogus]));
    const result = validateBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "UNSUPPORTED_TYPE")).toBe(true);
  });
});
