// SPDX-License-Identifier: Apache-2.0

/**
 * Integration coverage for `deleteOrphanShadowPackage`. Two invariants
 * matter:
 *
 *   1. A no-runs shadow (pipeline failed before promoting) is purged —
 *      the row must not leak forever.
 *   2. A shadow already referenced by a `runs` row is NOT deleted, even
 *      if it is flagged ephemeral. `runs.package_id` has `ON DELETE
 *      CASCADE`, so a misdirected call would wipe the historical run
 *      and its logs; the guard must refuse.
 *
 * Together they fence the "pipeline returned !ok AFTER writing runs"
 * footgun identified in the PR review — the runtime check holds the
 * contract even if the pipeline ever drifts from its "no runs row
 * until ok" promise.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../helpers/db.ts";
import { packages, runs } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedRun } from "../../helpers/seed.ts";
import {
  insertShadowPackage,
  deleteOrphanShadowPackage,
} from "../../../src/services/inline-run.ts";
import type { AgentManifest } from "../../../src/types/index.ts";

const manifest = {
  name: "@inline/r-test",
  displayName: "Test Inline Agent",
  version: "0.0.0",
  type: "agent",
  description: "Inline",
  schemaVersion: "1.0.0",
} as unknown as AgentManifest;

describe("deleteOrphanShadowPackage", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orphanorg" });
  });

  it("purges a shadow with no referencing runs row", async () => {
    const shadowId = await insertShadowPackage({
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      manifest,
      prompt: "boom",
    });

    await deleteOrphanShadowPackage(shadowId);

    const rows = await db.select().from(packages).where(eq(packages.id, shadowId));
    expect(rows).toHaveLength(0);
  });

  it("refuses to delete a shadow once a runs row references it — preserves history", async () => {
    const shadowId = await insertShadowPackage({
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      manifest,
      prompt: "already running",
    });

    const run = await seedRun({
      packageId: shadowId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "success",
    });

    // Invariant-violating call — this is the exact scenario the review
    // flagged: pipeline creates a runs row, then the caller still
    // invokes purge-on-failure. The guard must refuse.
    await deleteOrphanShadowPackage(shadowId);

    // Shadow row preserved (compaction worker's job, not ours).
    const [pkg] = await db.select().from(packages).where(eq(packages.id, shadowId));
    expect(pkg).toBeDefined();
    expect(pkg?.ephemeral).toBe(true);

    // Run row preserved — no cascade wipe.
    const [preservedRun] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(preservedRun).toBeDefined();
    expect(preservedRun?.status).toBe("success");
  });

  it("is a safe no-op on a non-ephemeral package id (suspenders scope check)", async () => {
    // A misdirected delete with a regular package id must NOT remove
    // the row — the DELETE is AND-scoped to `ephemeral = true`.
    await db.insert(packages).values({
      id: "@orphanorg/regular",
      orgId: ctx.orgId,
      type: "agent",
      source: "local",
      ephemeral: false,
      draftManifest: manifest as unknown as Record<string, unknown>,
      draftContent: "keep me",
      createdBy: ctx.user.id,
      autoInstalled: false,
    });

    await deleteOrphanShadowPackage("@orphanorg/regular");

    const [row] = await db.select().from(packages).where(eq(packages.id, "@orphanorg/regular"));
    expect(row).toBeDefined();
    expect(row?.draftContent).toBe("keep me");
  });
});
