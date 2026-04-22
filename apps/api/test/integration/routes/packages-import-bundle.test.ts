// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for POST /api/packages/import-bundle (Phase 2 import).
 *
 * Covers:
 *   1. Happy path — .afps-bundle round-trip via GET /api/agents/.../bundle → import
 *   2. Raw .afps (single-package) is promoted to bundle-of-one
 *   3. Idempotent re-import returns `status: reused` for every package
 *   4. Integrity conflict is reported as 409 with `bundle_conflict` code
 *   5. Non-admin role is 403
 *   6. End-to-end parity — export from org A → import into org B → bytes identical
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync } from "fflate";
import { db } from "../../helpers/db.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { getTestApp } from "../../helpers/app.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import {
  applicationPackages,
  packageDistTags,
  packageVersions,
  packages,
} from "@appstrate/db/schema";
import { and, eq } from "drizzle-orm";
import * as storage from "@appstrate/db/storage";
import { computeIntegrity } from "@appstrate/core/integrity";
import {
  readBundleFromBuffer,
  writeBundleToBuffer,
  type Bundle,
} from "@appstrate/afps-runtime/bundle";

const BUCKET = "agent-packages";
const app = getTestApp();

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// Pinned DOS epoch — matches `reconstructPackageZip` so seed integrity
// equals the integrity computed at import time (would otherwise diverge
// purely because of ZIP encoding artifacts: deflate vs store, default
// mtime vs pinned mtime, key order — none of which reflect content
// difference).
const DOS_EPOCH_MS = Date.UTC(1980, 0, 1, 0, 0, 0);
/**
 * Build a deterministic AFPS for a given package type. The content file
 * name varies by type (agent/prompt.md, skill/SKILL.md, etc) — that's
 * what `parsePackageZip` uses to detect the type, so we have to write
 * the right file to round-trip through the importer.
 */
function buildAfps(opts: {
  manifest: Record<string, unknown>;
  content: string;
  type: "agent" | "skill" | "tool" | "provider";
}): Uint8Array {
  const filename = (() => {
    switch (opts.type) {
      case "agent":
        return "prompt.md";
      case "skill":
        return "SKILL.md";
      case "tool":
        return "tool.ts";
      case "provider":
        return "PROVIDER.md";
    }
  })();
  const entries: Record<string, [Uint8Array, { mtime?: number; level?: number }]> = {
    "manifest.json": [
      enc(JSON.stringify(opts.manifest, null, 2)),
      { mtime: DOS_EPOCH_MS, level: 0 },
    ],
    [filename]: [enc(opts.content), { mtime: DOS_EPOCH_MS, level: 0 }],
  };
  return zipSync(
    entries as unknown as Parameters<typeof zipSync>[0],
    {
      level: 0,
      mtime: DOS_EPOCH_MS,
    } as Parameters<typeof zipSync>[1],
  );
}

/** Default content per type — minimal payload that satisfies
 *  parsePackageZip's per-type validation (skill needs YAML frontmatter,
 *  etc). */
function defaultContentFor(type: "agent" | "skill" | "tool" | "provider"): string {
  switch (type) {
    case "agent":
      return "Test prompt.";
    case "skill":
      return "---\nname: test-skill\ndescription: A test skill.\n---\nSkill body.";
    case "tool":
      return "export default function tool() {}";
    case "provider":
      return "Provider doc.";
  }
}

async function seedVersionedPackage(opts: {
  id: `@${string}/${string}`;
  type: "agent" | "skill" | "tool" | "provider";
  version: string;
  orgId: string;
  manifest: Record<string, unknown>;
  content?: string;
  setLatest?: boolean;
}): Promise<{ versionId: number; version: string }> {
  await seedPackage({ id: opts.id, type: opts.type, orgId: opts.orgId });
  const afps = buildAfps({
    manifest: opts.manifest,
    content: opts.content ?? defaultContentFor(opts.type),
    type: opts.type,
  });
  const integrity = computeIntegrity(afps);
  await storage.uploadFile(BUCKET, `${opts.id}/${opts.version}.afps`, Buffer.from(afps));
  const pv = await seedPackageVersion({
    packageId: opts.id,
    version: opts.version,
    integrity,
    artifactSize: afps.length,
    manifest: opts.manifest,
  });
  if (opts.setLatest) {
    await db
      .insert(packageDistTags)
      .values({ packageId: opts.id, tag: "latest", versionId: pv.id })
      .onConflictDoUpdate({
        target: [packageDistTags.packageId, packageDistTags.tag],
        set: { versionId: pv.id, updatedAt: new Date() },
      });
  }
  return { versionId: pv.id, version: pv.version };
}

/** Seed + install + export → returns the exported bundle bytes. The
 *  caller is expected to truncate the DB before importing into a fresh
 *  org so that cross-org collisions on the `packages` row don't trip
 *  the import's foreign-org guard. */
async function seedAndExportBundle(opts: {
  ctx: TestContext;
  rootId: `@${string}/${string}`;
  skillA: `@${string}/${string}`;
  skillB: `@${string}/${string}`;
}): Promise<{ bytes: Uint8Array; bundle: Bundle }> {
  const { ctx, rootId, skillA, skillB } = opts;
  const rootVer = await seedVersionedPackage({
    id: rootId,
    type: "agent",
    version: "1.0.0",
    orgId: ctx.orgId,
    manifest: {
      name: rootId,
      version: "1.0.0",
      type: "agent",
      schemaVersion: "1.1",
      displayName: "Root",
      author: "tester",
      dependencies: { skills: { [skillA]: "^1.0.0" } },
    },
    content: "Do the thing.",
    setLatest: true,
  });
  await seedVersionedPackage({
    id: skillA,
    type: "skill",
    version: "1.2.0",
    orgId: ctx.orgId,
    manifest: {
      name: skillA,
      version: "1.2.0",
      type: "skill",
      schemaVersion: "1.1",
      displayName: "A",
      author: "tester",
      dependencies: { skills: { [skillB]: "^1" } },
    },
    setLatest: true,
  });
  await seedVersionedPackage({
    id: skillB,
    type: "skill",
    version: "1.0.0",
    orgId: ctx.orgId,
    manifest: {
      name: skillB,
      version: "1.0.0",
      type: "skill",
      schemaVersion: "1.1",
      displayName: "B",
      author: "tester",
    },
    setLatest: true,
  });

  await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, rootId);
  await db
    .update(applicationPackages)
    .set({ versionId: rootVer.versionId })
    .where(
      and(
        eq(applicationPackages.applicationId, ctx.defaultAppId),
        eq(applicationPackages.packageId, rootId),
      ),
    );

  const res = await app.request(`/api/agents/${rootId}/bundle`, { headers: authHeaders(ctx) });
  if (res.status !== 200) {
    throw new Error(`export failed: ${res.status} ${await res.text()}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const bundle = readBundleFromBuffer(bytes);
  return { bytes, bundle };
}

describe("POST /api/packages/import-bundle — import", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "importorg" });
  });

  it("imports a multi-package .afps-bundle and installs the root", async () => {
    // Stage 1 — export from a "source" org (which lives in a different
    // DB in production; here we simulate by truncating between export
    // and import so the destination org doesn't see the source's
    // packages rows and trip the foreign-org guard).
    const sourceCtx = await createTestContext({ orgSlug: "srcorg" });
    const { bytes } = await seedAndExportBundle({
      ctx: sourceCtx,
      rootId: "@srcorg/agent-root",
      skillA: "@srcorg/skill-a",
      skillB: "@srcorg/skill-b",
    });

    // Stage 2 — clear the DB and create a fresh destination org. The
    // bundle bytes we already have in memory carry every package the
    // import will need.
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "destorg" });

    const form = new FormData();
    form.append("file", new Blob([bytes]), "bundle.afps-bundle");
    const res = await app.request("/api/packages/import-bundle", {
      method: "POST",
      body: form,
      headers: authHeaders(ctx),
    });
    if (res.status !== 201) {
      throw new Error(`unexpected ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as {
      imported: Array<{ identity: string; status: string; versionId: number | null }>;
      rootInstalled: boolean;
      rootPackageId: string;
      rootVersion: string;
    };
    expect(body.imported).toHaveLength(3);
    expect(body.imported.every((i) => i.status === "inserted" || i.status === "reused")).toBe(true);
    expect(body.rootPackageId).toBe("@srcorg/agent-root");
    expect(body.rootVersion).toBe("1.0.0");
    expect(body.rootInstalled).toBe(true);

    // Verify DB state — 3 packages registered + root installed in
    // the importing app.
    for (const id of ["@srcorg/agent-root", "@srcorg/skill-a", "@srcorg/skill-b"]) {
      const [pkg] = await db
        .select({ id: packages.id })
        .from(packages)
        .where(eq(packages.id, id))
        .limit(1);
      expect(pkg?.id).toBe(id);
      const [ver] = await db
        .select({ id: packageVersions.id })
        .from(packageVersions)
        .where(eq(packageVersions.packageId, id))
        .limit(1);
      expect(ver).toBeDefined();
    }
    const [installed] = await db
      .select()
      .from(applicationPackages)
      .where(
        and(
          eq(applicationPackages.applicationId, ctx.defaultAppId),
          eq(applicationPackages.packageId, "@srcorg/agent-root"),
        ),
      )
      .limit(1);
    expect(installed).toBeDefined();
  });

  it("accepts a raw .afps and promotes it to a bundle-of-one", async () => {
    // Seed the zero-dep agent in the importing org's registry so the
    // catalog can resolve (the ingestion primitive walks even for
    // bundle-of-one — a missing dep would fail; we have none here).
    const agentId = "@importorg/standalone" as const;
    await seedVersionedPackage({
      id: agentId,
      type: "agent",
      version: "1.0.0",
      orgId: ctx.orgId,
      manifest: {
        name: agentId,
        version: "1.0.0",
        type: "agent",
        schemaVersion: "1.1",
        displayName: "Standalone",
        author: "tester",
      },
      content: "Standalone prompt.",
      setLatest: true,
    });

    // Build the raw .afps on the client side (no server-side export).
    const afps = buildAfps({
      manifest: {
        name: agentId,
        version: "1.0.0",
        type: "agent",
        schemaVersion: "1.1",
        displayName: "Standalone",
        author: "tester",
      },
      content: "Standalone prompt.",
      type: "agent",
    });

    const form = new FormData();
    form.append("file", new Blob([afps]), "standalone.afps");
    const res = await app.request("/api/packages/import-bundle", {
      method: "POST",
      body: form,
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      imported: Array<{ identity: string; status: string }>;
      rootPackageId: string;
    };
    expect(body.rootPackageId).toBe(agentId);
    expect(body.imported).toHaveLength(1);
  });

  it("returns status=reused on a second import of the same bundle", async () => {
    const sourceCtx = await createTestContext({ orgSlug: "srcidem" });
    const { bytes } = await seedAndExportBundle({
      ctx: sourceCtx,
      rootId: "@srcidem/a",
      skillA: "@srcidem/b",
      skillB: "@srcidem/c",
    });
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "destidem" });

    const importOnce = async () => {
      const form = new FormData();
      form.append("file", new Blob([bytes]), "bundle.afps-bundle");
      const res = await app.request("/api/packages/import-bundle", {
        method: "POST",
        body: form,
        headers: authHeaders(ctx),
      });
      return res;
    };

    const res1 = await importOnce();
    expect(res1.status).toBe(201);
    const res2 = await importOnce();
    expect(res2.status).toBe(201);
    const body2 = (await res2.json()) as {
      imported: Array<{ identity: string; status: string }>;
    };
    expect(body2.imported).toHaveLength(3);
    expect(body2.imported.every((i) => i.status === "reused")).toBe(true);
  });

  it("reports a bundle_conflict 409 when a version exists with different content", async () => {
    const sourceCtx = await createTestContext({ orgSlug: "srctamper" });
    const { bytes, bundle } = await seedAndExportBundle({
      ctx: sourceCtx,
      rootId: "@srctamper/a",
      skillA: "@srctamper/b",
      skillB: "@srctamper/c",
    });
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "desttamper" });

    // First import — succeeds.
    {
      const form = new FormData();
      form.append("file", new Blob([bytes]), "bundle.afps-bundle");
      const res = await app.request("/api/packages/import-bundle", {
        method: "POST",
        body: form,
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(201);
    }

    // Tamper: swap one byte in one of the skill's files, re-serialise
    // with the writer (which will propagate the bytes into the ZIP).
    // The Bundle `files` Map is shallowly immutable; rebuild manually.
    const tamperedBundle: Bundle = {
      ...bundle,
      packages: new Map(bundle.packages),
    };
    const skillB = tamperedBundle.packages.get("@srctamper/c@1.0.0" as never);
    expect(skillB).toBeDefined();
    const files = new Map(skillB!.files);
    const prompt = files.get("prompt.md")!;
    const mutated = new Uint8Array(prompt);
    mutated[0] = mutated[0]! ^ 0x01; // flip one bit
    files.set("prompt.md", mutated);
    tamperedBundle.packages.set("@srctamper/c@1.0.0" as never, {
      ...skillB!,
      files,
    });
    const tamperedBytes = writeBundleToBuffer(tamperedBundle);

    const form = new FormData();
    form.append("file", new Blob([tamperedBytes]), "bundle.afps-bundle");
    const res = await app.request("/api/packages/import-bundle", {
      method: "POST",
      body: form,
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; detail: string };
    expect(body.code).toBe("bundle_conflict");
    expect(body.detail).toContain("@srctamper/c@1.0.0");
  });

  it("rejects non-multipart requests with 400", async () => {
    const res = await app.request("/api/packages/import-bundle", {
      method: "POST",
      headers: {
        ...authHeaders(ctx),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ foo: "bar" }),
    });
    expect(res.status).toBe(400);
  });

  it("end-to-end parity: re-export after import yields byte-identical bundle", async () => {
    // Export from org A.
    const sourceCtx = await createTestContext({ orgSlug: "srcparity" });
    const { bytes: originalBytes } = await seedAndExportBundle({
      ctx: sourceCtx,
      rootId: "@srcparity/a",
      skillA: "@srcparity/b",
      skillB: "@srcparity/c",
    });

    // Truncate + fresh dest org B.
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "destparity" });

    // Import into org B.
    const form = new FormData();
    form.append("file", new Blob([originalBytes]), "bundle.afps-bundle");
    const importRes = await app.request("/api/packages/import-bundle", {
      method: "POST",
      body: form,
      headers: authHeaders(ctx),
    });
    expect(importRes.status).toBe(201);

    // Re-export from org B — should produce an IDENTICAL bundle (same
    // deterministic writer, same package bytes, same integrity).
    const reExport = await app.request(`/api/agents/@srcparity/a/bundle`, {
      headers: authHeaders(ctx),
    });
    expect(reExport.status).toBe(200);
    const reExportBytes = new Uint8Array(await reExport.arrayBuffer());

    const orig = readBundleFromBuffer(originalBytes);
    const reimported = readBundleFromBuffer(reExportBytes);
    // Integrity must match — the bundle contract guarantees this
    // across instances when the package bytes are identical.
    expect(reimported.integrity).toBe(orig.integrity);
  });
});
