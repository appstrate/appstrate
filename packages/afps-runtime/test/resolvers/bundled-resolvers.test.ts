// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  BundledSkillResolver,
  BundledSkillResolutionError,
  type Bundle,
  type BundlePackage,
} from "../../src/resolvers/index.ts";
import {
  BUNDLE_FORMAT_VERSION,
  bundleIntegrity,
  computeRecordEntries,
  recordIntegrity,
  serializeRecord,
  type PackageIdentity,
} from "../../src/bundle/index.ts";

const enc = new TextEncoder();

/**
 * Build a {@link BundlePackage} from a name + in-memory file map. The
 * integrity is computed canonically so the returned package round-trips
 * through `readBundleFromBuffer`.
 */
function makePackage(
  name: `@${string}/${string}`,
  version: string,
  type: "agent" | "mcp-server" | "skill",
  files: Record<string, string | Uint8Array>,
  extraManifest: Record<string, unknown> = {},
): BundlePackage {
  const identity = `${name}@${version}` as PackageIdentity;
  const manifest = { name, version, type, ...extraManifest };
  const filesMap = new Map<string, Uint8Array>();
  filesMap.set("manifest.json", enc.encode(JSON.stringify(manifest)));
  for (const [k, v] of Object.entries(files)) {
    filesMap.set(k, typeof v === "string" ? enc.encode(v) : v);
  }
  const integrity = recordIntegrity(serializeRecord(computeRecordEntries(filesMap)));
  return { identity, manifest, files: filesMap, integrity };
}

/** Build a {@link Bundle} from a root package + an arbitrary list of deps. */
function makeBundle(root: BundlePackage, deps: BundlePackage[] = []): Bundle {
  const packages = new Map<PackageIdentity, BundlePackage>();
  packages.set(root.identity, root);
  for (const d of deps) packages.set(d.identity, d);
  const pkgIndex = new Map<PackageIdentity, { path: string; integrity: string }>();
  for (const p of packages.values()) {
    pkgIndex.set(p.identity, {
      path: `packages/${(p.manifest as { name: string }).name}/${(p.manifest as { version: string }).version}/`,
      integrity: p.integrity,
    });
  }
  return {
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    root: root.identity,
    packages,
    integrity: bundleIntegrity(pkgIndex),
  };
}

describe("BundledSkillResolver", () => {
  it("loads SKILL.md and parses frontmatter", async () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const skillPkg = makePackage("@acme/recon", "1.0.0", "skill", {
      "SKILL.md": "---\nname: recon\ndescription: Look around\n---\n\n# Body\n",
    });
    const bundle = makeBundle(root, [skillPkg]);
    const resolver = new BundledSkillResolver();
    const out = await resolver.resolve([{ name: "@acme/recon", version: "^1" }], bundle);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("@acme/recon");
    expect(out[0]!.content.trim()).toContain("# Body");
    expect(out[0]!.frontmatter).toEqual({ name: "recon", description: "Look around" });
  });

  it("throws BundledSkillResolutionError when the package is absent from the bundle", async () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const bundle = makeBundle(root);
    const resolver = new BundledSkillResolver();
    await expect(
      resolver.resolve([{ name: "@acme/missing", version: "^1" }], bundle),
    ).rejects.toBeInstanceOf(BundledSkillResolutionError);
  });

  it("throws BundledSkillResolutionError when SKILL.md is missing from the package", async () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const skillPkg = makePackage("@acme/empty", "1.0.0", "skill", {});
    const bundle = makeBundle(root, [skillPkg]);
    const resolver = new BundledSkillResolver();
    await expect(
      resolver.resolve([{ name: "@acme/empty", version: "^1" }], bundle),
    ).rejects.toBeInstanceOf(BundledSkillResolutionError);
  });
});
