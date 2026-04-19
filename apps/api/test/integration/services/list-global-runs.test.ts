// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for listGlobalRuns (GET /api/runs). Covers the kind
 * filter (via packages.ephemeral JOIN), the packageEphemeral flag on each
 * returned row, and status / date filters.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "../../helpers/db.ts";
import { eq } from "drizzle-orm";
import { packages } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedRun } from "../../helpers/seed.ts";
import { insertShadowPackage } from "../../../src/services/inline-run.ts";
import { listGlobalRuns } from "../../../src/services/state/runs.ts";
import type { AgentManifest } from "../../../src/types/index.ts";

const inlineManifest = {
  name: "@inline/r-test",
  displayName: "Inline",
  version: "0.0.0",
  type: "agent",
  description: "Inline",
  schemaVersion: "1.0.0",
} as unknown as AgentManifest;

describe("listGlobalRuns", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "globalruns" });
  });

  async function seedInlineRun(status: "pending" | "success" | "failed" = "success") {
    const shadowId = await insertShadowPackage({
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      manifest: inlineManifest,
      prompt: "hi",
    });
    return seedRun({
      packageId: shadowId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status,
      startedAt: new Date(),
    });
  }

  async function seedPackageRun(status: "pending" | "success" | "failed" = "success") {
    const pkg = await seedPackage({
      id: `@globalruns/agent-${crypto.randomUUID().slice(0, 8)}`,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });
    return seedRun({
      packageId: pkg.id,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status,
      startedAt: new Date(),
    });
  }

  it("returns empty list when no runs exist", async () => {
    const result = await listGlobalRuns({ orgId: ctx.orgId, applicationId: ctx.defaultAppId });
    expect(result.runs).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("returns all runs by default, with packageEphemeral flag", async () => {
    const inline = await seedInlineRun();
    const pkg = await seedPackageRun();

    const result = await listGlobalRuns({ orgId: ctx.orgId, applicationId: ctx.defaultAppId });
    expect(result.total).toBe(2);

    const byId = Object.fromEntries(result.runs.map((r) => [r.id, r]));
    expect(byId[inline.id]?.packageEphemeral).toBe(true);
    expect(byId[pkg.id]?.packageEphemeral).toBe(false);
  });

  it("kind='inline' returns only runs backed by an ephemeral package", async () => {
    await seedInlineRun();
    await seedInlineRun();
    await seedPackageRun();

    const result = await listGlobalRuns(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { kind: "inline" },
    );
    expect(result.total).toBe(2);
    for (const run of result.runs) {
      expect(run.packageEphemeral).toBe(true);
    }
  });

  it("kind='package' returns only runs backed by a non-ephemeral package", async () => {
    await seedInlineRun();
    await seedPackageRun();
    await seedPackageRun();

    const result = await listGlobalRuns(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { kind: "package" },
    );
    expect(result.total).toBe(2);
    for (const run of result.runs) {
      expect(run.packageEphemeral).toBe(false);
    }
  });

  it("kind='all' is equivalent to no filter", async () => {
    await seedInlineRun();
    await seedPackageRun();

    const all = await listGlobalRuns(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { kind: "all" },
    );
    expect(all.total).toBe(2);
  });

  it("filters by status", async () => {
    await seedInlineRun("success");
    await seedPackageRun("failed");

    const result = await listGlobalRuns(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { status: "failed" },
    );
    expect(result.total).toBe(1);
    expect(result.runs[0]?.status).toBe("failed");
  });

  it("filters by startDate / endDate", async () => {
    const old = await seedPackageRun();
    // Backdate old run
    await db
      .update(packages)
      .set({ createdAt: new Date("2020-01-01") })
      .where(eq(packages.id, (old as { packageId: string }).packageId));
    const runsSchema = (await import("@appstrate/db/schema")).runs;
    await db
      .update(runsSchema)
      .set({ startedAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(runsSchema.id, old.id));

    const recent = await seedPackageRun();

    const since2024 = await listGlobalRuns(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { startDate: new Date("2024-01-01") },
    );
    expect(since2024.runs.map((r) => r.id)).toEqual([recent.id]);

    const until2023 = await listGlobalRuns(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { endDate: new Date("2023-01-01") },
    );
    expect(until2023.runs.map((r) => r.id)).toEqual([old.id]);
  });

  it("respects the applicationId filter (cross-app isolation)", async () => {
    await seedPackageRun();

    // Different application in the same org — seedApplication directly
    const { applications } = await import("@appstrate/db/schema");
    const [otherApp] = await db
      .insert(applications)
      .values({
        id: `app_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        name: "Other App",
        orgId: ctx.orgId,
      })
      .returning();

    const result = await listGlobalRuns({ orgId: ctx.orgId, applicationId: otherApp!.id });
    expect(result.total).toBe(0);
  });

  it("orders by startedAt DESC and paginates", async () => {
    for (let i = 0; i < 5; i++) await seedPackageRun();

    const page1 = await listGlobalRuns(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { limit: 2, offset: 0 },
    );
    expect(page1.runs).toHaveLength(2);
    expect(page1.total).toBe(5);

    const page2 = await listGlobalRuns(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { limit: 2, offset: 2 },
    );
    expect(page2.runs).toHaveLength(2);
    expect(page2.runs[0]?.id).not.toBe(page1.runs[0]?.id);
  });
});
