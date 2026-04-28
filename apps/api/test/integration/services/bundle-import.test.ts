// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `services/bundle-import` helpers.
 *
 * Scope is limited to the helpers NOT exercised by the route test
 * (`packages-import-bundle.test.ts`):
 *   - `reconstructPackageZip` is byte-deterministic
 *   - `readOrBuildBundle` dispatches between `.afps-bundle` and raw `.afps`
 *   - `detectBundleConflicts` returns a `foreign_org_owner` conflict when
 *     the same package id is owned by another org (a path the route test
 *     does not cover — the route handler short-circuits to 409 before the
 *     test gets a structured shape to assert on)
 *
 * Path-traversal sanitization, signature policy, integrity tampering, and
 * the bundle-format upgrade matrix are all owned by `packages/afps-runtime`
 * and `packages/core` and tested there.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync } from "fflate";
import { writeBundleToBuffer } from "@appstrate/afps-runtime/bundle";
import type { Bundle, BundlePackage } from "@appstrate/afps-runtime/bundle";
import { computeIntegrity } from "@appstrate/core/integrity";
import {
  detectBundleConflicts,
  readOrBuildBundle,
  reconstructPackageZip,
} from "../../../src/services/bundle-import.ts";
import { db } from "@appstrate/db/client";
import { packages } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext } from "../../helpers/auth.ts";

const DOS_EPOCH_MS = Date.UTC(1980, 0, 2, 12, 0, 0);

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function buildRawAfps(manifest: Record<string, unknown>, content: string): Uint8Array {
  const entries: Record<string, [Uint8Array, { mtime: number; level: number }]> = {
    "manifest.json": [enc(JSON.stringify(manifest, null, 2)), { mtime: DOS_EPOCH_MS, level: 0 }],
    "prompt.md": [enc(content), { mtime: DOS_EPOCH_MS, level: 0 }],
  };
  return zipSync(
    entries as unknown as Parameters<typeof zipSync>[0],
    { level: 0, mtime: DOS_EPOCH_MS } as Parameters<typeof zipSync>[1],
  );
}

function pkgFromFiles(
  files: Map<string, Uint8Array>,
  identity: `@${string}/${string}@${string}` = "@x/a@1.0.0",
): BundlePackage {
  return {
    identity,
    manifest: { name: identity.split("@").slice(0, -1).join("@"), type: "agent", version: "1.0.0" },
    files,
    integrity: computeIntegrity(enc("placeholder")),
  };
}

describe("reconstructPackageZip", () => {
  it("is byte-deterministic across repeated calls with identical inputs", () => {
    const files = new Map<string, Uint8Array>([
      ["manifest.json", enc(JSON.stringify({ name: "@x/a", type: "agent", version: "1.0.0" }))],
      ["prompt.md", enc("Hello.")],
    ]);
    const a = reconstructPackageZip(pkgFromFiles(files));
    const b = reconstructPackageZip(pkgFromFiles(files));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("is insensitive to file-insertion order in the source map", () => {
    const orderedAsc = new Map<string, Uint8Array>([
      ["a.txt", enc("A")],
      ["b.txt", enc("B")],
      ["manifest.json", enc("{}")],
    ]);
    const orderedDesc = new Map<string, Uint8Array>([
      ["manifest.json", enc("{}")],
      ["b.txt", enc("B")],
      ["a.txt", enc("A")],
    ]);
    const a = reconstructPackageZip(pkgFromFiles(orderedAsc));
    const b = reconstructPackageZip(pkgFromFiles(orderedDesc));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("never includes the RECORD entry in the rebuilt archive", () => {
    const files = new Map<string, Uint8Array>([
      ["manifest.json", enc("{}")],
      ["prompt.md", enc("body")],
      ["RECORD", enc("manifest.json sha256-...")],
    ]);
    const out = reconstructPackageZip(pkgFromFiles(files));
    // The reconstructed ZIP must not contain a RECORD entry — it's a
    // derived file, recomputed at read time.
    const haystack = Buffer.from(out).toString("binary");
    expect(haystack.includes("RECORD")).toBe(false);
  });
});

describe("readOrBuildBundle dispatch", () => {
  it("recognises a raw .afps and promotes it to a bundle-of-one", async () => {
    const raw = buildRawAfps({ name: "@x/agent", type: "agent", version: "1.0.0" }, "Hello.");
    const bundle = await readOrBuildBundle(raw, {
      orgId: "00000000-0000-0000-0000-000000000000",
      applicationId: "00000000-0000-0000-0000-000000000000",
    });
    expect(bundle.packages.size).toBeGreaterThanOrEqual(1);
    expect(bundle.root).toMatch(/^@x\/agent@/);
  });

  it("recognises a .afps-bundle (multi-package) and reads it directly", async () => {
    // Build a single-package bundle and round-trip it through the canonical
    // writer. Then ask `readOrBuildBundle` to parse it — no DB scope is
    // needed for this dispatch (only `buildBundleFromUploadedAfps` reads
    // the catalog, and that path is short-circuited when the file looks
    // like a bundle).
    const raw = buildRawAfps({ name: "@x/agent", type: "agent", version: "1.0.0" }, "Hello.");
    const ctx = await createTestContext({ orgSlug: "bundle-dispatch" });
    const oneShot = await readOrBuildBundle(raw, {
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
    });
    const wrapped = writeBundleToBuffer(oneShot);
    const reread = await readOrBuildBundle(wrapped, {
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
    });
    expect(reread.root).toBe(oneShot.root);
    expect(reread.packages.size).toBe(oneShot.packages.size);
  });
});

describe("detectBundleConflicts", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("flags a foreign-org owner of an existing packages row", async () => {
    const ctxOwner = await createTestContext({ orgSlug: "conflict-owner" });
    const ctxImporter = await createTestContext({ orgSlug: "conflict-importer" });

    const packageId = "@x/agent" as const;
    await db
      .insert(packages)
      .values({
        id: packageId,
        orgId: ctxOwner.orgId,
        type: "agent",
        source: "local",
        draftManifest: { name: packageId, type: "agent", version: "1.0.0" },
        draftContent: "body",
        createdBy: ctxOwner.user.id,
      })
      .onConflictDoNothing();

    const identity = `${packageId}@1.0.0` as const;
    const bundle: Bundle = {
      bundleFormatVersion: "1.0",
      root: identity,
      packages: new Map([[identity, pkgFromFiles(new Map(), identity)]]),
      integrity: "sha256-abc",
    };

    const conflicts = await detectBundleConflicts(bundle, {
      orgId: ctxImporter.orgId,
      applicationId: ctxImporter.defaultAppId,
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.reason).toBe("foreign_org_owner");
    expect(conflicts[0]!.existingOrgId).toBe(ctxOwner.orgId);
  });

  it("returns no conflicts for a fresh org with no prior packages row", async () => {
    const ctx = await createTestContext({ orgSlug: "conflict-none" });
    const identity = "@x/fresh@1.0.0" as const;
    const bundle: Bundle = {
      bundleFormatVersion: "1.0",
      root: identity,
      packages: new Map([[identity, pkgFromFiles(new Map(), identity)]]),
      integrity: "sha256-abc",
    };

    const conflicts = await detectBundleConflicts(bundle, {
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
    });
    expect(conflicts).toEqual([]);
  });
});
