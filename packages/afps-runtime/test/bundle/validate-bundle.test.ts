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
  schemaVersion: "1.1",
  displayName: "Root",
  author: "tester",
};

describe("validateBundle (v2)", () => {
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

  it("flags unsupported schemaVersion MAJOR via the afps-spec schema", async () => {
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...VALID_AGENT, schemaVersion: "2.0" },
      { "prompt.md": enc("p") },
    );
    const bundle = await buildBundleFromCatalog(root, emptyPackageCatalog);
    const result = validateBundle(bundle);
    // afps-spec/schema enforces `^1\.` pattern, so schemaVersion 2.0
    // surfaces as MANIFEST_SCHEMA — our dedicated SCHEMA_VERSION_UNSUPPORTED
    // code only fires when manifest shape is otherwise valid AND majors
    // list excludes it (e.g. in downstream runtimes with stricter policy).
    expect(
      result.issues.some(
        (i) => i.code === "MANIFEST_SCHEMA" && i.path === "manifest.schemaVersion",
      ),
    ).toBe(true);
  });

  it("flags a missing schemaVersion (via afps-spec schema)", async () => {
    const manifestWithoutSchemaVersion: Record<string, unknown> = { ...VALID_AGENT };
    delete manifestWithoutSchemaVersion.schemaVersion;
    const root = makePkg("@me/root@1.0.0" as PackageIdentity, manifestWithoutSchemaVersion, {
      "prompt.md": enc("p"),
    });
    const bundle = await buildBundleFromCatalog(root, emptyPackageCatalog);
    const result = validateBundle(bundle);
    // afps-spec/schema currently makes schemaVersion required at Zod
    // level, so MANIFEST_SCHEMA fires — either code is an error signal.
    const fired = result.issues.some(
      (i) =>
        (i.code === "SCHEMA_VERSION_MISSING" || i.code === "MANIFEST_SCHEMA") &&
        i.path.includes("schemaVersion"),
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
        name: "@me/a",
        version: "1.0.0",
        type: "skill",
        schemaVersion: "1.1",
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
        schemaVersion: "1.1",
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
      { name: "@me/dup", version: "1.0.0", type: "skill", schemaVersion: "1.1" },
      { "SKILL.md": enc("a") },
    );
    const a2 = makePkg(
      "@me/dup@1.1.0" as PackageIdentity,
      { name: "@me/dup", version: "1.1.0", type: "skill", schemaVersion: "1.1" },
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
});
