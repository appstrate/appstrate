// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { zipSync } from "fflate";
import {
  bundleToLoadedBundle,
  loadAnyBundleFromBuffer,
  writeBundleToBuffer,
  BUNDLE_FORMAT_VERSION,
  type Bundle,
  type BundlePackage,
  type PackageIdentity,
} from "../../src/bundle/index.ts";
import {
  bundleIntegrity,
  computeRecordEntries,
  recordIntegrity,
  serializeRecord,
} from "../../src/bundle/integrity.ts";
import { BundleError } from "../../src/bundle/errors.ts";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function dec(b: Uint8Array | undefined): string {
  return b ? new TextDecoder().decode(b) : "";
}

function makePkg(
  identity: PackageIdentity,
  manifest: Record<string, unknown>,
  extras: Record<string, Uint8Array>,
): BundlePackage {
  const files = new Map<string, Uint8Array>([
    ["manifest.json", enc(JSON.stringify(manifest))],
    ...Object.entries(extras),
  ]);
  const record = serializeRecord(computeRecordEntries(files));
  return { identity, manifest, files, integrity: recordIntegrity(record) };
}

function makeBundle(opts: { root: PackageIdentity; packages: BundlePackage[] }): Bundle {
  const pkgMap = new Map<PackageIdentity, BundlePackage>();
  for (const p of opts.packages) pkgMap.set(p.identity, p);
  const indexMap = new Map<PackageIdentity, { path: string; integrity: string }>();
  for (const p of opts.packages) {
    const [, scopeRest] = p.identity.split("@");
    const scope = scopeRest?.split("/")[0] ?? "";
    const nameVer = scopeRest?.split("/")[1] ?? "";
    const [name, version] = nameVer.split("@");
    indexMap.set(p.identity, {
      path: `packages/@${scope}/${name}/${version}/`,
      integrity: p.integrity,
    });
  }
  return {
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    root: opts.root,
    packages: pkgMap,
    integrity: bundleIntegrity(indexMap),
  };
}

describe("bundleToLoadedBundle", () => {
  it("flattens root files to the top level and strips RECORD", () => {
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { name: "@me/root", version: "1.0.0", type: "agent" },
      {
        "prompt.md": enc("You are {{name}}"),
        "helper.ts": enc("export const x = 1;"),
      },
    );
    const bundle = makeBundle({ root: root.identity, packages: [root] });
    const loaded = bundleToLoadedBundle(bundle);

    expect(loaded.manifest).toEqual({
      name: "@me/root",
      version: "1.0.0",
      type: "agent",
    });
    expect(loaded.prompt).toBe("You are {{name}}");
    expect(dec(loaded.files["manifest.json"])).toContain('"name":"@me/root"');
    expect(dec(loaded.files["prompt.md"])).toBe("You are {{name}}");
    expect(dec(loaded.files["helper.ts"])).toBe("export const x = 1;");
    // RECORD is runtime metadata, not part of the executable view.
    expect(loaded.files["RECORD"]).toBeUndefined();
  });

  it("lays out tool deps under tools/<scoped-id>/", () => {
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      {
        name: "@me/root",
        version: "1.0.0",
        type: "agent",
        dependencies: { tools: { "@vendor/calc": "^1.0.0" } },
      },
      { "prompt.md": enc("prompt body") },
    );
    const tool = makePkg(
      "@vendor/calc@1.2.3" as PackageIdentity,
      { name: "@vendor/calc", version: "1.2.3", type: "tool" },
      {
        "TOOL.md": enc("calc docs"),
        "index.ts": enc("export default () => ({ name: 'calc' });"),
      },
    );
    const bundle = makeBundle({ root: root.identity, packages: [root, tool] });
    const loaded = bundleToLoadedBundle(bundle);

    expect(dec(loaded.files["tools/@vendor/calc/TOOL.md"])).toBe("calc docs");
    expect(dec(loaded.files["tools/@vendor/calc/index.ts"])).toContain("export default");
    expect(dec(loaded.files["tools/@vendor/calc/manifest.json"])).toContain('"type":"tool"');
  });

  it("lays out skill deps under skills/<scoped-id>/", () => {
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      {
        name: "@me/root",
        version: "1.0.0",
        type: "agent",
        dependencies: { skills: { "@acme/markdown": "^1" } },
      },
      { "prompt.md": enc("p") },
    );
    const skill = makePkg(
      "@acme/markdown@2.0.0" as PackageIdentity,
      { name: "@acme/markdown", version: "2.0.0", type: "skill" },
      {
        "SKILL.md": enc("---\nname: markdown\ndescription: md renderer\n---\nUse this skill to…"),
      },
    );
    const bundle = makeBundle({ root: root.identity, packages: [root, skill] });
    const loaded = bundleToLoadedBundle(bundle);

    expect(dec(loaded.files["skills/@acme/markdown/SKILL.md"])).toContain("markdown");
  });

  it("lays out provider deps under providers/<scoped-id>/", () => {
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      {
        name: "@me/root",
        version: "1.0.0",
        type: "agent",
        dependencies: { providers: { "@appstrate/gmail": "^1" } },
      },
      { "prompt.md": enc("p") },
    );
    const provider = makePkg(
      "@appstrate/gmail@1.0.0" as PackageIdentity,
      { name: "@appstrate/gmail", version: "1.0.0", type: "provider" },
      { "PROVIDER.md": enc("provider doc") },
    );
    const bundle = makeBundle({ root: root.identity, packages: [root, provider] });
    const loaded = bundleToLoadedBundle(bundle);

    expect(dec(loaded.files["providers/@appstrate/gmail/PROVIDER.md"])).toBe("provider doc");
    expect(loaded.files["providers/@appstrate/gmail/manifest.json"]).toBeDefined();
  });

  it("skips packages with unknown type (forward-compat)", () => {
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { name: "@me/root", version: "1.0.0", type: "agent" },
      { "prompt.md": enc("p") },
    );
    const weird = makePkg(
      "@future/dataset@1.0.0" as PackageIdentity,
      { name: "@future/dataset", version: "1.0.0", type: "dataset" },
      { "data.csv": enc("a,b") },
    );
    const bundle = makeBundle({ root: root.identity, packages: [root, weird] });
    const loaded = bundleToLoadedBundle(bundle);

    // dataset is not tool/skill/provider → no prefix is defined, so it's
    // silently omitted. The adapter forward-compatible, it doesn't crash.
    const keys = Object.keys(loaded.files);
    expect(keys.some((k) => k.includes("@future/dataset"))).toBe(false);
  });

  it("computes decompressedSize as sum of exposed file bytes", () => {
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { name: "@me/root", version: "1.0.0", type: "agent" },
      { "prompt.md": enc("abcdef"), "extra.txt": enc("123") },
    );
    const loaded = bundleToLoadedBundle(makeBundle({ root: root.identity, packages: [root] }));
    // manifest.json + prompt.md (6 bytes) + extra.txt (3 bytes).
    const manifestBytes = loaded.files["manifest.json"]!.byteLength;
    expect(loaded.decompressedSize).toBe(manifestBytes + 6 + 3);
    // compressedSize is a projection, not a real ZIP — 0 by contract.
    expect(loaded.compressedSize).toBe(0);
  });

  it("returns an empty prompt when the root package has no prompt.md", () => {
    // A tool/skill root would not carry a prompt. The adapter must not
    // throw — resolvers that actually need the prompt will fail louder
    // themselves with a domain-specific error.
    const root = makePkg(
      "@me/tool-only@1.0.0" as PackageIdentity,
      { name: "@me/tool-only", version: "1.0.0", type: "tool" },
      { "TOOL.md": enc("docs") },
    );
    const loaded = bundleToLoadedBundle(makeBundle({ root: root.identity, packages: [root] }));
    expect(loaded.prompt).toBe("");
  });

  it("accepts a multi-package bundle via loadAnyBundleFromBuffer", () => {
    const root = makePkg(
      "@me/root@1.0.0" as PackageIdentity,
      { name: "@me/root", version: "1.0.0", type: "agent" },
      { "prompt.md": enc("Hello") },
    );
    const tool = makePkg(
      "@vendor/t@1.0.0" as PackageIdentity,
      { name: "@vendor/t", version: "1.0.0", type: "tool" },
      { "TOOL.md": enc("tool doc") },
    );
    const bundle = makeBundle({ root: root.identity, packages: [root, tool] });
    const archive = writeBundleToBuffer(bundle);

    const loaded = loadAnyBundleFromBuffer(archive);
    expect(loaded.prompt).toBe("Hello");
    expect(dec(loaded.files["tools/@vendor/t/TOOL.md"])).toBe("tool doc");
  });

  it("accepts a legacy single-package .afps via loadAnyBundleFromBuffer", () => {
    // A classic AFPS is just a ZIP with manifest.json + prompt.md at root.
    const archive = zipSync({
      "manifest.json": enc(
        JSON.stringify({
          name: "@me/legacy",
          version: "1.0.0",
          type: "agent",
          schemaVersion: "1.1",
        }),
      ),
      "prompt.md": enc("Legacy prompt"),
    });

    const loaded = loadAnyBundleFromBuffer(archive);
    expect(loaded.prompt).toBe("Legacy prompt");
    expect((loaded.manifest as { name?: string }).name).toBe("@me/legacy");
    // No dep prefixes since legacy is flat — files stay at top level.
    expect(Object.keys(loaded.files).every((k) => !k.startsWith("tools/"))).toBe(true);
  });

  it("surfaces the legacy MISSING_MANIFEST error when a non-bundle ZIP has no manifest.json", () => {
    // An archive that has neither bundle.json nor manifest.json — detect
    // as "not multi-package" then let the legacy loader throw the
    // specific MISSING_MANIFEST error (not a generic one).
    const archive = zipSync({ "random.txt": enc("hi") });
    expect(() => loadAnyBundleFromBuffer(archive)).toThrow(/manifest\.json/);
  });

  it("throws BUNDLE_JSON_INVALID when the root identity is missing from packages", () => {
    // Shouldn't be reachable via readBundleFromBuffer (which validates)
    // but can happen with hand-assembled Bundles — surface a clear error
    // rather than an undefined-access crash.
    const bundle: Bundle = {
      bundleFormatVersion: BUNDLE_FORMAT_VERSION,
      root: "@me/missing@1.0.0" as PackageIdentity,
      packages: new Map(),
      integrity: "sha256-placeholder",
    };
    try {
      bundleToLoadedBundle(bundle);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BundleError);
      expect((err as BundleError).code).toBe("BUNDLE_JSON_INVALID");
    }
  });
});
