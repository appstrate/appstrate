// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
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

function makePkg(identity: PackageIdentity, prompt = "p"): BundlePackage {
  const files = new Map<string, Uint8Array>([
    ["manifest.json", enc(`{"name":"x","version":"1"}`)],
    ["prompt.md", enc(prompt)],
  ]);
  return {
    identity,
    manifest: { name: "x", version: "1" },
    files,
    integrity: recordIntegrity(serializeRecord(computeRecordEntries(files))),
  };
}

describe("emptyPackageCatalog", () => {
  it("resolves nothing", async () => {
    expect(await emptyPackageCatalog.resolve("@me/x", "1.0.0")).toBeNull();
  });
  it("throws on fetch", async () => {
    await expect(emptyPackageCatalog.fetch("@me/x@1.0.0" as PackageIdentity)).rejects.toThrow(
      BundleError,
    );
  });
});

describe("InMemoryPackageCatalog", () => {
  it("resolves exact version", async () => {
    const cat = new InMemoryPackageCatalog([
      makePkg("@me/a@1.0.0" as PackageIdentity),
      makePkg("@me/a@1.1.0" as PackageIdentity),
      makePkg("@me/a@2.0.0" as PackageIdentity),
    ]);
    const r = await cat.resolve("@me/a", "1.1.0");
    expect(r?.identity).toBe("@me/a@1.1.0");
  });

  it("resolves semver range (picks max satisfying)", async () => {
    const cat = new InMemoryPackageCatalog([
      makePkg("@me/a@1.0.0" as PackageIdentity),
      makePkg("@me/a@1.5.0" as PackageIdentity),
      makePkg("@me/a@2.0.0" as PackageIdentity),
    ]);
    const r = await cat.resolve("@me/a", "^1.0.0");
    expect(r?.identity).toBe("@me/a@1.5.0");
  });

  it("resolves dist-tags", async () => {
    const cat = new InMemoryPackageCatalog(
      [makePkg("@me/a@1.0.0" as PackageIdentity), makePkg("@me/a@2.0.0-beta.1" as PackageIdentity)],
      {
        distTags: {
          "@me/a": { latest: "1.0.0", beta: "2.0.0-beta.1" },
        },
      },
    );
    expect((await cat.resolve("@me/a", "latest"))?.identity).toBe("@me/a@1.0.0");
    expect((await cat.resolve("@me/a", "beta"))?.identity).toBe("@me/a@2.0.0-beta.1");
  });

  it("returns null for unknown name", async () => {
    const cat = new InMemoryPackageCatalog([]);
    expect(await cat.resolve("@me/ghost", "^1.0")).toBeNull();
  });

  it("returns null when no version satisfies range", async () => {
    const cat = new InMemoryPackageCatalog([makePkg("@me/a@1.0.0" as PackageIdentity)]);
    expect(await cat.resolve("@me/a", "^2.0.0")).toBeNull();
  });

  it("fetches by identity", async () => {
    const pkg = makePkg("@me/a@1.0.0" as PackageIdentity);
    const cat = new InMemoryPackageCatalog([pkg]);
    const got = await cat.fetch("@me/a@1.0.0" as PackageIdentity);
    expect(got.identity).toBe(pkg.identity);
  });

  it("throws on fetch of unknown identity", async () => {
    const cat = new InMemoryPackageCatalog([]);
    await expect(cat.fetch("@me/x@1.0.0" as PackageIdentity)).rejects.toThrow(BundleError);
  });
});

describe("composeCatalogs — fallback semantics", () => {
  it("first non-null resolve wins", async () => {
    const a = new InMemoryPackageCatalog([makePkg("@me/a@1.0.0" as PackageIdentity, "from-a")]);
    const b = new InMemoryPackageCatalog([makePkg("@me/a@1.0.0" as PackageIdentity, "from-b")]);
    const composed = composeCatalogs(a, b);
    const r = await composed.resolve("@me/a", "1.0.0");
    expect(r?.identity).toBe("@me/a@1.0.0");
    const fetched = await composed.fetch(r!.identity);
    expect(new TextDecoder().decode(fetched.files.get("prompt.md")!)).toBe("from-a");
  });

  it("falls through when first catalog returns null", async () => {
    const empty = new InMemoryPackageCatalog([]);
    const b = new InMemoryPackageCatalog([makePkg("@me/a@1.0.0" as PackageIdentity, "from-b")]);
    const composed = composeCatalogs(empty, b);
    const r = await composed.resolve("@me/a", "1.0.0");
    expect(r?.identity).toBe("@me/a@1.0.0");
    const fetched = await composed.fetch(r!.identity);
    expect(new TextDecoder().decode(fetched.files.get("prompt.md")!)).toBe("from-b");
  });

  it("returns null when every catalog is empty", async () => {
    const composed = composeCatalogs(emptyPackageCatalog, new InMemoryPackageCatalog([]));
    expect(await composed.resolve("@me/a", "1.0.0")).toBeNull();
  });
});
