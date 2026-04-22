// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { readBundleFromBuffer, readBundleFromFile } from "../../src/bundle/read.ts";
import { writeBundleToBuffer, writeBundleToFile } from "../../src/bundle/write.ts";
import { BundleError } from "../../src/bundle/errors.ts";
import {
  BUNDLE_FORMAT_VERSION,
  type Bundle,
  type BundlePackage,
  type PackageIdentity,
} from "../../src/bundle/types.ts";
import {
  computeRecordEntries,
  recordIntegrity,
  serializeRecord,
} from "../../src/bundle/integrity.ts";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeBundlePackage(
  identity: PackageIdentity,
  manifest: Record<string, unknown>,
  extras: Record<string, Uint8Array> = {},
): BundlePackage {
  const files = new Map<string, Uint8Array>([
    ["manifest.json", enc(JSON.stringify(manifest))],
    ...Object.entries(extras),
  ]);
  const record = serializeRecord(computeRecordEntries(files));
  return {
    identity,
    manifest,
    files,
    integrity: recordIntegrity(record),
  };
}

function makeBundle(opts: {
  root: PackageIdentity;
  packages: BundlePackage[];
  metadata?: Record<string, unknown>;
}): Bundle {
  const map = new Map<PackageIdentity, BundlePackage>();
  for (const pkg of opts.packages) map.set(pkg.identity, pkg);
  return {
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    root: opts.root,
    packages: map,
    integrity: "sha256-placeholder",
    metadata: opts.metadata as Bundle["metadata"],
  };
}

const ROOT_MANIFEST = {
  name: "@me/root",
  version: "1.0.0",
  type: "agent",
  schemaVersion: "1.1",
  displayName: "Root",
  author: "tester",
};
const DEP_MANIFEST = {
  name: "@me/dep",
  version: "1.0.0",
  type: "skill",
  schemaVersion: "1.1",
  displayName: "Dep",
  author: "tester",
};

describe("writeBundleToBuffer / readBundleFromBuffer — round-trip", () => {
  it("round-trips a bundle of 1", () => {
    const pkg = makeBundlePackage("@me/root@1.0.0" as PackageIdentity, ROOT_MANIFEST, {
      "prompt.md": enc("Hello {{name}}"),
    });
    const bundle = makeBundle({
      root: "@me/root@1.0.0" as PackageIdentity,
      packages: [pkg],
    });

    const bytes = writeBundleToBuffer(bundle);
    const read = readBundleFromBuffer(bytes);

    expect(read.root).toBe("@me/root@1.0.0");
    expect(read.packages.size).toBe(1);
    const rootPkg = read.packages.get("@me/root@1.0.0" as PackageIdentity);
    expect(rootPkg?.manifest).toEqual(ROOT_MANIFEST);
    expect(rootPkg).toBeDefined();
    expect(new TextDecoder().decode(rootPkg!.files.get("prompt.md")!)).toBe("Hello {{name}}");
  });

  it("round-trips a multi-package bundle", () => {
    const root = makeBundlePackage("@me/root@1.0.0" as PackageIdentity, ROOT_MANIFEST, {
      "prompt.md": enc("p"),
    });
    const dep = makeBundlePackage("@me/dep@1.0.0" as PackageIdentity, DEP_MANIFEST, {
      "SKILL.md": enc("skilly"),
    });
    const bundle = makeBundle({
      root: "@me/root@1.0.0" as PackageIdentity,
      packages: [root, dep],
    });

    const bytes = writeBundleToBuffer(bundle);
    const read = readBundleFromBuffer(bytes);

    expect(read.packages.size).toBe(2);
    expect(read.packages.get("@me/dep@1.0.0" as PackageIdentity)?.manifest).toEqual(DEP_MANIFEST);
  });

  it("preserves metadata on round-trip", () => {
    const pkg = makeBundlePackage("@me/root@1.0.0" as PackageIdentity, ROOT_MANIFEST, {
      "prompt.md": enc("p"),
    });
    const bundle = makeBundle({
      root: "@me/root@1.0.0" as PackageIdentity,
      packages: [pkg],
      metadata: {
        createdAt: "2026-04-21T14:32:18Z",
        builder: "test@1.0.0",
        "x-vendor/build-id": "ci-42",
      },
    });
    const read = readBundleFromBuffer(writeBundleToBuffer(bundle));
    expect(read.metadata?.builder).toBe("test@1.0.0");
    expect((read.metadata as { "x-vendor/build-id"?: string })["x-vendor/build-id"]).toBe("ci-42");
  });
});

describe("writeBundleToBuffer — determinism", () => {
  it("produces byte-identical output on repeated serialization", () => {
    const pkg = makeBundlePackage("@me/root@1.0.0" as PackageIdentity, ROOT_MANIFEST, {
      "prompt.md": enc("p"),
      "a.txt": enc("aaa"),
      "b.txt": enc("bbb"),
    });
    const bundle = makeBundle({
      root: "@me/root@1.0.0" as PackageIdentity,
      packages: [pkg],
    });
    const a = writeBundleToBuffer(bundle);
    const b = writeBundleToBuffer(bundle);
    expect(a).toEqual(b);
  });

  it("is insensitive to package insertion order", () => {
    const p1 = makeBundlePackage("@me/root@1.0.0" as PackageIdentity, ROOT_MANIFEST, {
      "prompt.md": enc("p"),
    });
    const p2 = makeBundlePackage("@me/dep@1.0.0" as PackageIdentity, DEP_MANIFEST, {
      "SKILL.md": enc("s"),
    });
    const a = writeBundleToBuffer(
      makeBundle({ root: "@me/root@1.0.0" as PackageIdentity, packages: [p1, p2] }),
    );
    const b = writeBundleToBuffer(
      makeBundle({ root: "@me/root@1.0.0" as PackageIdentity, packages: [p2, p1] }),
    );
    expect(a).toEqual(b);
  });

  it("metadata.builder does not affect bundle.json.integrity", () => {
    const pkg = makeBundlePackage("@me/root@1.0.0" as PackageIdentity, ROOT_MANIFEST, {
      "prompt.md": enc("p"),
    });
    const bundleA = makeBundle({
      root: "@me/root@1.0.0" as PackageIdentity,
      packages: [pkg],
      metadata: { builder: "A@1.0.0" },
    });
    const bundleB = makeBundle({
      root: "@me/root@1.0.0" as PackageIdentity,
      packages: [pkg],
      metadata: { builder: "B@2.0.0" },
    });
    const a = readBundleFromBuffer(writeBundleToBuffer(bundleA));
    const b = readBundleFromBuffer(writeBundleToBuffer(bundleB));
    expect(a.integrity).toBe(b.integrity);
    expect(a.metadata?.builder).not.toBe(b.metadata?.builder);
  });
});

describe("readBundleFromBuffer — tampering detection", () => {
  function buildAndMutate(mutate: (entries: Record<string, Uint8Array>) => void): Uint8Array {
    const pkg = makeBundlePackage("@me/root@1.0.0" as PackageIdentity, ROOT_MANIFEST, {
      "prompt.md": enc("hello"),
    });
    const bundle = makeBundle({
      root: "@me/root@1.0.0" as PackageIdentity,
      packages: [pkg],
    });
    const zipped = writeBundleToBuffer(bundle);
    const entries = unzipSync(zipped);
    mutate(entries);
    return zipSync(entries, { level: 0, mtime: Date.UTC(1980, 0, 1) });
  }

  it("detects a byte flip in a package file (RECORD_MISMATCH)", () => {
    const tampered = buildAndMutate((entries) => {
      entries["packages/@me/root/1.0.0/prompt.md"] = enc("helxo"); // 1-byte flip
    });
    try {
      readBundleFromBuffer(tampered);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BundleError);
      expect((err as BundleError).code).toBe("RECORD_MISMATCH");
      expect((err as BundleError).details).toMatchObject({ path: "prompt.md" });
    }
  });

  it("detects a tampered per-package integrity (INTEGRITY_MISMATCH)", () => {
    const tampered = buildAndMutate((entries) => {
      const raw = new TextDecoder().decode(entries["bundle.json"]!);
      const parsed = JSON.parse(raw);
      parsed.packages["@me/root@1.0.0"].integrity =
        "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      entries["bundle.json"] = enc(JSON.stringify(parsed));
    });
    expect(() => readBundleFromBuffer(tampered)).toThrow(BundleError);
    try {
      readBundleFromBuffer(tampered);
    } catch (err) {
      // The per-package recomputation happens first, so this surfaces
      // as INTEGRITY_MISMATCH on the package (not the bundle level).
      expect((err as BundleError).code).toBe("INTEGRITY_MISMATCH");
    }
  });

  it("detects bundle.json.integrity tampering when per-package integrity is also adjusted", () => {
    // Flip the top-level integrity without touching any per-package
    // integrity — exposes the bundle-level digest check.
    const tampered = buildAndMutate((entries) => {
      const raw = new TextDecoder().decode(entries["bundle.json"]!);
      const parsed = JSON.parse(raw);
      parsed.integrity = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      entries["bundle.json"] = enc(JSON.stringify(parsed));
    });
    try {
      readBundleFromBuffer(tampered);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BundleError);
      expect((err as BundleError).code).toBe("INTEGRITY_MISMATCH");
    }
  });

  it("rejects extra file added to a package (RECORD_MISMATCH)", () => {
    const tampered = buildAndMutate((entries) => {
      entries["packages/@me/root/1.0.0/extra.txt"] = enc("sneaky");
    });
    try {
      readBundleFromBuffer(tampered);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as BundleError).code).toBe("RECORD_MISMATCH");
    }
  });

  it("rejects missing bundle.json", () => {
    const tampered = buildAndMutate((entries) => {
      delete entries["bundle.json"];
    });
    try {
      readBundleFromBuffer(tampered);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as BundleError).code).toBe("BUNDLE_JSON_MISSING");
    }
  });

  it("rejects higher-major bundleFormatVersion", () => {
    const tampered = buildAndMutate((entries) => {
      const raw = new TextDecoder().decode(entries["bundle.json"]!);
      const parsed = JSON.parse(raw);
      parsed.bundleFormatVersion = "2.0";
      entries["bundle.json"] = enc(JSON.stringify(parsed));
    });
    try {
      readBundleFromBuffer(tampered);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as BundleError).code).toBe("VERSION_UNSUPPORTED");
    }
  });
});

describe("readBundleFromBuffer — archive sanitization", () => {
  it("rejects a non-ZIP buffer", () => {
    expect(() => readBundleFromBuffer(enc("not a zip"))).toThrow(BundleError);
    try {
      readBundleFromBuffer(enc("not a zip"));
    } catch (err) {
      expect((err as BundleError).code).toBe("ARCHIVE_INVALID");
    }
  });

  it("rejects path-traversal entries", () => {
    const zip = zipSync({
      "bundle.json": enc("{}"),
      "../escape.txt": enc("nope"),
    });
    try {
      readBundleFromBuffer(zip);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as BundleError).code).toBe("ARCHIVE_INVALID");
    }
  });
});

describe("readBundleFromFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "afps-bundle-rw-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a .afps-bundle file from disk", async () => {
    const pkg = makeBundlePackage("@me/root@1.0.0" as PackageIdentity, ROOT_MANIFEST, {
      "prompt.md": enc("from disk"),
    });
    const bundle = makeBundle({
      root: "@me/root@1.0.0" as PackageIdentity,
      packages: [pkg],
    });
    const path = join(dir, "agent.afps-bundle");
    await writeBundleToFile(bundle, path);
    const read = await readBundleFromFile(path);
    expect(read.packages.size).toBe(1);
  });
});
