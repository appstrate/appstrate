// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /api/runs/remote` — create a run that will be executed on the
 * caller's host (CLI, GitHub Action, self-hosted runner). Returns sink
 * credentials the caller plugs into `HttpSink` to post signed telemetry
 * events back.
 *
 * `PATCH /api/runs/:runId/sink/extend` — extend `sink_expires_at` for a
 * long-running remote run.
 *
 * Both routes authenticate via JWT bearer (interactive CLI) or API key
 * with the `agents:run` scope (headless — GitHub Action, CI). HMAC-signed
 * event ingestion lives in a separate router (`runs-events.ts`) because
 * its auth model is fundamentally different.
 *
 * Spec: docs/specs/REMOTE_CLI_UNIFIED_RUNNER_PLAN.md §6.5.1.
 */

import { Hono } from "hono";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { getEnv } from "@appstrate/env";
import { logger } from "../lib/logger.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { idempotency } from "../middleware/idempotency.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { invalidRequest, notFound, ApiError } from "../lib/errors.ts";
import { getActor } from "../lib/actor.ts";
import { getPlatformRunLimits } from "../services/run-limits.ts";
import { runInlinePreflight } from "../services/inline-run-preflight.ts";
import { insertShadowPackage, buildShadowLoadedPackage } from "../services/inline-run.ts";
import { createRun } from "../services/run-creation.ts";
import { resolveRemoteAgentIdentity } from "../services/remote-run-identity.ts";
import { getPackage } from "../services/agent-service.ts";
import type { LoadedPackage } from "../types/index.ts";
import type { AppEnv } from "../types/index.ts";

// ---------------------------------------------------------------------------
// Body schema
// ---------------------------------------------------------------------------

/**
 * Maximum size of the `contextSnapshot` payload, in serialised bytes.
 * The server stores it verbatim — capping prevents a misbehaving or
 * malicious runner from injecting arbitrary blobs.
 */
const CONTEXT_SNAPSHOT_MAX_BYTES = 16 * 1024;

const CreateRemoteRunBodySchema = z
  .object({
    // v1 supports the inline source only — ad-hoc manifest + prompt shipped
    // in the request body. Registry-lookup (`{ kind: "registry", packageId,
    // version }`) is reserved for a follow-up; leaving the discriminated
    // union in place keeps the wire contract forward-compatible.
    source: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("inline"),
        manifest: z.record(z.string(), z.unknown()),
        prompt: z.string().min(1),
        providerProfiles: z.record(z.string(), z.string()).optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        modelId: z.string().nullable().optional(),
        proxyId: z.string().nullable().optional(),
      }),
    ]),
    applicationId: z.string().min(1),
    input: z.record(z.string(), z.unknown()).optional().default({}),
    contextSnapshot: z
      .record(z.string(), z.unknown())
      .optional()
      .refine(
        (snap) => !snap || JSON.stringify(snap).length <= CONTEXT_SNAPSHOT_MAX_BYTES,
        `contextSnapshot exceeds ${CONTEXT_SNAPSHOT_MAX_BYTES} bytes`,
      ),
    sink: z
      .object({
        ttlSeconds: z.number().int().positive().max(86400).optional(),
      })
      .optional(),
  })
  .strict();

const ExtendSinkBodySchema = z
  .object({
    ttlSeconds: z.number().int().positive().max(86400),
  })
  .strict();

export function createRunsRemoteRouter() {
  const router = new Hono<AppEnv>();

  router.post(
    "/runs/remote",
    rateLimit(getPlatformRunLimits().per_org_global_rate_per_min),
    idempotency(),
    requirePermission("agents", "run"),
    async (c) => {
      const parsed = CreateRemoteRunBodySchema.safeParse(await c.req.json());
      if (!parsed.success) {
        throw invalidRequest(parsed.error.issues[0]?.message ?? "Invalid request body");
      }
      const body = parsed.data;

      const orgId = c.get("orgId");
      const actor = getActor(c);
      // The caller binds the run to one of their applications — the header-
      // derived `c.get("applicationId")` cannot be trusted for a public
      // write surface, so the body value takes precedence and is re-checked
      // downstream against app membership by the ownership guard.
      const applicationId = body.applicationId;

      // Only the inline source is supported in v1 (enforced by the Zod
      // discriminated union above).
      const src = body.source;

      const preflight = await runInlinePreflight({
        orgId,
        applicationId,
        actor,
        body: {
          manifest: src.manifest,
          prompt: src.prompt,
          input: body.input,
          config: src.config,
          providerProfiles: src.providerProfiles,
          modelId: src.modelId,
          proxyId: src.proxyId,
        },
      });

      // Attempt to resolve the posted bundle against the org's package
      // registry. Matches land the run on the real `@scope/name@version`
      // (no shadow, no "Inline" UI badge, version label populated); any
      // mismatch — manifest divergence, unpublished version, cross-org —
      // falls back cleanly to the shadow path below.
      const resolved = await resolveRemoteAgentIdentity({
        orgId,
        manifest: preflight.manifest,
        prompt: preflight.prompt,
      });

      let agentForRun: LoadedPackage;
      let overrideVersionLabel: string | undefined;

      if (resolved) {
        const real = await getPackage(resolved.packageId, orgId);
        if (real) {
          agentForRun = real;
          overrideVersionLabel = resolved.versionLabel;
        } else {
          agentForRun = await createShadowAgent();
        }
      } else {
        agentForRun = await createShadowAgent();
      }

      async function createShadowAgent(): Promise<LoadedPackage> {
        const createdBy = actor?.type === "member" ? actor.id : null;
        const shadowId = await insertShadowPackage({
          orgId,
          createdBy,
          manifest: preflight.manifest,
          prompt: preflight.prompt,
        });
        return buildShadowLoadedPackage(
          shadowId,
          preflight.manifest,
          preflight.prompt,
          preflight.resolvedDeps,
        );
      }

      const runId = `run_${crypto.randomUUID()}`;
      const result = await createRun({
        origin: "remote",
        runId,
        orgId,
        applicationId,
        actor,
        agent: agentForRun,
        ...(overrideVersionLabel ? { overrideVersionLabel } : {}),
        providerProfiles: preflight.providerProfiles,
        input: preflight.effectiveInput,
        config: preflight.effectiveConfig,
        modelId: preflight.modelIdOverride,
        proxyId: preflight.proxyIdOverride,
        apiKeyId: c.get("apiKeyId") ?? undefined,
        sink: body.sink,
        contextSnapshot: body.contextSnapshot,
      });

      if (!result.ok) {
        // createRun's error shape carries { code, message, status? }.
        throw new ApiError({
          status: result.error.status ?? 500,
          code: result.error.code,
          title: result.error.code.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()),
          detail: result.error.message,
        });
      }
      if (!result.sinkCredentials) {
        // Remote origin always returns credentials; the absence is a service bug.
        logger.error("createRun remote returned no sinkCredentials", { runId });
        throw new ApiError({
          status: 500,
          code: "sink_credentials_missing",
          title: "Internal Error",
          detail: "Remote run created without sink credentials — please retry",
        });
      }

      c.status(201);
      return c.json({
        runId: result.runId,
        ...result.sinkCredentials,
      });
    },
  );

  // PATCH /api/runs/:runId/sink/extend — push out sink_expires_at for a
  // long-running remote run. Same auth as creation: agents:run. Runs are
  // app-scoped but this route resolves the run by id (not app path) so the
  // handler checks ownership explicitly.
  router.patch(
    "/runs/:runId/sink/extend",
    rateLimit(30),
    requirePermission("agents", "run"),
    async (c) => {
      const runId = c.req.param("runId");
      if (!runId) throw invalidRequest("runId path parameter is required", "runId");

      const parsed = ExtendSinkBodySchema.safeParse(await c.req.json());
      if (!parsed.success) {
        throw invalidRequest(parsed.error.issues[0]?.message ?? "Invalid request body");
      }

      const env = getEnv();
      const ttl = Math.min(parsed.data.ttlSeconds, env.REMOTE_RUN_SINK_MAX_TTL_SECONDS);
      const newExpiresAt = new Date(Date.now() + ttl * 1000);

      // Update only open sinks (not closed, not already expired) owned by
      // the caller's org. Mismatched ownership or closed sink → 404, which
      // avoids leaking whether a run exists across tenancies.
      const orgId = c.get("orgId");
      // Bumping `last_heartbeat_at` alongside `sink_expires_at` turns
      // /sink/extend into the canonical keep-alive: runners that are
      // alive but idle (waiting on a long LLM call, sleeping between
      // polls) prove liveness here without needing to fabricate a
      // low-signal event. The watchdog reads `last_heartbeat_at`
      // exclusively, so extend must touch it.
      const updated = await db
        .update(runs)
        .set({ sinkExpiresAt: newExpiresAt, lastHeartbeatAt: new Date() })
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.orgId, orgId),
            sql`sink_closed_at IS NULL`,
            sql`sink_expires_at IS NOT NULL`,
          ),
        )
        .returning({ id: runs.id });

      if (updated.length === 0) {
        throw notFound(`run ${runId} not found or sink already closed`);
      }

      return c.json({ runId, expiresAt: newExpiresAt.toISOString() });
    },
  );

  return router;
}
