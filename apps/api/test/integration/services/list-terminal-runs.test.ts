// SPDX-License-Identifier: Apache-2.0

/**
 * `listTerminalRuns` — the platform side of `PlatformServices.runs.listTerminal`, the cursor
 * read a metering module settles compute minutes from. Locks down: only terminal runs with a
 * `completed_at` are visible, `(completed_at, id)` ASC ordering, the exclusive keyset
 * (including the same-instant tie broken by id), the origin and duration projection, and the
 * limit clamp.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { listTerminalRuns } from "../../../src/services/state/runs.ts";

describe("listTerminalRuns", () => {
  let ctx: TestContext;

  async function run(
    id: string,
    over: { status?: "pending" | "running" | "success" | "failed" | "timeout" | "cancelled" } & {
      completedAt?: Date | null;
      duration?: number | null;
      runOrigin?: "platform" | "remote";
    },
  ) {
    return seedRun({
      id,
      packageId: "@meterorg/agent",
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      status: over.status ?? "success",
      completedAt:
        over.completedAt === undefined ? new Date("2026-11-01T10:00:00Z") : over.completedAt,
      duration: over.duration === undefined ? 1000 : over.duration,
      ...(over.runOrigin ? { runOrigin: over.runOrigin } : {}),
    });
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "meterorg" });
    await seedAgent({ id: "@meterorg/agent", orgId: ctx.orgId, createdBy: ctx.user.id });
  });

  it("returns only finished runs, ordered by (completed_at, id)", async () => {
    await run("run_b", { completedAt: new Date("2026-11-01T10:00:05Z") });
    await run("run_a", { completedAt: new Date("2026-11-01T10:00:05Z") });
    await run("run_early", { status: "failed", completedAt: new Date("2026-11-01T09:59:00Z") });
    await run("run_live", { status: "running", completedAt: null, duration: null });
    await run("run_queued", { status: "pending", completedAt: null, duration: null });

    const rows = await listTerminalRuns({});
    expect(rows.map((r) => r.id)).toEqual(["run_early", "run_a", "run_b"]);
  });

  it("projects origin, status and duration, and nothing else", async () => {
    await run("run_remote", { runOrigin: "remote", duration: 42_000, status: "timeout" });
    await run("run_nodur", { duration: null, completedAt: new Date("2026-11-01T10:00:01Z") });

    const rows = await listTerminalRuns({});
    const remote = rows.find((r) => r.id === "run_remote")!;
    expect(remote).toEqual({
      id: "run_remote",
      orgId: ctx.orgId,
      runOrigin: "remote",
      status: "timeout",
      durationMs: 42_000,
      completedAt: new Date("2026-11-01T10:00:00Z"),
    });
    expect(rows.find((r) => r.id === "run_nodur")!.durationMs).toBeNull();
  });

  it("`after` is exclusive and breaks a same-instant tie by id", async () => {
    const t = new Date("2026-11-01T10:00:00Z");
    await run("run_a", { completedAt: t });
    await run("run_b", { completedAt: t });
    await run("run_c", { completedAt: new Date("2026-11-01T10:00:01Z") });

    const afterA = await listTerminalRuns({ after: { completedAt: t, id: "run_a" } });
    expect(afterA.map((r) => r.id)).toEqual(["run_b", "run_c"]);

    const afterC = await listTerminalRuns({
      after: { completedAt: new Date("2026-11-01T10:00:01Z"), id: "run_c" },
    });
    expect(afterC).toEqual([]);
  });

  it("clamps the limit to at least one row and pages through the cursor", async () => {
    for (let i = 0; i < 3; i++) {
      await run(`run_${i}`, { completedAt: new Date(`2026-11-01T10:00:0${i}Z`) });
    }
    const first = await listTerminalRuns({ limit: 0 });
    expect(first.map((r) => r.id)).toEqual(["run_0"]);

    const page = await listTerminalRuns({
      limit: 2,
      after: { completedAt: first[0]!.completedAt, id: first[0]!.id },
    });
    expect(page.map((r) => r.id)).toEqual(["run_1", "run_2"]);
  });
});
