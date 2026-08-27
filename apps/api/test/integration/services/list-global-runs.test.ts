// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for listGlobalRuns (GET /api/runs). Covers the kind
 * filter (via packages.ephemeral JOIN), the packageEphemeral flag on each
 * returned row, and status / date filters.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "../../helpers/db.ts";
import { eq } from "drizzle-orm";
import { packages, files, runs, chatSessions } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedPackage, seedRun } from "../../helpers/seed.ts";
import { insertShadowPackage } from "../../../src/services/inline-run.ts";
import { listGlobalRuns } from "../../../src/services/state/runs.ts";
import type { AgentManifest } from "../../../src/types/index.ts";
import { prefixedId } from "../../../src/lib/ids.ts";

const inlineManifest = {
  name: "@inline/r-test",
  display_name: "Inline",
  version: "0.0.0",
  type: "agent",
  description: "Inline",
  schema_version: "0.1",
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
      spaceId: ctx.defaultSpaceId,
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
      spaceId: ctx.defaultSpaceId,
      status,
      startedAt: new Date(),
    });
  }

  it("returns empty list when no runs exist", async () => {
    const result = await listGlobalRuns({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId });
    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("returns all runs by default, with packageEphemeral flag", async () => {
    const inline = await seedInlineRun();
    const pkg = await seedPackageRun();

    const result = await listGlobalRuns({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId });
    expect(result.total).toBe(2);

    const byId = Object.fromEntries(result.data.map((r) => [r.id, r]));
    expect(byId[inline.id]?.package_ephemeral).toBe(true);
    expect(byId[pkg.id]?.package_ephemeral).toBe(false);
  });

  it("kind='inline' returns only runs backed by an ephemeral package", async () => {
    await seedInlineRun();
    await seedInlineRun();
    await seedPackageRun();

    const result = await listGlobalRuns(
      { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      { kind: "inline" },
    );
    expect(result.total).toBe(2);
    for (const run of result.data) {
      expect(run.package_ephemeral).toBe(true);
    }
  });

  it("kind='package' returns only runs backed by a non-ephemeral package", async () => {
    await seedInlineRun();
    await seedPackageRun();
    await seedPackageRun();

    const result = await listGlobalRuns(
      { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      { kind: "package" },
    );
    expect(result.total).toBe(2);
    for (const run of result.data) {
      expect(run.package_ephemeral).toBe(false);
    }
  });

  it("kind='all' is equivalent to no filter", async () => {
    await seedInlineRun();
    await seedPackageRun();

    const all = await listGlobalRuns(
      { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      { kind: "all" },
    );
    expect(all.total).toBe(2);
  });

  it("filters by status", async () => {
    await seedInlineRun("success");
    await seedPackageRun("failed");

    const result = await listGlobalRuns(
      { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      { status: "failed" },
    );
    expect(result.total).toBe(1);
    expect(result.data[0]?.status).toBe("failed");
  });

  it("filters by the caller-owned chat session that launched the run", async () => {
    const ownSessionId = `chs_${crypto.randomUUID()}`;
    await db.insert(chatSessions).values({
      id: ownSessionId,
      orgId: ctx.orgId,
      userId: ctx.user.id,
    });
    const linked = await seedPackageRun();
    await db.update(runs).set({ chatSessionId: ownSessionId }).where(eq(runs.id, linked.id));
    await seedPackageRun();

    const result = await listGlobalRuns(
      { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      { chatSessionId: ownSessionId, actor: { type: "user", id: ctx.user.id } },
    );
    expect(result.data.map((run) => run.id)).toEqual([linked.id]);

    const other = await createTestUser({ email: "other-run-chat-owner@test.local" });
    await addOrgMember(ctx.orgId, other.id, "member");
    const denied = await listGlobalRuns(
      { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      { chatSessionId: ownSessionId, actor: { type: "user", id: other.id } },
    );
    expect(denied.data).toEqual([]);
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
      { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      { startDate: new Date("2024-01-01") },
    );
    expect(since2024.data.map((r) => r.id)).toEqual([recent.id]);

    const until2023 = await listGlobalRuns(
      { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      { endDate: new Date("2023-01-01") },
    );
    expect(until2023.data.map((r) => r.id)).toEqual([old.id]);
  });

  it("respects the spaceId filter (cross-space isolation)", async () => {
    await seedPackageRun();

    // Different space in the same org — seedSpace directly
    const { spaces } = await import("@appstrate/db/schema");
    const [otherSpace] = await db
      .insert(spaces)
      .values({
        id: prefixedId("spc"),
        name: "Other Space",
        orgId: ctx.orgId,
      })
      .returning();

    const result = await listGlobalRuns({ orgId: ctx.orgId, spaceId: otherSpace!.id });
    expect(result.total).toBe(0);
  });

  async function seedRunFile(runId: string, purpose: "agent_output" | "user_upload") {
    const docId = `file_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await db.insert(files).values({
      id: docId,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      purpose,
      runId,
      storageKey: `files/${ctx.defaultSpaceId}/${docId}/out.txt`,
      name: "out.txt",
      mime: "text/plain",
      size: 3,
      sha256: crypto.randomUUID().replace(/-/g, ""),
    });
    return docId;
  }

  const seedOutputFile = (runId: string) => seedRunFile(runId, "agent_output");

  it("reports file_counts: input from run.input URIs, output from files rows", async () => {
    const pkg = await seedPackage({
      id: `@globalruns/agent-${crypto.randomUUID().slice(0, 8)}`,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });
    // Two distinct input file URIs (one duplicated → deduped to 2), plus a
    // malformed one that must be ignored by extractFileIds.
    const withDocs = await seedRun({
      packageId: pkg.id,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      status: "success",
      startedAt: new Date(),
      input: {
        file: "appfile://file_aaaaaaaa",
        again: "appfile://file_aaaaaaaa",
        nested: { other: "appfile://file_bbbbbbbb" },
        bogus: "appfile://file_x",
      },
    });
    await seedOutputFile(withDocs.id);
    await seedOutputFile(withDocs.id);
    await seedOutputFile(withDocs.id);

    // A run with null input and no files → both counts zero.
    const empty = await seedPackageRun();

    const result = await listGlobalRuns({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId });
    const byId = Object.fromEntries(result.data.map((r) => [r.id, r]));

    expect(byId[withDocs.id]?.file_counts).toEqual({ input: 2, output: 3 });
    expect(byId[empty.id]?.file_counts).toEqual({ input: 0, output: 0 });
    // The derived presentation rule (0 → nothing, 1 → shown, N → a list) reads
    // ONLY this count. The run projection carries no primary/featured field for
    // a client to prefer over it.
    expect(byId[withDocs.id]).not.toHaveProperty("primary_file_id");
    expect(byId[empty.id]).not.toHaveProperty("primary_file_id");
  });

  it("exposes the produced-file count a client derives its presentation from", async () => {
    // The three cases the client-side rule distinguishes, end to end.
    const zero = await seedPackageRun();
    const one = await seedPackageRun();
    await seedOutputFile(one.id);
    const many = await seedPackageRun();
    await seedOutputFile(many.id);
    await seedOutputFile(many.id);

    const result = await listGlobalRuns({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId });
    const byId = Object.fromEntries(result.data.map((r) => [r.id, r]));

    expect(byId[zero.id]?.file_counts.output).toBe(0);
    expect(byId[one.id]?.file_counts.output).toBe(1);
    expect(byId[many.id]?.file_counts.output).toBe(2);
    for (const run of [zero, one, many]) {
      expect(byId[run.id]).not.toHaveProperty("primary_file_id");
    }
  });

  it("does not count a materialized INPUT upload as an output file", async () => {
    // A run triggered with one file input and publishing nothing. The
    // materialized `user_upload` carries the SAME run_id as any output would, so
    // an unfiltered count reported it twice — once as input (from the run's
    // `appfile://` URI) and once as output.
    const pkg = await seedPackage({
      id: `@globalruns/agent-${crypto.randomUUID().slice(0, 8)}`,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });
    const run = await seedRun({
      packageId: pkg.id,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      status: "success",
      startedAt: new Date(),
      input: {},
    });
    const docId = await seedRunFile(run.id, "user_upload");
    await db
      .update(runs)
      .set({ input: { file: `appfile://${docId}` } })
      .where(eq(runs.id, run.id));

    const result = await listGlobalRuns({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId });
    const row = result.data.find((r) => r.id === run.id);
    expect(row?.file_counts).toEqual({ input: 1, output: 0 });
  });

  it("orders by startedAt DESC and paginates", async () => {
    for (let i = 0; i < 5; i++) await seedPackageRun();

    const page1 = await listGlobalRuns(
      { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      { limit: 2, offset: 0 },
    );
    expect(page1.data).toHaveLength(2);
    expect(page1.total).toBe(5);

    const page2 = await listGlobalRuns(
      { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      { limit: 2, offset: 2 },
    );
    expect(page2.data).toHaveLength(2);
    expect(page2.data[0]?.id).not.toBe(page1.data[0]?.id);
  });
});
