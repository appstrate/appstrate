// SPDX-License-Identifier: Apache-2.0

/**
 * Platform-synthesised terminals must recover the structured deliverable the
 * agent already emitted (issue #1020).
 *
 * The `output` runtime tool is persisted at emit time as a `run_logs` row
 * (`type='result'`, `event='output'`), but `runs.result` is written only at
 * finalize from the RunResult the runner posts. On every path where the
 * runner never posts its own finalize — user cancel, timeout, container
 * crash, stall watchdog, boot orphan sweep — the platform synthesises an
 * empty RunResult, so a run whose agent HAD delivered its output used to end
 * with `runs.result = null`: recoverable on disk, invisible to
 * `GET /api/runs/:id`, the dashboard and the CLI's `--output`.
 *
 * The invariant these tests pin is "recover, never fabricate": only an
 * actually persisted payload lands on `runs.result`. A run whose agent never
 * called `output` must keep producing a null result, exactly as before.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { encrypt } from "@appstrate/connect";
import { sign } from "@appstrate/afps-runtime/events";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import {
  applyRecoveredOutput,
  getRunSinkContext,
  synthesiseFinalize,
} from "../../../src/services/run-event-ingestion.ts";
import { emptyRunResult } from "@appstrate/afps-runtime/runner";

const app = getTestApp();

const RUN_SECRET = "a".repeat(43); // matches mintSinkCredentials base64url(32 bytes)

function signedHeaders(body: string) {
  const headers = sign({
    msgId: `msg_${crypto.randomUUID()}`,
    timestampSec: Math.floor(Date.now() / 1000),
    body,
    secret: RUN_SECRET,
  });
  return {
    "Content-Type": "application/json",
    "webhook-id": headers["webhook-id"],
    "webhook-timestamp": headers["webhook-timestamp"],
    "webhook-signature": headers["webhook-signature"],
  };
}

async function seedRunWithSink(ctx: TestContext, packageId: string): Promise<string> {
  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(runs).values({
    id: runId,
    packageId,
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    status: "running",
    runOrigin: "platform",
    sinkSecretEncrypted: encrypt(RUN_SECRET),
    sinkExpiresAt: new Date(Date.now() + 3600_000),
    startedAt: new Date(),
    // Non-zero usage so finalize's zero-token liveness heuristic does not
    // flip a synthesised `success` to `failed` for unrelated reasons.
    tokenUsage: { input_tokens: 100, output_tokens: 50 },
  });
  return runId;
}

/**
 * Emit `output` through the real signed ingestion endpoint — the same path
 * the sidecar's `output` tool takes — so the tests exercise the row shape
 * production actually writes rather than a hand-built one.
 */
async function emitOutput(
  runId: string,
  data: Record<string, unknown> | undefined,
  sequence: number,
): Promise<void> {
  const body = JSON.stringify({
    specversion: "1.0",
    type: "output.emitted",
    source: `/afps/runs/${runId}`,
    id: `msg_${crypto.randomUUID()}`,
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    data: data === undefined ? {} : { data },
    sequence,
  });
  const res = await app.request(`/api/runs/${runId}/events`, {
    method: "POST",
    headers: signedHeaders(body),
    body,
  });
  expect(res.status).toBe(200);
}

async function readRun(runId: string) {
  const [row] = await db
    .select({ status: runs.status, error: runs.error, result: runs.result })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  return row!;
}

describe("platform-synthesised terminals — emitted `output` recovery", () => {
  let ctx: TestContext;
  const agentId = "@recovery/plain-agent";
  const schemaAgentId = "@recovery/schema-agent";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ email: "recovery@test.dev", orgSlug: "recovery-org" });
    await seedPackage({ orgId: ctx.orgId, id: agentId, type: "agent" });
    await seedPackage({
      orgId: ctx.orgId,
      id: schemaAgentId,
      type: "agent",
      draftManifest: {
        name: schemaAgentId,
        version: "0.1.0",
        type: "agent",
        description: "Agent with a declared output schema",
        runtime_tools: ["output"],
        output: {
          schema: {
            type: "object",
            required: ["answer"],
            additionalProperties: false,
            properties: { answer: { type: "string" } },
          },
        },
      },
    });
  });

  it("cancel AFTER an output emission keeps the deliverable on runs.result", async () => {
    const runId = await seedRunWithSink(ctx, agentId);
    await emitOutput(runId, { answer: "42", items: [1, 2, 3] }, 1);

    const res = await app.request(`/api/runs/${runId}/cancel`, {
      method: "POST",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);

    const row = await readRun(runId);
    // Payload recovered — and the terminal state is untouched by it.
    expect((row.result as { output?: unknown } | null)?.output).toEqual({
      answer: "42",
      items: [1, 2, 3],
    });
    expect(row.status).toBe("cancelled");
    expect(row.error).toBe("Cancelled by user");
  });

  it("cancel with NO output emission leaves runs.result null (never fabricate)", async () => {
    const runId = await seedRunWithSink(ctx, agentId);

    const res = await app.request(`/api/runs/${runId}/cancel`, {
      method: "POST",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);

    const row = await readRun(runId);
    expect(row.result).toBeNull();
    expect(row.status).toBe("cancelled");
    expect(row.error).toBe("Cancelled by user");
  });

  it("several emissions — the last row (highest id) wins", async () => {
    // `output` is replace-on-emit, so the newest row is the payload the agent
    // meant to deliver; `run_logs.id` is the append-only ordering key.
    const runId = await seedRunWithSink(ctx, agentId);
    await emitOutput(runId, { attempt: 1 }, 1);
    await emitOutput(runId, { attempt: 2 }, 2);
    await emitOutput(runId, { attempt: 3, final: true }, 3);

    const res = await app.request(`/api/runs/${runId}/cancel`, {
      method: "POST",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);

    const row = await readRun(runId);
    expect((row.result as { output?: unknown } | null)?.output).toEqual({
      attempt: 3,
      final: true,
    });
  });

  it("an output row with a null payload does not become a truthy empty object", async () => {
    // Defensive: the sink writes `data: null` when the event carried none.
    // Recovering that as `{}` would fabricate a deliverable the agent never
    // produced (and, on a success terminal, would read as "output was called").
    const runId = await seedRunWithSink(ctx, agentId);
    await emitOutput(runId, undefined, 1);

    const res = await app.request(`/api/runs/${runId}/cancel`, {
      method: "POST",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);

    expect((await readRun(runId)).result).toBeNull();
  });

  it("synthesised success + declared output schema: an emitted valid payload stays success", async () => {
    // Container exited 0 without posting its own finalize (execute-background
    // synthesises success). Pre-fix this ALWAYS validated `{}` against the
    // schema and flipped the run to failed with the "never called `output`"
    // message, even though the agent had delivered a conforming payload.
    const runId = await seedRunWithSink(ctx, schemaAgentId);
    await emitOutput(runId, { answer: "42" }, 1);

    await synthesiseFinalize(runId, { status: "success", durationMs: 100 });

    const row = await readRun(runId);
    expect(row.status).toBe("success");
    expect(row.error).toBeNull();
    expect((row.result as { output?: unknown } | null)?.output).toEqual({ answer: "42" });
  });

  it("synthesised success + declared output schema: no emission still fails with the tool wording", async () => {
    // Regression guard for the other half of the invariant — nothing is
    // fabricated, so the "agent never called `output`" verdict is unchanged.
    const runId = await seedRunWithSink(ctx, schemaAgentId);

    await synthesiseFinalize(runId, { status: "success", durationMs: 100 });

    const row = await readRun(runId);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/without calling the required `output` tool/);
    expect(row.result).toBeNull();
  });

  it("synthesised success + declared output schema: a non-conforming emission still fails", async () => {
    // Recovery feeds validation the REAL payload, so a schema violation is
    // reported as such (and the payload is flagged, not dropped).
    const runId = await seedRunWithSink(ctx, schemaAgentId);
    await emitOutput(runId, { wrong: 1 }, 1);

    await synthesiseFinalize(runId, { status: "success", durationMs: 100 });

    const row = await readRun(runId);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/Output validation failed/);
    expect((row.result as { output?: unknown } | null)?.output).toEqual({ wrong: 1 });
  });

  it("never overwrites an output the caller already carries", async () => {
    // `applyRecoveredOutput` is exported, so a future caller could hand it a
    // RunResult that already holds a runner-supplied output. That statement is
    // authoritative — recovery fills in what is missing, it never overrules.
    const runId = await seedRunWithSink(ctx, agentId);
    await emitOutput(runId, { fromRunLogs: true }, 1);

    const run = (await getRunSinkContext(runId))!;
    const result = emptyRunResult();
    result.status = "success";
    result.output = { fromRunner: true };

    await applyRecoveredOutput(run, result);

    expect(result.output).toEqual({ fromRunner: true });
  });

  it("a synthesised timeout keeps its status while recovering the payload", async () => {
    // Status is the caller's call; recovery only fills the payload.
    const runId = await seedRunWithSink(ctx, agentId);
    await emitOutput(runId, { partial: true }, 1);

    await synthesiseFinalize(runId, {
      status: "timeout",
      error: { message: "Run timed out after 300s" },
    });

    const row = await readRun(runId);
    expect(row.status).toBe("timeout");
    expect(row.error).toBe("Run timed out after 300s");
    expect((row.result as { output?: unknown } | null)?.output).toEqual({ partial: true });
  });
});
