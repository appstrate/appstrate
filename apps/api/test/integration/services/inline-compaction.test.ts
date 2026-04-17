// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the inline-compaction service. Verifies the core
 * retention logic without touching BullMQ (the scheduler is covered by the
 * infrastructure queue adapters).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../helpers/db.ts";
import { packages, runs, runLogs } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedRun, seedRunLog, seedPackage } from "../../helpers/seed.ts";
import { compactInlineRuns } from "../../../src/services/inline-compaction.ts";
import { insertShadowPackage } from "../../../src/services/inline-run.ts";
import type { AgentManifest } from "../../../src/types/index.ts";

const manifest = {
  name: "@inline/r-test",
  displayName: "Test Inline Agent",
  version: "0.0.0",
  type: "agent",
  description: "Inline",
  schemaVersion: "1.0.0",
} as unknown as AgentManifest;

async function backdatePackage(id: string, daysAgo: number): Promise<void> {
  const date = new Date(Date.now() - daysAgo * 86_400_000);
  await db.update(packages).set({ createdAt: date }).where(eq(packages.id, id));
}

describe("compactInlineRuns", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "compactorg" });
  });

  it("is a no-op when no shadow packages exist", async () => {
    const result = await compactInlineRuns(30);
    expect(result).toEqual({ compactedPackages: 0, deletedRunLogs: 0 });
  });

  it("leaves recent shadows alone (younger than retention window)", async () => {
    const shadowId = await insertShadowPackage({
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      manifest,
      prompt: "hello",
    });

    const result = await compactInlineRuns(30);
    expect(result.compactedPackages).toBe(0);

    const [row] = await db.select().from(packages).where(eq(packages.id, shadowId));
    expect(row?.draftManifest).toEqual(manifest as unknown as Record<string, unknown>);
    expect(row?.draftContent).toBe("hello");
  });

  it("NULLs manifest + prompt for shadows older than retention, deletes their run_logs, preserves runs rows", async () => {
    const shadowId = await insertShadowPackage({
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      manifest,
      prompt: "compact me",
    });
    await backdatePackage(shadowId, 60);

    const run = await seedRun({
      packageId: shadowId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "success",
    });
    await seedRunLog({ runId: run.id, orgId: ctx.orgId, message: "old log 1" });
    await seedRunLog({ runId: run.id, orgId: ctx.orgId, message: "old log 2" });

    const result = await compactInlineRuns(30);
    expect(result.compactedPackages).toBe(1);
    expect(result.deletedRunLogs).toBe(2);

    const [pkg] = await db.select().from(packages).where(eq(packages.id, shadowId));
    expect(pkg?.draftManifest).toEqual({});
    expect(pkg?.draftContent).toBe("");

    const logs = await db.select().from(runLogs).where(eq(runLogs.runId, run.id));
    expect(logs).toHaveLength(0);

    // Run row itself is preserved for accounting/audit.
    const [preservedRun] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(preservedRun).toBeDefined();
    expect(preservedRun?.status).toBe("success");
  });

  it("does not compact non-ephemeral packages even if old", async () => {
    const pkg = await seedPackage({
      id: "@compactorg/regular",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });
    await backdatePackage(pkg.id, 999);

    const result = await compactInlineRuns(30);
    expect(result.compactedPackages).toBe(0);

    const [row] = await db.select().from(packages).where(eq(packages.id, pkg.id));
    expect(row?.draftManifest).not.toEqual({});
  });

  it("is idempotent — re-running on already-compacted shadows is a no-op", async () => {
    const shadowId = await insertShadowPackage({
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      manifest,
      prompt: "compact me",
    });
    await backdatePackage(shadowId, 60);

    const first = await compactInlineRuns(30);
    expect(first.compactedPackages).toBe(1);

    const second = await compactInlineRuns(30);
    expect(second.compactedPackages).toBe(0);
    expect(second.deletedRunLogs).toBe(0);
  });

  it("honors the retentionDays parameter (shorter window compacts more)", async () => {
    const shadow1 = await insertShadowPackage({
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      manifest,
      prompt: "old",
    });
    await backdatePackage(shadow1, 10);

    const shadow2 = await insertShadowPackage({
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      manifest,
      prompt: "recent",
    });
    await backdatePackage(shadow2, 2);

    const result = await compactInlineRuns(5);
    expect(result.compactedPackages).toBe(1);

    const [pkg1] = await db.select().from(packages).where(eq(packages.id, shadow1));
    const [pkg2] = await db.select().from(packages).where(eq(packages.id, shadow2));
    expect(pkg1?.draftManifest).toEqual({});
    expect(pkg2?.draftManifest).not.toEqual({});
  });
});
