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
import { invalidRequest, notFound, conflict } from "../lib/errors.ts";
import { rateLimitByRunId, rateLimitRunDocuments } from "../middleware/rate-limit.ts";
import {
  verifyRunSignature,
  verifyRunUploadSignature,
} from "../middleware/verify-run-signature.ts";
import { ingestRunEvent, finalizeRun } from "../services/run-event-ingestion.ts";
import { createDocumentFromStream } from "../services/documents.ts";
import { getRunAttribution } from "../services/state/runs.ts";
import { recordAudit } from "../services/audit.ts";
import { actorFromIds } from "../lib/actor.ts";
import { sanitizeFilename } from "../services/uploads.ts";
import {
  downloadRunWorkspace,
  downloadRunDocumentsManifest,
  downloadRunDocumentStream,
} from "../services/run-workspace-storage.ts";
import { assertUniqueWorkspaceNames } from "../services/run-document-naming.ts";
import { tokenUsageSchema } from "@appstrate/core/token-usage";
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
 *
 * Robustness contract: finalize reports the outcome of an *already-completed*
 * run — the agent loop is over, there is no LLM left to retry. A malformed
 * **cosmetic / side-effect / billing** field (a log line missing its
 * timestamp, a degenerate `usage` object, …) must therefore NEVER fail an
 * otherwise-successful run. Those fields use `.catch(...)` so a present-but-
 * invalid value degrades gracefully (defaulted or dropped) instead of
 * rejecting the whole payload with a 400 that the runner can't recover from.
 * Only the load-bearing outcome fields (`status`, `output`, `error`) stay
 * strict — a genuinely broken outcome should still surface loudly.
 */
const RunResultSchema = z
  .object({
    memories: z
      .array(
        z.object({
          content: z.string().catch(""),
          scope: z.enum(["actor", "shared"]).optional().catch(undefined),
        }),
      )
      .optional()
      .default([]),
    pinned: z
      .record(
        z.string(),
        z.object({
          content: z.unknown(),
          scope: z.enum(["actor", "shared"]).optional().catch(undefined),
        }),
      )
      .optional(),
    output: z.unknown().nullable().optional(),
    logs: z
      .array(
        z.object({
          // Cosmetic display fields — degrade rather than reject. A missing
          // `timestamp` (built-in `log` tool over the sidecar/MCP path used to
          // omit it) defaults to ingestion time instead of failing finalize.
          level: z.enum(["info", "warn", "error"]).catch("info"),
          message: z.string().catch(""),
          timestamp: z.number().catch(() => Date.now()),
        }),
      )
      .optional()
      .default([]),
    error: z
      .object({
        message: z.string(),
        stack: z.string().optional(),
        // Stable, machine-readable failure code (e.g. `"timeout"`,
        // `"manifest_invalid"`). Bounded length; clamped to a small allowlist
        // before it becomes the `appstrate.run.terminal` `error_code` label, so
        // a runner-controlled string can never explode metric cardinality.
        code: z.string().max(64).optional(),
      })
      .optional(),
    status: z.enum(["success", "failed", "timeout", "cancelled"]).optional(),
    durationMs: z.number().int().nonnegative().optional().catch(undefined),
    // Authoritative token usage for finalize liveness and the terminal
    // `runs.tokenUsage` write. Missing/malformed usage is tolerated by the
    // service boundary as explicit zero usage; metric events are not a finalize
    // fallback.
    usage: tokenUsageSchema.optional().catch(undefined),
    // Authoritative LLM cost in USD for the runner-source contribution.
    // When present, finalize synthesises a runner-source `llm_usage`
    // ledger row from this value if no metric event has landed yet, so
    // `runs.cost` is correct even when `process.exit()` aborts the
    // metric POST. Degrades to undefined on a bad value.
    cost: z.number().nonnegative().optional().catch(undefined),
    // Deprecated report-channel aggregate. Kept tolerant so older runners can
    // finalize successfully while new agents publish markdown documents.
    report: z.string().optional().catch(undefined),
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
  // Uploads get their own per-run budget (30 in any 6s window ≈ 5/s sustained,
  // burst 30) so the finalize `outputs/` sweep's many small POSTs never exhaust
  // — or get starved by — the high-rate event-ingestion budget above.
  const documentLimiter = rateLimitRunDocuments(30, 6);

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
      logs: d.logs,
      ...(d.error ? { error: d.error } : {}),
      ...(d.status ? { status: d.status } : {}),
      ...(d.durationMs !== undefined ? { durationMs: d.durationMs } : {}),
      ...(d.usage !== undefined ? { usage: d.usage } : {}),
      ...(d.cost !== undefined ? { cost: d.cost } : {}),
      ...(d.report !== undefined ? { report: d.report } : {}),
    };

    await finalizeRun({ run, result });

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

  // The three routes below let the agent self-provision its workspace at
  // startup. This replaces the old seed-via-helper-volume delivery, whose
  // correctness depended on the run volume's driver — a tmpfs-backed `local`
  // volume is not shared between the seed helper and the agent container, so
  // the bundle silently vanished and skills never materialised (issue #549).
  // All three carry the same HMAC auth as the event routes: the runner proves
  // it is the run via a signature over the (empty) GET body, so no user
  // principal is involved.

  // GET /api/runs/:runId/workspace — the AFPS bundle (`agent-package.afps`,
  // manifest + prompt + skills; itself a ZIP). Small and constant, served
  // verbatim; the agent writes it straight to its workspace root. A 404 means
  // no bundle was provisioned, which the runtime treats as a fatal
  // provisioning fault (never a legitimately-empty workspace — the platform
  // always uploads the agent package).
  router.get("/runs/:runId/workspace", eventLimiter, verifyRunSignature, async (c) => {
    const run = c.get("run")!;
    const archive = await downloadRunWorkspace(run.id);
    if (!archive) throw notFound(`no workspace provisioned for run ${run.id}`);
    // Hono's body() takes an ArrayBuffer; hand it a tightly-bounded view of
    // the Buffer's backing store (a Buffer may be a slice of a larger pool).
    const bytes = archive.buffer.slice(
      archive.byteOffset,
      archive.byteOffset + archive.byteLength,
    ) as ArrayBuffer;
    c.header("Content-Type", "application/zip");
    c.header("Content-Length", String(archive.length));
    return c.body(bytes);
  });

  // GET /api/runs/:runId/documents — the input-document manifest. The agent
  // enumerates this, then fetches each document by name. A 404 means the run
  // carries no input documents (the common case), which the runtime treats as
  // an empty document set — not a fault.
  router.get("/runs/:runId/documents", eventLimiter, verifyRunSignature, async (c) => {
    const run = c.get("run")!;
    const manifest = await downloadRunDocumentsManifest(run.id);
    if (!manifest) throw notFound(`no input documents for run ${run.id}`);
    // Never serve a manifest whose workspace names collide — the container keys
    // its `workspace/documents/` writes on `workspace_name`, so a duplicate
    // would silently overwrite one document with another. The platform build
    // path can't produce one (assignWorkspaceNames dedupes); this guards a
    // corrupted / hand-built manifest with a typed 400 instead.
    // (Pre-upgrade manifests key on `name` only — fall back rather than 400
    // a run that was launched before workspace names existed.)
    assertUniqueWorkspaceNames(manifest.documents.map((d) => d.workspace_name ?? d.name));
    return c.json(manifest);
  });

  // POST /api/runs/:runId/documents — agent-published run output (Phase 2).
  //
  // The agent container streams a file it produced (an HTML report, a CSV, …)
  // here, either via the `publish_document` runtime tool or the entrypoint's
  // end-of-run `outputs/` sweep. Authenticated by the SAME run HMAC as the GET
  // provisioning routes (verified over an empty body so the up-to-100 MiB
  // payload streams straight to storage without being buffered for the hash).
  //
  // The bytes stream through a counting/hashing/cap transform into the durable
  // `documents` bucket: the per-file cap and per-run output budget cut the
  // stream mid-flight (413, deleting any partial object), the org quota is
  // enforced transactionally (403). Idempotent for the sweep's retries: an
  // identical (run, sha256, name) upload returns the existing document (200).
  router.post("/runs/:runId/documents", documentLimiter, verifyRunUploadSignature, async (c) => {
    const run = c.get("run")!;

    // Only a live run may publish — a document arriving after finalize (or
    // before the run started) has no valid container state to attach to.
    const [runRow] = await db
      .select({ status: runs.status, packageId: runs.packageId })
      .from(runs)
      .where(eq(runs.id, run.id))
      .limit(1);
    if (!runRow) throw notFound(`run ${run.id} not found`);
    if (runRow.status !== "running") {
      throw conflict("run_not_running", `run ${run.id} is not running (status: ${runRow.status})`);
    }

    const rawName = c.req.header("X-Document-Name");
    if (!rawName) throw invalidRequest("X-Document-Name header is required", "X-Document-Name");
    const name = sanitizeFilename(rawName);

    const mime = c.req.header("Content-Type");
    if (!mime) throw invalidRequest("Content-Type header is required", "Content-Type");

    const body = c.req.raw.body;
    if (!body) throw invalidRequest("request body is required");

    // Attribution is copied from the run row (never trusted from the agent):
    // the run's creator + end-user, and the run's producing package.
    const attribution = await getRunAttribution(run.orgId, run.id);
    const { row, deduped } = await createDocumentFromStream(
      { orgId: run.orgId, applicationId: run.applicationId },
      run.id,
      { userId: attribution?.userId ?? null, endUserId: attribution?.endUserId ?? null },
      runRow.packageId,
      { name, mime, body },
    );

    // Audit only a genuinely NEW publish (201), never a dedup replay (200).
    // No request context here (HMAC-run-authenticated, no user session), so
    // this is the direct-service `recordAudit`, attributed to the run's actor.
    if (!deduped) {
      const actor = actorFromIds(attribution?.userId ?? null, attribution?.endUserId ?? null);
      await recordAudit({
        orgId: run.orgId,
        applicationId: run.applicationId,
        actorType: actor ? actor.type : "system",
        actorId: actor?.id ?? null,
        action: "document.published",
        resourceType: "document",
        resourceId: row.id,
        after: { name: row.name, size: row.size, mime: row.mime, runId: run.id },
      });
    }

    return c.json(
      {
        id: row.id,
        uri: `document://${row.id}`,
        name: row.name,
        mime: row.mime,
        size: row.size,
        sha256: row.sha256,
      },
      deduped ? 200 : 201,
    );
  });

  // GET /api/runs/:runId/documents/:name — a single input document, streamed
  // straight from storage so neither the platform nor the agent buffers the
  // whole payload. The agent streams the response body to `documents/<name>`.
  // A 404 on a document the manifest listed is a fatal provisioning fault.
  router.get("/runs/:runId/documents/:name", eventLimiter, verifyRunSignature, async (c) => {
    const run = c.get("run")!;
    const name = c.req.param("name");
    const stream = await downloadRunDocumentStream(run.id, name);
    if (!stream) throw notFound(`document ${name} not found for run ${run.id}`);
    c.header("Content-Type", "application/octet-stream");
    return c.body(stream);
  });

  return router;
}
