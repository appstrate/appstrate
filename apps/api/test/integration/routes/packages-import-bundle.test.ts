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
import { assertDbMissing } from "../../helpers/assertions.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import {
  _setRunLimitsForTesting,
  getInlineRunLimits,
  getPlatformRunLimits,
} from "../../../src/services/run-limits.ts";
import { _resetCacheForTesting } from "@appstrate/env";
import {
  applicationPackages,
  auditEvents,
  packageDistTags,
  packageVersions,
  packages,
} from "@appstrate/db/schema";
import { and, eq } from "drizzle-orm";
import * as storage from "@appstrate/db/storage";
import { computeIntegrity } from "@appstrate/core/integrity";
import { AGENT_RESOURCES_META_KEY } from "@appstrate/core/validation";
import {
  buildBundleFromCatalog,
  extractRootFromAfps,
  readBundleFromBuffer,
  writeBundleToBuffer,
  type Bundle,
  type PackageCatalog,
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
// Keep in lockstep with `reconstructPackageZip` / `writeBundleToBuffer` —
// 1980-01-02T12:00Z survives fflate's local-TZ year check in UTC-12..UTC+14.
const DOS_EPOCH_MS = Date.UTC(1980, 0, 2, 12, 0, 0);
/**
 * Build a deterministic AFPS for a given package type. The content file
 * name varies by type (agent/prompt.md, skill/SKILL.md, etc) — that's
 * what `parsePackageZip` uses to detect the type, so we have to write
 * the right file to round-trip through the importer.
 */
function buildAfps(opts: {
  manifest: Record<string, unknown>;
  content: string;
  type: "agent" | "skill";
}): Uint8Array {
  const filename = opts.type === "agent" ? "prompt.md" : "SKILL.md";
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
function defaultContentFor(type: "agent" | "skill"): string {
  return type === "agent"
    ? "Test prompt."
    : "---\nname: test-skill\ndescription: A test skill.\n---\nSkill body.";
}

async function seedVersionedPackage(opts: {
  id: `@${string}/${string}`;
  type: "agent" | "skill";
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
      schema_version: "0.1",
      display_name: "Root",
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
      schema_version: "0.1",
      display_name: "A",
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
      schema_version: "0.1",
      display_name: "B",
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
      imported: Array<{ identity: string; status: string; version_id: number | null }>;
      root_installed: boolean;
      root_package_id: string;
      root_version: string;
    };
    expect(body.imported).toHaveLength(3);
    expect(body.imported.every((i) => i.status === "inserted" || i.status === "reused")).toBe(true);
    expect(body.root_package_id).toBe("@srcorg/agent-root");
    expect(body.root_version).toBe("1.0.0");
    expect(body.root_installed).toBe(true);

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

    // Each inserted package version leaves an audit trail.
    const auditRows = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "package.version_created"));
    expect(auditRows).toHaveLength(3);
    for (const row of auditRows) {
      expect(row.orgId).toBe(ctx.orgId);
      expect(row.resourceType).toBe("package");
      expect(row.actorType).toBe("user");
      expect(row.after).toMatchObject({ via: "import:bundle" });
    }
    const rootRow = auditRows.find((r) => r.resourceId === "@srcorg/agent-root");
    expect(rootRow?.after).toMatchObject({ type: "agent", version: "1.0.0", root: true });
    const skillRow = auditRows.find((r) => r.resourceId === "@srcorg/skill-a");
    expect(skillRow?.after).toMatchObject({ type: "skill", root: false });
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
        schema_version: "0.1",
        display_name: "Standalone",
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
        schema_version: "0.1",
        display_name: "Standalone",
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
      root_package_id: string;
    };
    expect(body.root_package_id).toBe(agentId);
    expect(body.imported).toHaveLength(1);
  });

  // The bundle path composes the same install-warning collectors as
  // `POST /import` — including the platform timeout ceiling. Read the live
  // ceiling instead of installing one: this file shares its process with every
  // other integration file, and overriding the registry here would leak.
  it("warns when a bundled agent declares a timeout above the platform ceiling", async () => {
    const ceiling = getPlatformRunLimits().timeout_ceiling_seconds;
    const declared = ceiling + 3600;
    const agentId = "@importorg/over-ceiling" as const;
    const manifest = {
      name: agentId,
      version: "1.0.0",
      type: "agent",
      schema_version: "0.1",
      display_name: "Over Ceiling",
      author: "tester",
      timeout: declared,
    };
    const form = new FormData();
    form.append(
      "file",
      new Blob([buildAfps({ manifest, content: "Over-ceiling prompt.", type: "agent" })]),
      "over-ceiling.afps",
    );
    const res = await app.request("/api/packages/import-bundle", {
      method: "POST",
      body: form,
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings).toContain(
      `${agentId}@1.0.0: timeout: declared ${declared}s exceeds this deployment's ceiling — runs will be capped at ${ceiling}s.`,
    );
  });

  it("re-evaluates capped agent resource warnings exactly once when reusing a bundle", async () => {
    const previousAdapter = process.env.RUN_ADAPTER;
    const previousPlatformLimits = getPlatformRunLimits();
    const previousInlineLimits = getInlineRunLimits();
    const agentId = "@importorg/reused-resources" as const;
    const manifest = {
      name: agentId,
      version: "1.0.0",
      type: "agent",
      schema_version: "0.1",
      display_name: "Reused Resources",
      author: "tester",
      _meta: {
        [AGENT_RESOURCES_META_KEY]: { memory_mb: 4096 },
      },
    };
    const afps = buildAfps({
      manifest,
      content: "Resource-aware prompt.",
      type: "agent",
    });

    const importAgent = async () => {
      const form = new FormData();
      form.append("file", new Blob([afps]), "reused-resources.afps");
      const response = await app.request("/api/packages/import-bundle", {
        method: "POST",
        body: form,
        headers: authHeaders(ctx),
      });
      if (response.status !== 201) {
        throw new Error(`unexpected ${response.status}: ${await response.text()}`);
      }
      return (await response.json()) as {
        imported: Array<{ identity: string; status: string }>;
        warnings: string[];
      };
    };

    process.env.RUN_ADAPTER = "docker";
    _resetCacheForTesting();
    try {
      _setRunLimitsForTesting(
        { ...previousPlatformLimits, agent_memory_ceiling_mb: 2048 },
        previousInlineLimits,
      );
      const first = await importAgent();
      expect(first.imported[0]!.status).toBe("inserted");
      expect(first.warnings).toEqual([
        `${agentId}@1.0.0: _meta["${AGENT_RESOURCES_META_KEY}"].memory_mb: declared 4096 MiB exceeds this deployment's effective ceiling — runs will use 2048 MiB.`,
      ]);

      // The same artifact now takes the reuse path. A changed deployment cap
      // must be reflected from current policy, without duplicating the warning.
      _setRunLimitsForTesting(
        { ...previousPlatformLimits, agent_memory_ceiling_mb: 1024 },
        previousInlineLimits,
      );
      const second = await importAgent();
      expect(second.imported[0]!.status).toBe("reused");
      expect(second.warnings).toEqual([
        `${agentId}@1.0.0: _meta["${AGENT_RESOURCES_META_KEY}"].memory_mb: declared 4096 MiB exceeds this deployment's effective ceiling — runs will use 1024 MiB.`,
      ]);
    } finally {
      if (previousAdapter === undefined) delete process.env.RUN_ADAPTER;
      else process.env.RUN_ADAPTER = previousAdapter;
      _resetCacheForTesting();
      _setRunLimitsForTesting(previousPlatformLimits, previousInlineLimits);
    }
  });

  // ── retired `runtime_tools` policy: import-bundle is the READ direction ──
  //
  // `report` was a selectable runtime tool until it was removed from the enum.
  // A bundle is assembled by the platform from its OWN published versions, and
  // a published artifact is immutable by construction — so an agent published
  // before the removal can never be repaired at the source. Rejecting here
  // would 400 the WHOLE bundle (every co-packaged skill and integration with
  // it) with no recourse for the operator, so this path drops instead.
  //
  // Kills the mutation "`parsePackageZip(reconstructed, { retiredRuntimeTools:
  // "drop" })` → `parsePackageZip(reconstructed)`" (back to the reject default,
  // which makes the request a 400) and the mutation "stop pushing the
  // droppedRuntimeTools warning" (the drop becomes silent).
  it("drops a retired runtime_tools id from a legacy package instead of aborting the bundle", async () => {
    const agentId = "@importorg/legacy-runtime-tools" as const;
    const afps = buildAfps({
      manifest: {
        name: agentId,
        version: "1.0.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "Legacy Runtime Tools",
        author: "tester",
        // `output` is still selectable; `report` was retired.
        runtime_tools: ["output", "report"],
      },
      content: "Legacy prompt.",
      type: "agent",
    });

    const form = new FormData();
    form.append("file", new Blob([afps]), "legacy.afps");
    const res = await app.request("/api/packages/import-bundle", {
      method: "POST",
      body: form,
      headers: authHeaders(ctx),
    });
    if (res.status !== 201) {
      throw new Error(`unexpected ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as {
      imported: Array<{ identity: string; status: string }>;
      warnings: string[];
    };
    expect(body.imported).toHaveLength(1);
    expect(body.imported[0]!.status).toBe("inserted");

    // The drop is surfaced, not silent.
    const warning = body.warnings.find((w) => w.includes("report"));
    expect(warning).toBeDefined();
    expect(warning).toContain(agentId);

    // The assertion that matters: the STORED draft lost exactly the retired id
    // and kept the rest. A 201 alone would also pass if the field had been
    // wiped wholesale or left with `report` still in it.
    const [row] = await db
      .select({ draftManifest: packages.draftManifest })
      .from(packages)
      .where(eq(packages.id, agentId))
      .limit(1);
    expect(row).toBeDefined();
    expect((row!.draftManifest as Record<string, unknown>).runtime_tools).toEqual(["output"]);
  });

  // ── retired AFPS 1.x dependency keys: import-bundle is the READ direction ──
  //
  // `dependencies.tools` (now `mcp_servers`) is inert — no reader has ever read
  // it — so a package published with it is not broken, just carrying dead
  // vocabulary. Aborting the whole bundle over it would be gratuitous, and the
  // source artifact is immutable so there is nothing to repair upstream. Import
  // succeeds; the warning is how the operator learns a republish is the fix.
  //
  // Kills the mutation "stop pushing the retired-dependency-key warning" and
  // the mutation "reject retired dependency keys unconditionally" (which would
  // 400 this request and, worse, break every already-published package).
  it("imports a package carrying a retired dependency key and warns instead of aborting", async () => {
    const agentId = "@importorg/legacy-dep-keys" as const;
    const afps = buildAfps({
      manifest: {
        name: agentId,
        version: "1.0.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "Legacy Dep Keys",
        author: "tester",
        dependencies: { tools: { "@appstrate/report": "^1.0.0" } },
      },
      content: "Legacy prompt.",
      type: "agent",
    });

    const form = new FormData();
    form.append("file", new Blob([afps]), "legacy-deps.afps");
    const res = await app.request("/api/packages/import-bundle", {
      method: "POST",
      body: form,
      headers: authHeaders(ctx),
    });
    if (res.status !== 201) {
      throw new Error(`unexpected ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as {
      imported: Array<{ identity: string; status: string }>;
      warnings: string[];
    };
    expect(body.imported).toHaveLength(1);
    expect(body.imported[0]!.status).toBe("inserted");

    const warning = body.warnings.find((w) => w.includes("dependencies.tools"));
    expect(warning).toBeDefined();
    expect(warning).toContain(agentId);
    expect(warning).toContain("dependencies.mcp_servers");

    // Tolerated means LEFT ALONE — the stored draft keeps the retired key
    // verbatim, so the import never rewrites a published manifest's bytes.
    const [row] = await db
      .select({ draftManifest: packages.draftManifest })
      .from(packages)
      .where(eq(packages.id, agentId))
      .limit(1);
    expect((row!.draftManifest as Record<string, unknown>).dependencies).toEqual({
      tools: { "@appstrate/report": "^1.0.0" },
    });
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

    // Reused entries changed no state — only the first import audited.
    const auditRows = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "package.version_created"));
    expect(auditRows).toHaveLength(3);
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

  it("maps a post-install failure to 400 post_install_failed and leaves no orphan packages row", async () => {
    // Export a valid bundle, then tamper the ROOT manifest to declare a
    // self-dependency (`@scope/root` depends on itself). That passes schema
    // validation + bundle read but trips `assertNoCycle` inside
    // `createVersionAndUpload` during post-install — AFTER the importer has
    // inserted the root's `packages` row. The importer must (a) surface a
    // clean 400 `post_install_failed` (not a raw 500) and (b) delete the
    // just-inserted orphan row so no un-runnable package (row with no
    // version) survives.
    const sourceCtx = await createTestContext({ orgSlug: "srcorphan" });
    const { bundle } = await seedAndExportBundle({
      ctx: sourceCtx,
      rootId: "@srcorphan/root",
      skillA: "@srcorphan/skill-a",
      skillB: "@srcorphan/skill-b",
    });
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "destorphan" });

    // Rebuild the root package with a self-referencing skill dependency.
    const rootIdentity = "@srcorphan/root@1.0.0" as never;
    const rootPkg = bundle.packages.get(rootIdentity);
    expect(rootPkg).toBeDefined();
    const manifestBytes = rootPkg!.files.get("manifest.json")!;
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Record<string, unknown>;
    (manifest as { dependencies: Record<string, unknown> }).dependencies = {
      skills: { "@srcorphan/root": "^1.0.0" },
    };
    const files = new Map(rootPkg!.files);
    files.set("manifest.json", enc(JSON.stringify(manifest, null, 2)));
    const tampered: Bundle = { ...bundle, packages: new Map(bundle.packages) };
    tampered.packages.set(rootIdentity, { ...rootPkg!, files });
    const tamperedBytes = writeBundleToBuffer(tampered);

    const form = new FormData();
    form.append("file", new Blob([tamperedBytes]), "bundle.afps-bundle");
    const res = await app.request("/api/packages/import-bundle", {
      method: "POST",
      body: form,
      headers: authHeaders(ctx),
    });

    // Clean 4xx (same shape as single-import), NOT a raw 500.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("post_install_failed");

    // No orphan packages row for the failed root.
    const [orphan] = await db
      .select({ id: packages.id })
      .from(packages)
      .where(eq(packages.id, "@srcorphan/root"))
      .limit(1);
    expect(orphan).toBeUndefined();
    // And certainly no version row for it.
    const [ver] = await db
      .select({ id: packageVersions.id })
      .from(packageVersions)
      .where(eq(packageVersions.packageId, "@srcorphan/root"))
      .limit(1);
    expect(ver).toBeUndefined();
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

  it("reuses existing version without overwriting storage on same-org re-import", async () => {
    // Regression: on same-instance round-trip (publish → export → import),
    // the importer must detect the matching row via the content-hash
    // conflict check and skip uploading the reconstructed STORE-ZIP over
    // the originally-published deflated ZIP. Overwriting would leave the
    // DB-stored envelope integrity out of sync with storage and break
    // /download's integrity gate.
    const { bytes } = await seedAndExportBundle({
      ctx,
      rootId: "@srcself/a",
      skillA: "@srcself/b",
      skillB: "@srcself/c",
    });

    // Capture the pre-import storage bytes for the seeded version.
    const preImportZip = await storage.downloadFile(BUCKET, "@srcself/a/1.0.0.afps");
    expect(preImportZip).not.toBeNull();
    const preImportHash = computeIntegrity(new Uint8Array(preImportZip!));

    // Import the exported bundle back into the same org — every package
    // has a pre-existing version row, so every entry should reuse.
    const form = new FormData();
    form.append("file", new Blob([bytes]), "bundle.afps-bundle");
    const res = await app.request("/api/packages/import-bundle", {
      method: "POST",
      body: form,
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      imported: Array<{ identity: string; status: string }>;
    };
    expect(body.imported.every((i) => i.status === "reused")).toBe(true);

    // Storage must be byte-identical — not clobbered by the reconstructed ZIP.
    const postImportZip = await storage.downloadFile(BUCKET, "@srcself/a/1.0.0.afps");
    expect(postImportZip).not.toBeNull();
    const postImportHash = computeIntegrity(new Uint8Array(postImportZip!));
    expect(postImportHash).toBe(preImportHash);
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

  // ── Declared-but-empty integration gate ─────────────────────────────
  //
  // `/import-bundle` used to run NO integration-selection check at all, so an
  // agent refused by `POST /api/packages/import` imported cleanly here and
  // `postInstallPackage` froze the broken selection into an immutable version.
  // The gate now runs as a pure-read preflight in `handleImportBundle`.

  const gateIntegrationId = "@importorg/gate-integration";

  function gateIntegrationManifest(): Record<string, unknown> {
    return {
      type: "integration",
      schema_version: "0.1",
      name: gateIntegrationId,
      version: "1.0.0",
      display_name: "Gate (test)",
      source: { kind: "none" },
      // No `default_tools`: an absent selection resolves to empty, exactly
      // like the explicit `tools: []` the failing case uses.
      auths: {
        primary: {
          type: "oauth2",
          authorization_endpoint: "https://idp/a",
          token_endpoint: "https://idp/t",
          authorized_uris: ["https://api/*"],
          delivery: {
            http: {
              in: "header",
              name: "Authorization",
              prefix: "Bearer ",
              value: "{$credential.access_token}",
            },
          },
        },
      },
      tools_policy: { list_messages: {} },
      _meta: { "dev.appstrate/api": { auths: { primary: {} } } },
    };
  }

  /**
   * Seed the integration as a draft AND as published `1.0.0` — the gate judges
   * the manifest the agent's `^1.0.0` pin resolves to, so a draft-only package
   * is deliberately never judged.
   */
  async function seedGateIntegration(): Promise<void> {
    await seedPackage({
      id: gateIntegrationId,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: gateIntegrationManifest(),
    });
    await seedPackageVersion({
      packageId: gateIntegrationId,
      version: "1.0.0",
      manifest: gateIntegrationManifest(),
    });
  }

  /**
   * Wrap ONE agent `.afps` into a valid single-package `.afps-bundle`.
   * `depTypes: []` suppresses the transitive walk, so the catalog is never
   * consulted and the bundle carries exactly the agent under test — the gate,
   * not dependency resolution, is what this exercises.
   */
  async function bundleOfOne(manifest: Record<string, unknown>): Promise<Uint8Array> {
    const afps = buildAfps({ manifest, content: "Prompt.", type: "agent" });
    const unusedCatalog: PackageCatalog = {
      resolve: async () => {
        throw new Error("catalog must not be consulted with depTypes: []");
      },
      fetch: async () => {
        throw new Error("catalog must not be consulted with depTypes: []");
      },
    };
    const bundle = await buildBundleFromCatalog(extractRootFromAfps(afps), unusedCatalog, {
      depTypes: [],
    });
    return writeBundleToBuffer(bundle);
  }

  function gatedAgentManifest(
    id: string,
    config: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    return {
      name: id,
      version: "1.0.0",
      type: "agent",
      schema_version: "0.2",
      display_name: "Gated",
      description: "Declares an integration",
      dependencies: { integrations: { [gateIntegrationId]: "^1.0.0" } },
      ...(config ? { integrations_configuration: { [gateIntegrationId]: config } } : {}),
    };
  }

  /**
   * Wrap the agent AND the integration it declares into one SELF-CONTAINED
   * bundle, with the integration absent from the DB. This is the shape that
   * used to bypass the gate: the validator read only the registry, missed the
   * integration, and "not installed → skip silently" waved the agent through
   * into an immutable version.
   */
  async function selfContainedBundle(
    agentManifest: Record<string, unknown>,
    integrationManifest: Record<string, unknown>,
  ): Promise<Uint8Array> {
    const afps = buildAfps({ manifest: agentManifest, content: "Prompt.", type: "agent" });
    const version = integrationManifest.version as string;
    const identity = `${gateIntegrationId}@${version}` as const;
    const files = new Map([["manifest.json", enc(JSON.stringify(integrationManifest, null, 2))]]);
    const catalog: PackageCatalog = {
      resolve: async (name) => (name === gateIntegrationId ? { identity } : null),
      fetch: async () => ({
        identity,
        manifest: integrationManifest as never,
        files,
        integrity: "sha256-recomputed-by-the-builder",
      }),
    };
    const bundle = await buildBundleFromCatalog(extractRootFromAfps(afps), catalog, {
      depTypes: ["integrations"],
    });
    return writeBundleToBuffer(bundle);
  }

  it("resolves the agent's pin against the bundle's carried VERSION, not just its id", async () => {
    // The bundle carries 2.0.0 with no callable selection; the agent pins ^1 and
    // the DB holds a perfectly good 1.0.0. Judging by package id alone (the
    // first implementation) matched the carried 2.0.0 and refused an import the
    // runtime would have run from 1.0.0.
    await seedGateIntegration(); // publishes 1.0.0 in the DB
    const agentId = "@importorg/bundle-pin-mismatch";
    // 2.0.0 dropped the tool the agent selects, so judging against it yields a
    // 400 — which is exactly how this test tells the two behaviours apart.
    const carriedV2 = {
      ...gateIntegrationManifest(),
      version: "2.0.0",
      tools_policy: { other_tool: {} },
    };
    const bytes = await selfContainedBundle(
      // `^1.0.0` cannot be satisfied by the carried 2.0.0.
      gatedAgentManifest(agentId, { tools: ["list_messages"] }),
      carriedV2,
    );

    const form = new FormData();
    form.append("file", new Blob([bytes]), "pin-mismatch.afps-bundle");
    const res = await app.request("/api/packages/import-bundle", {
      method: "POST",
      body: form,
      headers: authHeaders(ctx),
    });

    // Judged against the DB's 1.0.0, where `list_messages` is callable.
    expect(res.status).toBe(201);
  });

  it("resolves a range against the POST-IMPORT union, not carried versions first", async () => {
    await seedGateIntegration(); // DB 1.0.0, callable
    await seedPackageVersion({
      packageId: gateIntegrationId,
      version: "1.1.0",
      manifest: {
        ...gateIntegrationManifest(),
        version: "1.1.0",
        tools_policy: { other_tool: {} },
      },
    });

    const agentId = "@importorg/bundle-union-range";
    const bytes = await selfContainedBundle(
      gatedAgentManifest(agentId, { tools: ["list_messages"] }),
      gateIntegrationManifest(), // carried 1.0.0 is callable, but DB 1.1.0 wins `^1`
    );

    const form = new FormData();
    form.append("file", new Blob([bytes]), "union-range.afps-bundle");
    const res = await app.request("/api/packages/import-bundle", {
      method: "POST",
      body: form,
      headers: authHeaders(ctx),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors?: { code: string }[] };
    expect((body.errors ?? []).map((e) => e.code)).toContain("no_tools_selected");
    await assertDbMissing(packages, eq(packages.id, agentId));
  });

  it("models the `latest` tag after the carried version is imported", async () => {
    await seedGateIntegration();
    const [publishedV1] = await db
      .select({ id: packageVersions.id })
      .from(packageVersions)
      .where(
        and(eq(packageVersions.packageId, gateIntegrationId), eq(packageVersions.version, "1.0.0")),
      )
      .limit(1);
    await db
      .insert(packageDistTags)
      .values({ packageId: gateIntegrationId, tag: "latest", versionId: publishedV1!.id });

    const agentId = "@importorg/bundle-future-latest";
    const agent = gatedAgentManifest(agentId, { tools: ["list_messages"] });
    (agent.dependencies as { integrations: Record<string, string> }).integrations[
      gateIntegrationId
    ] = "latest";
    const bytes = await selfContainedBundle(agent, {
      ...gateIntegrationManifest(),
      version: "2.0.0",
      tools_policy: { other_tool: {} },
    });

    const form = new FormData();
    form.append("file", new Blob([bytes]), "future-latest.afps-bundle");
    const res = await app.request("/api/packages/import-bundle", {
      method: "POST",
      body: form,
      headers: authHeaders(ctx),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors?: { code: string }[] };
    expect((body.errors ?? []).map((e) => e.code)).toContain("no_tools_selected");
    await assertDbMissing(packages, eq(packages.id, agentId));
  });

  it("refuses a SELF-CONTAINED bundle whose carried integration exposes no tool", async () => {
    // The integration is deliberately NOT seeded — it travels in the bundle.
    const agentId = "@importorg/bundle-self-contained";
    const bytes = await selfContainedBundle(
      gatedAgentManifest(agentId, { tools: [] }),
      gateIntegrationManifest(),
    );

    const form = new FormData();
    form.append("file", new Blob([bytes]), "self-contained.afps-bundle");
    const res = await app.request("/api/packages/import-bundle", {
      method: "POST",
      body: form,
      headers: authHeaders(ctx),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors?: { code: string; message: string }[] };
    expect((body.errors ?? []).map((e) => e.code)).toContain("no_tools_selected");
    // Nothing was written: the gate is a preflight, before the first insert.
    await assertDbMissing(packages, eq(packages.id, agentId));
  });

  it("refuses a bundle whose agent declares an integration selecting no tool", async () => {
    await seedGateIntegration();
    const agentId = "@importorg/bundle-empty-tools";
    const bytes = await bundleOfOne(gatedAgentManifest(agentId, { tools: [] }));

    const form = new FormData();
    form.append("file", new Blob([bytes]), "broken.afps-bundle");
    const res = await app.request("/api/packages/import-bundle", {
      method: "POST",
      body: form,
      headers: authHeaders(ctx),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      errors?: { code: string; field: string; message: string }[];
    };
    expect(body.errors?.[0]?.code).toBe("no_tools_selected");
    expect(body.errors?.[0]?.field).toBe(`integrations_configuration.${gateIntegrationId}.tools`);
    // The bundle carries many manifests — the message must name WHICH package.
    expect(body.errors?.[0]?.message).toStartWith(`${agentId}@1.0.0:`);

    // All-or-nothing, and preflight: nothing was written.
    const rows = await db
      .select({ id: packages.id })
      .from(packages)
      .where(eq(packages.id, agentId));
    expect(rows).toHaveLength(0);
  });

  it("imports the same bundle once a tool is selected", async () => {
    // Negative control — the gate must refuse the empty selection, not every
    // agent that declares an integration.
    await seedGateIntegration();
    const agentId = "@importorg/bundle-with-tool";
    const bytes = await bundleOfOne(gatedAgentManifest(agentId, { tools: ["list_messages"] }));

    const form = new FormData();
    form.append("file", new Blob([bytes]), "ok.afps-bundle");
    const res = await app.request("/api/packages/import-bundle", {
      method: "POST",
      body: form,
      headers: authHeaders(ctx),
    });

    if (res.status !== 201) {
      throw new Error(`unexpected ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as { imported: Array<{ identity: string; status: string }> };
    expect(body.imported).toHaveLength(1);
    expect(body.imported[0]!.status).toBe("inserted");
  });
});
