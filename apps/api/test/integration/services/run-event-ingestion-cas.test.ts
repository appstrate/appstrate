// SPDX-License-Identifier: Apache-2.0

/**
 * CRIT-12 regression — the ingestion CAS is closed against finalize and the
 * run status is monotone.
 *
 *   1. `persistEventAndAdvance` carries `isNull(runs.sinkClosedAt)` in the
 *      CAS WHERE and reports `"sink_closed"` when finalize won the race —
 *      `ingestRunEvent` surfaces that as a 410 `run_sink_closed` instead of
 *      silently appending events / flipping a finished run back to `running`.
 *   2. `updateRun` refuses to SET an ACTIVE status (`pending`/`running`) on a
 *      run whose current status is terminal (monotone-status WHERE guard).
 *   3. The happy path still works: an in-order event on an open run claims
 *      the sequence, writes the log row, and flips pending → running.
 *
 * Service-level (route-layer coverage lives in
 * `test/integration/routes/runs-events-ingestion.test.ts`, owned separately):
 * we drive `ingestRunEvent` with a STALE `RunSinkContext` snapshot — taken
 * while the sink was open, applied after finalize closed it — which is
 * exactly the race the CAS closes (the middleware's `assertSinkOpen` runs on
 * a snapshot too).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs, runLogs } from "@appstrate/db/schema";
import { encrypt } from "@appstrate/connect";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { getRunSinkContext, ingestRunEvent } from "../../../src/services/run-event-ingestion.ts";
import { updateRun } from "../../../src/services/state/runs.ts";
import { ApiError } from "../../../src/lib/errors.ts";
import type { CloudEventEnvelope } from "@appstrate/afps-runtime/events";

const AGENT = "@casorg/cas-agent";
const RUN_SECRET = "b".repeat(43);

function buildEnvelope(
  runId: string,
  sequence: number,
  data: Record<string, unknown> = { message: "hello", timestamp: Date.now() },
): CloudEventEnvelope {
  return {
    specversion: "1.0",
    type: "appstrate.progress",
    source: `/afps/runs/${runId}`,
    id: `msg_${crypto.randomUUID()}`,
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    data,
    sequence,
  };
}

async function seedSinkRun(
  ctx: TestContext,
  overrides: {
    status?: "pending" | "running" | "success" | "failed";
    sinkClosedAt?: Date | null;
  } = {},
): Promise<string> {
  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(runs).values({
    id: runId,
    packageId: AGENT,
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    status: overrides.status ?? "running",
    runOrigin: "platform",
    sinkSecretEncrypted: encrypt(RUN_SECRET),
    sinkExpiresAt: new Date(Date.now() + 3600_000),
    sinkClosedAt: overrides.sinkClosedAt ?? null,
    startedAt: new Date(),
    tokenUsage: { input_tokens: 100, output_tokens: 50 },
  });
  return runId;
}

async function readRun(runId: string) {
  const [row] = await db
    .select({
      status: runs.status,
      lastEventSequence: runs.lastEventSequence,
      sinkClosedAt: runs.sinkClosedAt,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  return row!;
}

describe("run event ingestion — CAS closed against finalize (CRIT-12)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "casorg" });
    await seedPackage({ id: AGENT, orgId: ctx.orgId, type: "agent" });
  });

  it("an event in flight when finalize closes the sink gets 410 and mutates nothing", async () => {
    const runId = await seedSinkRun(ctx, { status: "running" });

    // Snapshot the sink context while the sink is still OPEN — this is the
    // state the verify-signature middleware would have loaded before the
    // event's CAS commits.
    const run = await getRunSinkContext(runId);
    expect(run).not.toBeNull();
    expect(run!.sinkClosedAt).toBeNull();

    // Finalize wins the race: the run goes terminal and the sink closes
    // BETWEEN the snapshot read and the ingestion CAS.
    const closedAt = new Date();
    await db
      .update(runs)
      .set({ status: "success", sinkClosedAt: closedAt, completedAt: closedAt })
      .where(eq(runs.id, runId));

    const err = await ingestRunEvent({
      run: run!,
      envelope: buildEnvelope(runId, 1),
      webhookId: `msg_${crypto.randomUUID()}`,
    }).catch((e: unknown) => e);

    // Without `isNull(runs.sinkClosedAt)` in the CAS WHERE the update would
    // match, append the event, and (firstEvent branch) try to flip the run
    // back to `running`. Post-fix: a 410 `run_sink_closed`, nothing written.
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(410);
    expect((err as ApiError).code).toBe("run_sink_closed");

    const row = await readRun(runId);
    expect(row.status).toBe("success"); // terminal status untouched
    expect(row.lastEventSequence).toBe(0); // sequence not advanced
    expect(row.sinkClosedAt).not.toBeNull();

    const logs = await db.select().from(runLogs).where(eq(runLogs.runId, runId));
    expect(logs).toHaveLength(0); // no event row leaked past the closed sink
  });

  it("updateRun refuses to set an ACTIVE status on a terminal run (monotone status)", async () => {
    const runId = await seedSinkRun(ctx, { status: "success" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };

    // A late "flip to running" (event ingestion racing finalize) must be a
    // no-op — the WHERE constrains active-status writes to still-active rows.
    await updateRun(scope, runId, { status: "running" });
    expect((await readRun(runId)).status).toBe("success");

    await updateRun(scope, runId, { status: "pending" });
    expect((await readRun(runId)).status).toBe("success");
  });

  it("updateRun still allows the normal pending → running transition", async () => {
    const runId = await seedSinkRun(ctx, { status: "pending" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };

    await updateRun(scope, runId, { status: "running" });
    expect((await readRun(runId)).status).toBe("running");
  });

  it("a normal in-order event on an open run still advances the sequence (happy path)", async () => {
    const runId = await seedSinkRun(ctx, { status: "pending" });
    const run = await getRunSinkContext(runId);
    expect(run).not.toBeNull();

    const outcome = await ingestRunEvent({
      run: run!,
      envelope: buildEnvelope(runId, 1),
      webhookId: `msg_${crypto.randomUUID()}`,
    });

    expect(outcome).toEqual({ status: "persisted", sequence: 1 });

    const row = await readRun(runId);
    expect(row.lastEventSequence).toBe(1);
    // First ingested event flips pending → running (owned by the same CAS tx).
    expect(row.status).toBe("running");

    const logs = await db.select().from(runLogs).where(eq(runLogs.runId, runId));
    expect(logs.length).toBeGreaterThan(0);
  });
});
