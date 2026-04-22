// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { zipSync } from "fflate";
import {
  buildBundleFromAfps,
  buildBundleFromCatalog,
  extractRootFromAfps,
} from "../../src/bundle/build.ts";
import {
  InMemoryPackageCatalog,
  composeCatalogs,
  emptyPackageCatalog,
} from "../../src/bundle/catalog.ts";
import {
  computeRecordEntries,
  recordIntegrity,
  serializeRecord,
} from "../../src/bundle/integrity.ts";
import { BundleError } from "../../src/bundle/errors.ts";
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

const ROOT = {
  name: "@me/root",
  version: "1.0.0",
  type: "agent",
  schemaVersion: "1.1",
  displayName: "Root",
  author: "tester",
};

describe("buildBundleFromCatalog", () => {
  it("produces a bundle of 1 for a zero-dep root", async () => {
    const root = makePkg("@me/root@1.0.0" as PackageIdentity, ROOT, { "prompt.md": enc("p") });
    const bundle = await buildBundleFromCatalog(root, emptyPackageCatalog);
    expect(bundle.packages.size).toBe(1);
    expect(bundle.root).toBe("@me/root@1.0.0");
  });

  it("walks skill + provider deps", async () => {
    const rootManifest = {
      ...ROOT,
      dependencies: {
        skills: { "@me/skill-a": "^1.0.0" },
        providers: { "@me/prov-x": "1.2.3" },
      },
    };
    const root = makePkg("@me/root@1.0.0" as PackageIdentity, rootManifest, {
      "prompt.md": enc("p"),
    });
    const skill = makePkg(
      "@me/skill-a@1.3.0" as PackageIdentity,
      { name: "@me/skill-a", version: "1.3.0", type: "skill", schemaVersion: "1.1" },
      { "SKILL.md": enc("s") },
    );
    const prov = makePkg(
      "@me/prov-x@1.2.3" as PackageIdentity,
      { name: "@me/prov-x", version: "1.2.3", type: "provider", schemaVersion: "1.1" },
      { "PROVIDER.md": enc("pr") },
    );
    const cat = new InMemoryPackageCatalog([skill, prov]);

    const bundle = await buildBundleFromCatalog(root, cat);
    expect(bundle.packages.size).toBe(3);
    expect(bundle.packages.get("@me/skill-a@1.3.0" as PackageIdentity)).toBeDefined();
    expect(bundle.packages.get("@me/prov-x@1.2.3" as PackageIdentity)).toBeDefined();
  });

  it("walks transitive deps", async () => {
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...ROOT, dependencies: { skills: { "@me/a": "^1" } } },
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
      "@me/b@1.5.0" as PackageIdentity,
      { name: "@me/b", version: "1.5.0", type: "skill", schemaVersion: "1.1" },
      { "SKILL.md": enc("b") },
    );
    const cat = new InMemoryPackageCatalog([a, b]);

    const bundle = await buildBundleFromCatalog(root, cat);
    expect(bundle.packages.size).toBe(3);
  });

  it("dedupes diamond dependencies", async () => {
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      {
        ...ROOT,
        dependencies: { skills: { "@me/a": "^1", "@me/b": "^1" } },
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
        dependencies: { skills: { "@me/shared": "^1" } },
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
        dependencies: { skills: { "@me/shared": "^1" } },
      },
      { "SKILL.md": enc("b") },
    );
    const shared = makePkg(
      "@me/shared@1.0.0" as PackageIdentity,
      { name: "@me/shared", version: "1.0.0", type: "skill", schemaVersion: "1.1" },
      { "SKILL.md": enc("s") },
    );
    const cat = new InMemoryPackageCatalog([a, b, shared]);

    const bundle = await buildBundleFromCatalog(root, cat);
    expect(bundle.packages.size).toBe(4); // root + a + b + shared (not 5)
  });

  it("tolerates cycles and emits warnings", async () => {
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...ROOT, dependencies: { skills: { "@me/a": "^1" } } },
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
        dependencies: { skills: { "@me/a": "^1" } }, // cycle back to a
      },
      { "SKILL.md": enc("b") },
    );
    const cat = new InMemoryPackageCatalog([a, b]);

    const warnings: string[] = [];
    const bundle = await buildBundleFromCatalog(root, cat, {
      onWarn: (m) => warnings.push(m),
    });
    expect(bundle.packages.size).toBe(3);
    expect(warnings.some((w) => w.includes("cycle"))).toBe(true);
  });

  it("collects all missing deps into one DEPENDENCY_UNRESOLVED", async () => {
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...ROOT, dependencies: { skills: { "@me/a": "^1", "@me/b": "^1" } } },
      { "prompt.md": enc("p") },
    );
    try {
      await buildBundleFromCatalog(root, emptyPackageCatalog);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BundleError);
      expect((err as BundleError).code).toBe("DEPENDENCY_UNRESOLVED");
      const details = (err as BundleError).details as {
        missing: Array<{ from: string; name: string }>;
      };
      expect(details.missing).toHaveLength(2);
      expect(details.missing.map((m) => m.name).sort()).toEqual(["@me/a", "@me/b"]);
    }
  });

  it("enforces maxPackages limit", async () => {
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...ROOT, dependencies: { skills: { "@me/a": "^1" } } },
      { "prompt.md": enc("p") },
    );
    const a = makePkg(
      "@me/a@1.0.0" as PackageIdentity,
      { name: "@me/a", version: "1.0.0", type: "skill", schemaVersion: "1.1" },
      { "SKILL.md": enc("a") },
    );
    const cat = new InMemoryPackageCatalog([a]);
    await expect(buildBundleFromCatalog(root, cat, { limits: { maxPackages: 1 } })).rejects.toThrow(
      /more than/,
    );
  });

  it("composes in-memory + fallback for inline-run-style ingestion", async () => {
    // Simulates a user posting a root manifest that references an
    // already-registered skill. Posted payload (in-memory) takes
    // precedence; missing deps fall through to the DB catalog.
    const rootManifest = {
      ...ROOT,
      dependencies: { skills: { "@me/pre-registered": "^1" } },
    };
    const root = makePkg("@me/root@1.0.0" as PackageIdentity, rootManifest, {
      "prompt.md": enc("p"),
    });
    const registered = makePkg(
      "@me/pre-registered@1.0.0" as PackageIdentity,
      {
        name: "@me/pre-registered",
        version: "1.0.0",
        type: "skill",
        schemaVersion: "1.1",
      },
      { "SKILL.md": enc("s") },
    );

    const inline = new InMemoryPackageCatalog([]);
    const db = new InMemoryPackageCatalog([registered]);
    const composed = composeCatalogs(inline, db);

    const bundle = await buildBundleFromCatalog(root, composed);
    expect(bundle.packages.size).toBe(2);
  });
});

describe("extractRootFromAfps / buildBundleFromAfps", () => {
  it("extracts root from a flat .afps ZIP", () => {
    const zip = zipSync({
      "manifest.json": enc(JSON.stringify(ROOT)),
      "prompt.md": enc("hello"),
    });
    const root = extractRootFromAfps(zip);
    expect(root.identity).toBe("@me/root@1.0.0");
    expect(new TextDecoder().decode(root.files.get("prompt.md")!)).toBe("hello");
  });

  it("strips a single wrapper folder", () => {
    const zip = zipSync({
      "wrapper/manifest.json": enc(JSON.stringify(ROOT)),
      "wrapper/prompt.md": enc("hi"),
    });
    const root = extractRootFromAfps(zip);
    expect(root.files.get("manifest.json")).toBeDefined();
  });

  it("rejects non-scoped manifest name", () => {
    const zip = zipSync({
      "manifest.json": enc(JSON.stringify({ ...ROOT, name: "unscoped" })),
      "prompt.md": enc("p"),
    });
    expect(() => extractRootFromAfps(zip)).toThrow(/scoped/);
  });

  it("delegates to buildBundleFromCatalog", async () => {
    const zip = zipSync({
      "manifest.json": enc(JSON.stringify(ROOT)),
      "prompt.md": enc("p"),
    });
    const bundle = await buildBundleFromAfps(zip, emptyPackageCatalog);
    expect(bundle.packages.size).toBe(1);
    expect(bundle.root).toBe("@me/root@1.0.0");
  });
});
