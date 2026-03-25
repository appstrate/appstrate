import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { executions, shareLinkUsages } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { getShareLink, useShareLink } from "../services/share-links.ts";
import { getPackage } from "../services/flow-service.ts";
import {
  createExecution,
  getFlowProviderBindings,
  listExecutionLogs,
} from "../services/state/index.ts";
import { resolveProviderStatuses } from "../services/connection-manager/index.ts";
import { parseRequestInput } from "../services/input-parser.ts";
import {
  buildExecutionContext,
  resolvePreflightContext,
  ModelNotConfiguredError,
} from "../services/env-builder.ts";
import type { PromptContext } from "../services/adapters/types.ts";
import { executeFlowInBackground } from "./executions.ts";
import { rateLimitByIp } from "../middleware/rate-limit.ts";
import { ApiError, notFound, gone } from "../lib/errors.ts";
import { getEffectiveProfileId } from "../services/connection-profiles.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import type { Actor } from "../lib/actor.ts";
import { getEndUserApplicationId } from "../services/end-users.ts";

export function createShareRouter() {
  const router = new Hono();

  // GET /share/:token/flow — public flow metadata (no JWT)
  router.get("/:token/flow", rateLimitByIp(60), async (c) => {
    const token = c.req.param("token")!;
    const shareLink = await getShareLink(token);

    if (!shareLink || !shareLink.isActive || shareLink.expiresAt < new Date()) {
      throw gone("token_invalid", "This link is no longer valid.");
    }

    const orgId = shareLink.orgId;
    const flow = await getPackage(shareLink.packageId, orgId);
    if (!flow) {
      throw notFound("Flow not found.");
    }

    // Use the snapshotted manifest if available, otherwise fall back to current draft
    const manifest = shareLink.manifest
      ? (shareLink.manifest as typeof flow.manifest)
      : flow.manifest;

    // Resolve provider statuses
    const bindings = await getFlowProviderBindings(orgId, flow.id);
    const providerStatuses = await resolveProviderStatuses(
      resolveManifestProviders(manifest),
      bindings,
      orgId,
      undefined,
    );

    // Check if link is exhausted (maxUses reached)
    const exhausted = shareLink.maxUses !== null && shareLink.usageCount >= shareLink.maxUses;

    const result: Record<string, unknown> = {
      displayName: manifest.displayName,
      description: manifest.description,
      ...(manifest.input ? { input: { schema: manifest.input.schema } } : {}),
      ...(manifest.output ? { output: { schema: manifest.output.schema } } : {}),
      ...(providerStatuses.length > 0 ? { providers: providerStatuses } : {}),
      usageCount: shareLink.usageCount,
      maxUses: shareLink.maxUses,
      exhausted,
    };

    // If there have been usages, return the most recent execution
    if (shareLink.usageCount > 0) {
      const [latestUsage] = await db
        .select({ executionId: shareLinkUsages.executionId })
        .from(shareLinkUsages)
        .where(eq(shareLinkUsages.shareLinkId, shareLink.id))
        .orderBy(desc(shareLinkUsages.usedAt))
        .limit(1);

      if (latestUsage?.executionId) {
        const [execRow] = await db
          .select({
            id: executions.id,
            status: executions.status,
            result: executions.result,
            error: executions.error,
          })
          .from(executions)
          .where(eq(executions.id, latestUsage.executionId))
          .limit(1);

        if (execRow) {
          const allLogs = await listExecutionLogs(execRow.id, shareLink.orgId);
          result.execution = {
            id: execRow.id,
            status: execRow.status,
            ...(execRow.result ? { result: execRow.result } : {}),
            ...(execRow.error ? { error: execRow.error } : {}),
            logs: allLogs,
          };
        }
      }
    }

    return c.json(result);
  });

  // POST /share/:token/run — validate, then use link and execute (no JWT)
  router.post("/:token/run", rateLimitByIp(5), async (c) => {
    const token = c.req.param("token")!;

    // Verify link is valid (without using it yet)
    const shareLink = await getShareLink(token);
    if (!shareLink || !shareLink.isActive || shareLink.expiresAt < new Date()) {
      throw gone("token_invalid", "This link has already been used or is no longer valid.");
    }

    // Check if link is exhausted
    if (shareLink.maxUses !== null && shareLink.usageCount >= shareLink.maxUses) {
      throw gone("token_invalid", "This link has reached its maximum number of uses.");
    }

    const { id: linkId, packageId, orgId } = shareLink;
    const actor: Actor = shareLink.endUserId
      ? { type: "end_user", id: shareLink.endUserId }
      : { type: "member", id: shareLink.createdBy! };
    const snapshotManifest = shareLink.manifest as Record<string, unknown> | null;

    // Resolve application context for webhook dispatch
    const applicationId =
      actor.type === "end_user" ? await getEndUserApplicationId(actor.id) : null;

    const flow = await getPackage(packageId, orgId);
    if (!flow) {
      throw notFound("Flow not found.");
    }

    // Use the snapshotted manifest if available, otherwise fall back to current draft
    const effectiveFlow = snapshotManifest
      ? { ...flow, manifest: snapshotManifest as typeof flow.manifest }
      : flow;

    // --- Validate everything BEFORE using the link ---

    const inputSchema = effectiveFlow.manifest.input?.schema;
    const { input: parsedInput, uploadedFiles } = await parseRequestInput(c, inputSchema);

    const { providerProfiles, config } = await resolvePreflightContext({
      flow: effectiveFlow,
      actor,
      packageId,
      orgId,
    });

    // --- All validations passed — now atomically use the link ---

    const executionId = `exec_${crypto.randomUUID()}`;

    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? null;
    const userAgent = c.req.header("user-agent") ?? null;

    const used = await useShareLink(token, {
      ip: ip ?? undefined,
      userAgent: userAgent ?? undefined,
      executionId,
    });
    if (!used) {
      throw gone("token_invalid", "This link has already been used or is no longer valid.");
    }

    const fileRefs = uploadedFiles?.map((f) => ({
      fieldName: f.fieldName,
      name: f.name,
      type: f.type,
      size: f.size,
    }));

    const userProfileId = await getEffectiveProfileId(actor, packageId);

    let promptContext: PromptContext;
    let flowPackage: Buffer | null;
    let packageVersionId: number | null;
    let proxyLabel: string | null;
    let modelLabel: string | null;
    try {
      ({ promptContext, flowPackage, packageVersionId, proxyLabel, modelLabel } =
        await buildExecutionContext({
          executionId,
          flow: effectiveFlow,
          providerProfiles,
          orgId,
          actor,
          input: parsedInput,
          files: fileRefs,
          config,
        }));
    } catch (err) {
      if (err instanceof ModelNotConfiguredError) {
        throw new ApiError({
          status: 400,
          code: "model_not_configured",
          title: "Bad Request",
          detail: err.message,
        });
      }
      throw err;
    }

    await createExecution(
      executionId,
      packageId,
      actor,
      orgId,
      parsedInput ?? null,
      undefined,
      packageVersionId ?? undefined,
      userProfileId,
      proxyLabel ?? undefined,
      modelLabel ?? undefined,
      applicationId,
      linkId,
    );

    // Fire-and-forget
    executeFlowInBackground(
      executionId,
      actor,
      orgId,
      effectiveFlow,
      promptContext,
      flowPackage,
      uploadedFiles,
      applicationId,
    ).catch((err) => {
      logger.error("Unhandled error in shared execution", {
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return c.json({ executionId });
  });

  // GET /share/:token/status — polling endpoint for execution status + public logs (no JWT)
  router.get("/:token/status", rateLimitByIp(60), async (c) => {
    const token = c.req.param("token")!;
    const shareLink = await getShareLink(token);

    if (!shareLink) {
      throw gone("token_invalid", "This link is no longer valid.");
    }

    // Find the most recent execution via usages
    const [latestUsage] = await db
      .select({ executionId: shareLinkUsages.executionId })
      .from(shareLinkUsages)
      .where(eq(shareLinkUsages.shareLinkId, shareLink.id))
      .orderBy(desc(shareLinkUsages.usedAt))
      .limit(1);

    if (!latestUsage?.executionId) {
      return c.json({ status: "pending", logs: [] });
    }

    const [execRow] = await db
      .select({
        id: executions.id,
        status: executions.status,
        result: executions.result,
        error: executions.error,
      })
      .from(executions)
      .where(eq(executions.id, latestUsage.executionId))
      .limit(1);

    if (!execRow) {
      return c.json({ status: "pending", logs: [] });
    }

    const allLogs = await listExecutionLogs(execRow.id, shareLink.orgId);

    return c.json({
      status: execRow.status ?? "pending",
      ...(execRow.result ? { result: execRow.result } : {}),
      ...(execRow.error ? { error: execRow.error } : {}),
      logs: allLogs,
    });
  });

  return router;
}
