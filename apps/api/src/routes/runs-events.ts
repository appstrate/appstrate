// SPDX-License-Identifier: Apache-2.0

/**
 * HMAC-signed event ingestion routes. Both platform containers (Phase 5)
 * and remote CLIs post here — the auth model, the wire format, and the
 * handler logic are identical.
 *
 *   POST /api/runs/:runId/events           — one signed CloudEvent
 *   POST /api/runs/:runId/events/finalize  — terminal RunResult, idempotent
 *
 * Authentication is Standard Webhooks HMAC (via `verifyRunSignature`). No
 * user principal — the request's legitimacy is proven cryptographically.
 * The middleware populates `c.get("run")` with the sink context; handlers
 * consume that and never dereference `c.get("user")` (there isn't one).
 *
 * Spec: docs/specs/REMOTE_CLI_UNIFIED_RUNNER_PLAN.md §6.5.2.
 */

import { Hono } from "hono";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { invalidRequest } from "../lib/errors.ts";
import { rateLimitByRunId } from "../middleware/rate-limit.ts";
import { verifyRunSignature } from "../middleware/verify-run-signature.ts";
import { ingestRunEvent, finalizeRun } from "../services/run-event-ingestion.ts";
import { tokenUsageSchema } from "../services/adapters/types.ts";
import type { RunResult } from "@appstrate/afps-runtime/runner";
import { getEnv } from "@appstrate/env";
import type { AppEnv } from "../types/index.ts";

// ---------------------------------------------------------------------------
// Body schemas
// ---------------------------------------------------------------------------

/**
 * CloudEvents 1.0 envelope, narrowed to the fields we actually inspect.
 * `data` carries the RunEvent-specific payload; we validate lightly here
 * and let the handler narrow further before dispatch.
 */
const CloudEventEnvelopeSchema = z
  .object({
    specversion: z.literal("1.0"),
    type: z.string().min(1),
    source: z.string().min(1),
    id: z.string().min(1),
    time: z.iso.datetime(),
    datacontenttype: z.literal("application/json"),
    data: z.record(z.string(), z.unknown()),
    sequence: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Terminal RunResult — the payload HttpSink sends to /finalize. Kept loose
 * (most fields optional) to match the runtime's own RunResult shape without
 * re-declaring its internals here.
 */
const RunResultSchema = z
  .object({
    memories: z
      .array(z.object({ content: z.string(), scope: z.enum(["actor", "shared"]).optional() }))
      .optional()
      .default([]),
    pinned: z
      .record(
        z.string(),
        z.object({
          content: z.unknown(),
          scope: z.enum(["actor", "shared"]).optional(),
        }),
      )
      .optional(),
    output: z.unknown().nullable().optional(),
    report: z.string().nullable().optional(),
    logs: z
      .array(
        z.object({
          level: z.enum(["info", "warn", "error"]),
          message: z.string(),
          timestamp: z.number(),
        }),
      )
      .optional()
      .default([]),
    error: z
      .object({
        message: z.string(),
        stack: z.string().optional(),
      })
      .optional(),
    status: z.enum(["success", "failed", "timeout", "cancelled"]).optional(),
    durationMs: z.number().int().nonnegative().optional(),
    // Authoritative token usage. When present, finalize uses this as the
    // source of truth for both the zero-tokens heuristic and the
    // `runs.tokenUsage` column write — independent of whether the
    // `appstrate.metric` event POST has landed yet.
    usage: tokenUsageSchema.optional(),
    // Authoritative LLM cost in USD for the runner-source contribution.
    // When present, finalize synthesises a runner-source `llm_usage`
    // ledger row from this value if no metric event has landed yet, so
    // `runs.cost` is correct even when `process.exit()` aborts the
    // metric POST.
    cost: z.number().nonnegative().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Per-run event-route limits. Parsed from `REMOTE_RUN_EVENT_LIMITS`
 * (JSON string env var) with sensible defaults. Read at router-build
 * time — changes require a restart.
 */
function getRemoteRunEventLimits(): { rate_per_sec: number; burst: number } {
  const raw = getEnv().REMOTE_RUN_EVENT_LIMITS;
  const parsed = raw as { rate_per_sec?: unknown; burst?: unknown };
  const rate =
    typeof parsed.rate_per_sec === "number" && parsed.rate_per_sec > 0 ? parsed.rate_per_sec : 50;
  const burst = typeof parsed.burst === "number" && parsed.burst > 0 ? parsed.burst : 200;
  return { rate_per_sec: rate, burst };
}

export function createRunsEventsRouter() {
  const router = new Hono<AppEnv>();
  const limits = getRemoteRunEventLimits();
  // rate-limiter-flexible uses points-per-window; `burst` tokens per
  // 1-second window approximates a leaky bucket with `rate_per_sec` sustained.
  // Keep the limiter call site consistent with the existing ratelimit
  // factory (points, windowSec) — seconds window with the burst cap gives
  // per-second bucket semantics, simple and predictable.
  const eventLimiter = rateLimitByRunId(limits.burst, 1);

  router.post("/runs/:runId/events", eventLimiter, verifyRunSignature, async (c) => {
    // verifyRunSignature populated these. The runtime assertion is a
    // belt-and-suspenders against refactoring mistakes (types say
    // optional because AppEnv.Variables is a union with auth-less HMAC
    // paths; verifyRunSignature always sets them).
    const run = c.get("run")!;
    const webhookId = c.get("webhookId")!;

    const parsed = CloudEventEnvelopeSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      throw invalidRequest(parsed.error.issues[0]?.message ?? "Invalid CloudEvent envelope");
    }

    const outcome = await ingestRunEvent({
      run,
      envelope: parsed.data,
      webhookId,
    });

    return c.json({
      ok: true,
      outcome: outcome.status,
      ...(outcome.status !== "replay" ? { sequence: outcome.sequence } : {}),
    });
  });

  router.post("/runs/:runId/events/finalize", eventLimiter, verifyRunSignature, async (c) => {
    const run = c.get("run")!;
    const webhookId = c.get("webhookId")!;

    const parsed = RunResultSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      throw invalidRequest(parsed.error.issues[0]?.message ?? "Invalid RunResult");
    }

    // Zod's `unknown()` fields parse to `unknown` (not `unknown | null`);
    // we project explicitly to the runtime's RunResult shape so the
    // service's type checks are enforced without a cast.
    const d = parsed.data;
    const result: RunResult = {
      memories: d.memories,
      ...(d.pinned !== undefined ? { pinned: d.pinned } : {}),
      output: d.output ?? null,
      report: d.report ?? null,
      logs: d.logs,
      ...(d.error ? { error: d.error } : {}),
      ...(d.status ? { status: d.status } : {}),
      ...(d.durationMs !== undefined ? { durationMs: d.durationMs } : {}),
      ...(d.usage !== undefined ? { usage: d.usage } : {}),
      ...(d.cost !== undefined ? { cost: d.cost } : {}),
    };

    await finalizeRun({ run, result, webhookId });

    return c.json({ ok: true });
  });

  // POST /api/runs/:runId/events/heartbeat — runner-driven keep-alive.
  //
  // Same HMAC auth as event ingestion, so both platform containers
  // (runSecret only, no user principal) and remote CLIs can call it
  // through the same helper. Intentionally distinct from
  // `PATCH /sink/extend` which uses API-key auth for the human/CLI-user
  // owner-side lifecycle control: here the runner itself proves it is
  // alive without touching the event stream.
  //
  // Side effect: bumps `last_heartbeat_at = now()` atomically on an
  // open-sink row. No sequence advance, no log row, no ordering
  // semantics. The watchdog reads `last_heartbeat_at` exclusively,
  // so this endpoint is the minimum-viable liveness beacon.
  router.post("/runs/:runId/events/heartbeat", eventLimiter, verifyRunSignature, async (c) => {
    const run = c.get("run")!;
    // Short-circuit if the sink is already closing — the runner's next
    // event will observe 410 anyway, no need to race.
    await db
      .update(runs)
      .set({ lastHeartbeatAt: new Date() })
      .where(and(eq(runs.id, run.id), sql`sink_closed_at IS NULL`));
    return c.json({ ok: true });
  });

  return router;
}
