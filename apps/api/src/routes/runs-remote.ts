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
import { resolveRunnerContext } from "../lib/runner-context.ts";
import { resolveRegistryAgent } from "../services/registry-run-resolver.ts";
import { validateConfig, validateInput } from "../services/schema.ts";
import { validateAgentReadiness } from "../services/agent-readiness.ts";
import {
  resolveActorProfileContext,
  resolveProviderProfiles,
} from "../services/connection-profiles.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";
import type { LoadedPackage, ProviderProfileMap } from "../types/index.ts";
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
    // Two source shapes:
    //   - `inline`   — ad-hoc manifest + prompt shipped in the request
    //                  body. Used by GitHub Action and any runner that
    //                  builds the agent dynamically. Always lands on a
    //                  shadow ephemeral package ("Inline" badge in UI).
    //   - `registry` — the runner declares which package it's running
    //                  by id; the server reads the manifest from its own
    //                  catalog. Deterministic attribution, no fingerprint
    //                  reconciliation, no spoof surface.
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
      z.object({
        kind: z.literal("registry"),
        packageId: z.string().min(1),
        // `stage` discriminates draft vs published — kept distinct from
        // the parent `source` discriminator (which selects inline vs
        // registry) to avoid the `source.source` collision.
        stage: z.enum(["draft", "published"]).default("published"),
        spec: z.string().optional(),
        /**
         * SRI digest the runner received with the bundle download
         * (`X-Bundle-Integrity`). Optional: when present, the server
         * logs a warning if the version it just resolved produces a
         * different artifact (drift between bundle download and run
         * creation). The bundle is already on the runner's host, so
         * we don't reject — refusing the run wastes the runner's work
         * for no security gain (no untrusted bytes are loaded server-side).
         */
        integrity: z.string().optional(),
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

      const src = body.source;

      let agentForRun: LoadedPackage;
      let overrideVersionLabel: string | undefined;
      let providerProfiles: ProviderProfileMap;
      let effectiveInput: Record<string, unknown> | null;
      let effectiveConfig: Record<string, unknown>;
      let modelIdOverride: string | null;
      let proxyIdOverride: string | null;
      // Attribution path counter — emitted once per request so we can
      // track the inline-vs-registry split over time.
      let attributionPath: "registry" | "inline_shadow";

      if (src.kind === "registry") {
        // Server-resolved attribution. The runner names the package; we
        // load manifest+prompt from our own catalog. No fingerprint
        // reconciliation, no shadow row, no "Inline" badge.
        const resolved = await resolveRegistryAgent({
          orgId,
          applicationId,
          packageId: src.packageId,
          stage: src.stage,
          spec: src.spec,
          ...(src.integrity ? { integrityHint: src.integrity } : {}),
        });
        agentForRun = resolved.agent;
        overrideVersionLabel = resolved.versionLabel;
        attributionPath = "registry";

        // Body-supplied providerProfiles already validated as
        // Record<string,string> by the discriminated-union schema above.
        const providerProfilesOverride = src.providerProfiles;
        modelIdOverride = src.modelId ?? null;
        proxyIdOverride = src.proxyId ?? null;

        effectiveConfig =
          src.config && typeof src.config === "object" && !Array.isArray(src.config)
            ? (src.config as Record<string, unknown>)
            : {};
        effectiveInput =
          body.input && typeof body.input === "object" && !Array.isArray(body.input)
            ? (body.input as Record<string, unknown>)
            : null;

        // Validate config + input against the resolved manifest's schemas.
        // The manifest is server-authored (came from our own catalog), so
        // structural validation is unnecessary — only AJV schema checks.
        const configSchema = agentForRun.manifest.config?.schema;
        if (configSchema) {
          const cv = validateConfig(effectiveConfig, asJSONSchemaObject(configSchema));
          if (!cv.valid) {
            const first = cv.errors[0]!;
            throw new ApiError({
              status: 400,
              code: "invalid_config",
              title: "Invalid Config",
              detail: first.field ? `${first.field}: ${first.message}` : first.message,
            });
          }
        }
        const inputSchema = agentForRun.manifest.input?.schema;
        if (inputSchema) {
          const iv = validateInput(effectiveInput ?? undefined, asJSONSchemaObject(inputSchema));
          if (!iv.valid) {
            const first = iv.errors[0]!;
            throw new ApiError({
              status: 400,
              code: "invalid_input",
              title: "Invalid Input",
              detail: first.field ? `${first.field}: ${first.message}` : first.message,
            });
          }
        }

        // Provider profile resolution — same cascade as the inline path.
        const { defaultUserProfileId } = await resolveActorProfileContext(
          actor,
          agentForRun.id,
          null,
          applicationId,
        );
        providerProfiles = await resolveProviderProfiles(
          resolveManifestProviders(agentForRun.manifest),
          defaultUserProfileId,
          providerProfilesOverride,
          null,
          applicationId,
        );

        // Readiness gate — same checks the inline preflight ends with.
        await validateAgentReadiness({
          agent: agentForRun,
          providerProfiles,
          orgId,
          config: effectiveConfig,
          applicationId,
        });
      } else {
        // Inline path — the runner ships a manifest+prompt blob. Validate
        // structurally, then create a shadow LoadedPackage. All inline
        // runs land on a shadow ephemeral package ("Inline" badge in UI);
        // callers who want deterministic attribution use kind=registry.
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

        agentForRun = await createShadowAgent(preflight);
        attributionPath = "inline_shadow";

        providerProfiles = preflight.providerProfiles;
        effectiveInput = preflight.effectiveInput;
        effectiveConfig = preflight.effectiveConfig;
        modelIdOverride = preflight.modelIdOverride;
        proxyIdOverride = preflight.proxyIdOverride;
      }

      async function createShadowAgent(
        preflight: Awaited<ReturnType<typeof runInlinePreflight>>,
      ): Promise<LoadedPackage> {
        const createdBy = actor?.type === "user" ? actor.id : null;
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
      const runner = await resolveRunnerContext(c);
      const result = await createRun({
        origin: "remote",
        runId,
        orgId,
        applicationId,
        actor,
        agent: agentForRun,
        ...(overrideVersionLabel ? { overrideVersionLabel } : {}),
        providerProfiles,
        input: effectiveInput,
        config: effectiveConfig,
        modelId: modelIdOverride,
        proxyId: proxyIdOverride,
        apiKeyId: c.get("apiKeyId") ?? undefined,
        sink: body.sink,
        contextSnapshot: body.contextSnapshot,
        runnerName: runner.name,
        runnerKind: runner.kind,
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

      logger.info("runs.remote.attribution", {
        runId: result.runId,
        orgId,
        applicationId,
        path: attributionPath,
        packageId: agentForRun.id,
        versionLabel: overrideVersionLabel ?? null,
      });

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
