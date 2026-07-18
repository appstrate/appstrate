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
  schema_version: "0.1",
  display_name: "Root",
  author: "tester",
};

describe("buildBundleFromCatalog", () => {
  it("produces a bundle of 1 for a zero-dep root", async () => {
    const root = makePkg("@me/root@1.0.0" as PackageIdentity, ROOT, { "prompt.md": enc("p") });
    const bundle = await buildBundleFromCatalog(root, emptyPackageCatalog);
    expect(bundle.packages.size).toBe(1);
    expect(bundle.root).toBe("@me/root@1.0.0");
  });

  it("walks skill + mcp_server + integration deps (AFPS sections)", async () => {
    const rootManifest = {
      ...ROOT,
      dependencies: {
        skills: { "@me/skill-a": "^1.0.0" },
        mcp_servers: { "@me/mcp-x": "1.2.3" },
        integrations: { "@me/integ-y": "^1.0.0" },
      },
    };
    const root = makePkg("@me/root@1.0.0" as PackageIdentity, rootManifest, {
      "prompt.md": enc("p"),
    });
    const skill = makePkg(
      "@me/skill-a@1.3.0" as PackageIdentity,
      { name: "@me/skill-a", version: "1.3.0", type: "skill", schema_version: "0.1" },
      { "SKILL.md": enc("s") },
    );
    // AFPS (§3.4) lifted the mcp-server scoped identity to the manifest
    // root, so `name`, `type`, and `schema_version` live at the top level.
    const mcp = makePkg(
      "@me/mcp-x@1.2.3" as PackageIdentity,
      {
        manifest_version: "0.3",
        name: "@me/mcp-x",
        version: "1.2.3",
        type: "mcp-server",
        schema_version: "0.1",
        server: {
          type: "node",
          entry_point: "server/index.js",
          mcp_config: { command: "node", args: ["server/index.js"] },
        },
      },
      { "server/index.js": enc("//") },
    );
    const integ = makePkg("@me/integ-y@1.0.0" as PackageIdentity, {
      name: "@me/integ-y",
      version: "1.0.0",
      type: "integration",
      schema_version: "0.1",
      source: { kind: "none" },
      auths: {
        key: {
          type: "api_key",
          credentials: { schema: { type: "object", properties: {} } },
          delivery: { env: { TOKEN: { value: "{$credential.token}" } } },
        },
      },
    });
    const cat = new InMemoryPackageCatalog([skill, mcp, integ]);

    const bundle = await buildBundleFromCatalog(root, cat);
    expect(bundle.packages.size).toBe(4);
    expect(bundle.packages.get("@me/skill-a@1.3.0" as PackageIdentity)).toBeDefined();
    expect(bundle.packages.get("@me/mcp-x@1.2.3" as PackageIdentity)).toBeDefined();
    expect(bundle.packages.get("@me/integ-y@1.0.0" as PackageIdentity)).toBeDefined();
  });

  it("depTypes: ['skills'] walks only skills (run-bundle: integrations/mcp-servers are spawned separately)", async () => {
    const rootManifest = {
      ...ROOT,
      dependencies: {
        skills: { "@me/skill-a": "^1.0.0" },
        mcp_servers: { "@me/mcp-x": "1.2.3" },
        integrations: { "@me/integ-y": "^1.0.0" },
      },
    };
    const root = makePkg("@me/root@1.0.0" as PackageIdentity, rootManifest, {
      "prompt.md": enc("p"),
    });
    const skill = makePkg(
      "@me/skill-a@1.3.0" as PackageIdentity,
      { name: "@me/skill-a", version: "1.3.0", type: "skill", schema_version: "0.1" },
      { "SKILL.md": enc("s") },
    );
    // Only the skill is in the catalog: an integration/mcp_server dep must not
    // be resolved or fetched, so its absence here must not surface as missing.
    const cat = new InMemoryPackageCatalog([skill]);

    const bundle = await buildBundleFromCatalog(root, cat, { depTypes: ["skills"] });
    expect(bundle.packages.size).toBe(2); // root + skill
    expect(bundle.packages.get("@me/skill-a@1.3.0" as PackageIdentity)).toBeDefined();
    expect(bundle.packages.get("@me/mcp-x@1.2.3" as PackageIdentity)).toBeUndefined();
    expect(bundle.packages.get("@me/integ-y@1.0.0" as PackageIdentity)).toBeUndefined();
  });

  it("walks AFPS §4.1 semver-string deps (skills + integrations + mcp_servers)", async () => {
    const rootManifest = {
      ...ROOT,
      dependencies: {
        skills: { "@me/skill-a": "^1.0.0" },
        mcp_servers: { "@me/mcp-x": "1.2.3" },
        integrations: { "@me/integ-y": "^1.0.0" },
      },
      integrations_configuration: {
        "@me/integ-y": { scopes: ["s1"], auth_key: "oauth" },
      },
    };
    const root = makePkg("@me/root@1.0.0" as PackageIdentity, rootManifest, {
      "prompt.md": enc("p"),
    });
    const skill = makePkg(
      "@me/skill-a@1.3.0" as PackageIdentity,
      { name: "@me/skill-a", version: "1.3.0", type: "skill", schema_version: "0.1" },
      { "SKILL.md": enc("s") },
    );
    const mcp = makePkg(
      "@me/mcp-x@1.2.3" as PackageIdentity,
      { name: "@me/mcp-x", version: "1.2.3", type: "mcp-server", schema_version: "0.1" },
      {},
    );
    const integ = makePkg(
      "@me/integ-y@1.0.0" as PackageIdentity,
      { name: "@me/integ-y", version: "1.0.0", type: "integration", schema_version: "0.1" },
      {},
    );
    const cat = new InMemoryPackageCatalog([skill, mcp, integ]);

    const bundle = await buildBundleFromCatalog(root, cat, {
      depTypes: ["skills", "mcp_servers", "integrations"],
    });
    expect(bundle.packages.size).toBe(4); // root + 3 deps
    expect(bundle.packages.get("@me/skill-a@1.3.0" as PackageIdentity)).toBeDefined();
    expect(bundle.packages.get("@me/mcp-x@1.2.3" as PackageIdentity)).toBeDefined();
    expect(bundle.packages.get("@me/integ-y@1.0.0" as PackageIdentity)).toBeDefined();
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
        schema_version: "0.1",
        dependencies: { skills: { "@me/b": "^1" } },
      },
      { "SKILL.md": enc("a") },
    );
    const b = makePkg(
      "@me/b@1.5.0" as PackageIdentity,
      { name: "@me/b", version: "1.5.0", type: "skill", schema_version: "0.1" },
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
        schema_version: "0.1",
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
        schema_version: "0.1",
        dependencies: { skills: { "@me/shared": "^1" } },
      },
      { "SKILL.md": enc("b") },
    );
    const shared = makePkg(
      "@me/shared@1.0.0" as PackageIdentity,
      { name: "@me/shared", version: "1.0.0", type: "skill", schema_version: "0.1" },
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
        schema_version: "0.1",
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
        schema_version: "0.1",
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
      { name: "@me/a", version: "1.0.0", type: "skill", schema_version: "0.1" },
      { "SKILL.md": enc("a") },
    );
    const cat = new InMemoryPackageCatalog([a]);
    await expect(buildBundleFromCatalog(root, cat, { limits: { maxPackages: 1 } })).rejects.toThrow(
      /more than/,
    );
  });

  it("rejects a catalog whose fetch returns a different identity than resolve", async () => {
    // A malformed/lying catalog: resolve points at @me/a@1.0.0 but fetch
    // hands back a package with a different identity. The builder must refuse
    // rather than silently embed the wrong package.
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...ROOT, dependencies: { skills: { "@me/a": "^1" } } },
      { "prompt.md": enc("p") },
    );
    const wrong = makePkg(
      "@me/wrong@9.9.9" as PackageIdentity,
      { name: "@me/wrong", version: "9.9.9", type: "skill", schema_version: "0.1" },
      { "SKILL.md": enc("w") },
    );
    const lyingCatalog = {
      resolve: async () => ({ identity: "@me/a@1.0.0" as PackageIdentity }),
      fetch: async () => wrong,
    };
    const err = await buildBundleFromCatalog(root, lyingCatalog).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BundleError);
    expect((err as BundleError).code).toBe("BUNDLE_JSON_INVALID");
    expect((err as BundleError).message).toMatch(/catalog\.fetch returned identity/);
  });

  it("aggregates every INTEGRITY_MISMATCH fetch failure into one deterministic error (#896)", async () => {
    // With several corrupted deps, the old `Promise.all` surfaced whichever
    // rejection lost the I/O race — the package named in the error changed
    // run to run, which operators read as corruption "moving around". The
    // builder must settle all fetches and name every failing package, in
    // declaration order, on every run.
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...ROOT, dependencies: { skills: { "@me/a": "^1", "@me/b": "^1", "@me/ok": "^1" } } },
      { "prompt.md": enc("p") },
    );
    const ok = makePkg(
      "@me/ok@1.0.0" as PackageIdentity,
      { name: "@me/ok", version: "1.0.0", type: "skill", schema_version: "0.1" },
      { "SKILL.md": enc("fine") },
    );
    const corruptCatalog = {
      resolve: async (name: string) => ({ identity: `${name}@1.0.0` as PackageIdentity }),
      fetch: async (identity: PackageIdentity) => {
        if (identity === ok.identity) return ok;
        // Vary the rejection latency so a racing implementation would name
        // @me/b (fastest failure) — the settled implementation must not.
        await new Promise((r) => setTimeout(r, identity.startsWith("@me/a") ? 20 : 0));
        throw new BundleError("INTEGRITY_MISMATCH", `Integrity check failed for ${identity}`);
      },
    };

    for (let run = 0; run < 3; run++) {
      const err = await buildBundleFromCatalog(root, corruptCatalog).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BundleError);
      expect((err as BundleError).code).toBe("INTEGRITY_MISMATCH");
      expect((err as BundleError).message).toBe(
        "Integrity check failed for @me/a@1.0.0, @me/b@1.0.0",
      );
      expect((err as BundleError).details).toEqual({
        packages: ["@me/a@1.0.0", "@me/b@1.0.0"],
      });
    }
  });

  it("surfaces the first-declared failure when no fetch failure is an integrity mismatch", async () => {
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { ...ROOT, dependencies: { skills: { "@me/a": "^1", "@me/b": "^1" } } },
      { "prompt.md": enc("p") },
    );
    const failingCatalog = {
      resolve: async (name: string) => ({ identity: `${name}@1.0.0` as PackageIdentity }),
      fetch: async (identity: PackageIdentity) => {
        // @me/b fails instantly, @me/a after a delay: declaration order must
        // still win over completion order.
        await new Promise((r) => setTimeout(r, identity.startsWith("@me/a") ? 20 : 0));
        throw new BundleError("ARCHIVE_INVALID", `broken archive for ${identity}`);
      },
    };

    const err = await buildBundleFromCatalog(root, failingCatalog).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BundleError);
    expect((err as BundleError).code).toBe("ARCHIVE_INVALID");
    expect((err as BundleError).message).toBe("broken archive for @me/a@1.0.0");
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
        schema_version: "0.1",
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

  it("rejects a manifest missing version (BUNDLE_JSON_INVALID)", () => {
    const { version: _omit, ...noVersion } = ROOT;
    const zip = zipSync({
      "manifest.json": enc(JSON.stringify(noVersion)),
      "prompt.md": enc("p"),
    });
    const err = (() => {
      try {
        extractRootFromAfps(zip);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(BundleError);
    expect((err as BundleError).code).toBe("BUNDLE_JSON_INVALID");
    expect((err as BundleError).message).toMatch(/name \+ version/);
  });

  it("rejects an .afps archive with no manifest.json at root", () => {
    const zip = zipSync({ "prompt.md": enc("p") });
    const err = (() => {
      try {
        extractRootFromAfps(zip);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(BundleError);
    expect((err as BundleError).code).toBe("BUNDLE_JSON_INVALID");
    expect((err as BundleError).message).toMatch(/missing manifest\.json/);
  });

  it("rejects a corrupt (non-ZIP) archive with ARCHIVE_INVALID", () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const err = (() => {
      try {
        extractRootFromAfps(garbage);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(BundleError);
    expect((err as BundleError).code).toBe("ARCHIVE_INVALID");
  });

  it("enforces the compressed-bytes limit", () => {
    const zip = zipSync({
      "manifest.json": enc(JSON.stringify(ROOT)),
      "prompt.md": enc("p"),
    });
    const err = (() => {
      try {
        extractRootFromAfps(zip, { maxCompressedBytes: 1 });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(BundleError);
    expect((err as BundleError).code).toBe("LIMITS_EXCEEDED");
    expect((err as BundleError).message).toMatch(/compressed/);
  });

  it("enforces the decompressed-bytes limit", () => {
    const zip = zipSync({
      "manifest.json": enc(JSON.stringify(ROOT)),
      "prompt.md": enc("x".repeat(1000)),
    });
    const err = (() => {
      try {
        // Compressed limit generous, decompressed limit tiny → trips the
        // post-inflation guard rather than the pre-inflation one.
        extractRootFromAfps(zip, { maxCompressedBytes: 1_000_000, maxDecompressedBytes: 10 });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(BundleError);
    expect((err as BundleError).code).toBe("LIMITS_EXCEEDED");
    expect((err as BundleError).message).toMatch(/decompressed/);
  });
});
