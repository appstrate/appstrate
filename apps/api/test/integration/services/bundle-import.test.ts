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
import { writeBundleToBuffer, BundleError } from "@appstrate/afps-runtime/bundle";
import type { Bundle, BundlePackage } from "@appstrate/afps-runtime/bundle";
import { computeIntegrity } from "@appstrate/core/integrity";
import {
  detectBundleConflicts,
  handleImportBundle,
  importBundle,
  readOrBuildBundle,
  reconstructPackageZip,
} from "../../../src/services/bundle-import.ts";
import { db } from "@appstrate/db/client";
import { packages, packageVersions } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { ApiError } from "../../../src/lib/errors.ts";
import { describeRequiresPostgres } from "../../helpers/tier.ts";

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

  it("does not throw raw on non-ZIP / garbage bytes — detector returns false, reader raises a typed error", async () => {
    // `looksLikeAfpsBundle` calls `unzipSync`, which THROWS `invalid zip data`
    // on non-ZIP input. The detector must swallow that and return false so the
    // bytes fall through to the raw `.afps` reader, which raises a TYPED
    // `BundleError` (ARCHIVE_INVALID) rather than letting fflate's raw `Error`
    // bubble straight out of the detector to a 500.
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);
    let err: unknown;
    try {
      await readOrBuildBundle(garbage, {
        orgId: "00000000-0000-0000-0000-000000000000",
        applicationId: "00000000-0000-0000-0000-000000000000",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BundleError);
    expect((err as BundleError).code).toBe("ARCHIVE_INVALID");
  });

  it("does not throw on an empty buffer (detector returns false)", async () => {
    // Empty input is the degenerate non-ZIP case — `unzipSync` throws, the
    // detector must still return false (not throw) and fall through.
    let err: unknown;
    try {
      await readOrBuildBundle(new Uint8Array(0), {
        orgId: "00000000-0000-0000-0000-000000000000",
        applicationId: "00000000-0000-0000-0000-000000000000",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BundleError);
  });

  it("recognises a .afps-bundle whose first entry exceeds 64 KiB (central-directory scan)", async () => {
    // Regression for the byte-scan heuristic: the writer emits package
    // files (sorted) BEFORE `bundle.json`, so a package carrying a >64 KiB
    // STORE'd file pushes `bundle.json`'s local header past the old
    // 64 KiB front-of-file scan window → false negative. Enumerating the
    // central directory finds it regardless of position.
    const bigPrompt = "x".repeat(100 * 1024); // 100 KiB → exceeds the 64 KiB window
    const raw = buildRawAfps({ name: "@x/agent", type: "agent", version: "1.0.0" }, bigPrompt);
    const ctx = await createTestContext({ orgSlug: "bundle-big" });
    const oneShot = await readOrBuildBundle(raw, {
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
    });
    const wrapped = writeBundleToBuffer(oneShot);
    expect(wrapped.byteLength).toBeGreaterThan(65536);

    // Must be read AS a bundle (not mis-promoted as a single-package afps).
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

// ---------------------------------------------------------------------------
// CRIT-08 — cross-tenant ownership claim inside `importBundle`
// ---------------------------------------------------------------------------
//
// The packages row is now claimed ATOMICALLY (advisory-locked transaction +
// `FOR UPDATE` re-read of the survivor's owner) BEFORE any version row or
// storage byte is written. If the fix is reverted, a second org importing the
// same package id either GRAFTS its version + bytes onto the first org's row
// (the TOCTOU: both pass the read-only preflight) or silently "reuses" a
// foreign org's package. These regressions FAIL against the pre-fix code.

describe("importBundle — cross-tenant ownership claim (CRIT-08)", () => {
  const PKG = "@raceorg/agent";

  function agentAfps(version: string): Uint8Array {
    return buildRawAfps(
      {
        schema_version: "0.2",
        name: PKG,
        type: "agent",
        version,
        display_name: "Race Agent",
        description: "race agent",
      },
      `Prompt v${version}.`,
    );
  }

  async function packageOwner(id: string): Promise<string | null | undefined> {
    const [row] = await db
      .select({ orgId: packages.orgId })
      .from(packages)
      .where(eq(packages.id, id))
      .limit(1);
    return row?.orgId;
  }

  async function versionsOf(id: string): Promise<string[]> {
    const rows = await db
      .select({ version: packageVersions.version })
      .from(packageVersions)
      .where(eq(packageVersions.packageId, id));
    return rows.map((r) => r.version).sort();
  }

  let ctxA: TestContext;
  let ctxB: TestContext;
  let scopeA: { orgId: string; applicationId: string };
  let scopeB: { orgId: string; applicationId: string };

  beforeEach(async () => {
    await truncateAll();
    ctxA = await createTestContext({ orgSlug: "raceorg", email: "owner-a@race.test" });
    ctxB = await createTestContext({ orgSlug: "raceorgb", email: "owner-b@race.test" });
    scopeA = { orgId: ctxA.orgId, applicationId: ctxA.defaultAppId };
    scopeB = { orgId: ctxB.orgId, applicationId: ctxB.defaultAppId };
  });

  it("sequential: org B importing a package owned by org A gets a 409 — never a silent graft", async () => {
    // Org A owns the package with version 1.0.0.
    const first = await handleImportBundle(agentAfps("1.0.0"), scopeA, ctxA.user.id);
    expect(first.imported[0]!.status).toBe("inserted");
    expect(await packageOwner(PKG)).toBe(ctxA.orgId);

    // Route path (preflight): same identity → 409.
    const viaPreflight = await handleImportBundle(agentAfps("1.0.0"), scopeB, ctxB.user.id).catch(
      (e: unknown) => e,
    );
    expect(viaPreflight).toBeInstanceOf(ApiError);
    expect((viaPreflight as ApiError).status).toBe(409);
    expect((viaPreflight as ApiError).code).toBe("bundle_conflict");

    // Enforcement point (bypasses the UX preflight — the security boundary):
    // org B imports a NEW version 2.0.0 of A's package. Pre-fix this fell
    // through the reuse check (no (pkg, 2.0.0) row) and grafted org B's
    // version + bytes onto org A's row. Post-fix: 409 at the atomic claim.
    const bundleV2 = await readOrBuildBundle(agentAfps("2.0.0"), scopeB);
    const direct = await importBundle(bundleV2, scopeB, ctxB.user.id).catch((e: unknown) => e);
    expect(direct).toBeInstanceOf(ApiError);
    expect((direct as ApiError).status).toBe(409);
    expect((direct as ApiError).code).toBe("bundle_conflict");

    // The loser left NOTHING behind: still org A's row, still only 1.0.0.
    expect(await packageOwner(PKG)).toBe(ctxA.orgId);
    expect(await versionsOf(PKG)).toEqual(["1.0.0"]);
  });

  // Real concurrency needs two independent DB sessions holding the advisory
  // lock — external PostgreSQL only (PGlite is single-connection).
  describeRequiresPostgres("concurrent imports (advisory-locked claim)", () => {
    it("two orgs importing the SAME packageId concurrently: exactly one wins, the loser leaves no rows", async () => {
      const bytes = agentAfps("1.0.0");

      const [a, b] = await Promise.allSettled([
        handleImportBundle(bytes, scopeA, ctxA.user.id),
        handleImportBundle(bytes, scopeB, ctxB.user.id),
      ]);

      const settled = [
        { outcome: a, org: ctxA.orgId },
        { outcome: b, org: ctxB.orgId },
      ];
      const winners = settled.filter((s) => s.outcome.status === "fulfilled");
      const losers = settled.filter((s) => s.outcome.status === "rejected");

      // Exactly one succeeds; the race loser rejects with the typed conflict.
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const loserErr = (losers[0]!.outcome as PromiseRejectedResult).reason as unknown;
      expect(loserErr).toBeInstanceOf(ApiError);
      expect((loserErr as ApiError).status).toBe(409);
      expect((loserErr as ApiError).code).toBe("bundle_conflict");

      // The surviving row belongs to the WINNER, and the loser attached no
      // version row (pre-fix: both calls succeeded and the loser grafted its
      // version onto the winner's package).
      expect(await packageOwner(PKG)).toBe(winners[0]!.org);
      expect(await versionsOf(PKG)).toEqual(["1.0.0"]);

      const won = (
        winners[0]!.outcome as PromiseFulfilledResult<
          Awaited<ReturnType<typeof handleImportBundle>>
        >
      ).value;
      expect(won.imported[0]!.status).toBe("inserted");
    });
  });
});
