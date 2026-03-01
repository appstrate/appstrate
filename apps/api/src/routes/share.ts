import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { executions } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import {
  getShareToken,
  consumeShareToken,
  linkExecutionToToken,
} from "../services/share-tokens.ts";
import { getPackage } from "../services/flow-service.ts";
import { createExecution, getAdminConnections } from "../services/state.ts";
import { resolveServiceStatuses } from "../services/connection-manager.ts";
import { validateFlowDependencies } from "../services/dependency-validation.ts";
import { parseRequestInput } from "../services/input-parser.ts";
import { buildExecutionContext } from "../services/env-builder.ts";
import { executeFlowInBackground } from "./executions.ts";
import { rateLimitByIp } from "../middleware/rate-limit.ts";
import { resolveServiceProfiles, getEffectiveProfileId } from "../services/connection-profiles.ts";

export function createShareRouter() {
  const router = new Hono();

  // GET /share/:token/flow — public flow metadata (no JWT)
  router.get("/:token/flow", rateLimitByIp(60), async (c) => {
    const token = c.req.param("token");
    const shareToken = await getShareToken(token);

    if (!shareToken || shareToken.expiresAt < new Date()) {
      return c.json({ error: "TOKEN_INVALID", message: "This link is no longer valid." }, 410);
    }

    const orgId = shareToken.orgId;
    const flow = await getPackage(shareToken.packageId, orgId);
    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: "Flow not found." }, 404);
    }

    // Resolve service statuses
    const adminConns = await getAdminConnections(orgId, flow.id);
    const serviceStatuses = await resolveServiceStatuses(
      flow.manifest.requires.services,
      adminConns,
      orgId,
      undefined,
    );

    const result: Record<string, unknown> = {
      displayName: flow.manifest.displayName,
      description: flow.manifest.description,
      ...(flow.manifest.input ? { input: { schema: flow.manifest.input.schema } } : {}),
      ...(serviceStatuses.length > 0 ? { services: serviceStatuses } : {}),
      consumed: !!shareToken.consumedAt,
    };

    // If already consumed and has execution, include execution status
    if (shareToken.consumedAt && shareToken.executionId) {
      const rows = await db
        .select({
          status: executions.status,
          result: executions.result,
          error: executions.error,
        })
        .from(executions)
        .where(eq(executions.id, shareToken.executionId))
        .limit(1);

      const exec = rows[0];
      if (exec) {
        result.execution = {
          id: shareToken.executionId,
          status: exec.status,
          ...(exec.result ? { result: exec.result } : {}),
          ...(exec.error ? { error: exec.error } : {}),
        };
      }
    }

    return c.json(result);
  });

  // POST /share/:token/run — consume token and execute (no JWT)
  router.post("/:token/run", rateLimitByIp(5), async (c) => {
    const token = c.req.param("token");

    // Atomically consume the token
    const consumed = await consumeShareToken(token);
    if (!consumed) {
      return c.json(
        {
          error: "TOKEN_INVALID",
          message: "This link has already been used or is no longer valid.",
        },
        410,
      );
    }

    const { id: tokenId, packageId, createdBy: userId, orgId } = consumed;

    const flow = await getPackage(packageId, orgId);
    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: "Flow not found." }, 404);
    }

    const inputSchema = flow.manifest.input?.schema;
    const inputResult = await parseRequestInput(c, inputSchema);
    if (!inputResult.ok) {
      return c.json(inputResult.error, inputResult.status);
    }
    const { input: parsedInput, uploadedFiles } = inputResult.data;

    const executionId = `exec_${crypto.randomUUID()}`;

    // Build file metadata for prompt context (no URLs — files injected directly into container)
    const fileRefs = uploadedFiles?.map((f) => ({
      fieldName: f.fieldName,
      name: f.name,
      type: f.type,
      size: f.size,
    }));

    // Resolve service profiles
    const serviceProfiles = await resolveServiceProfiles(
      flow.manifest.requires.services,
      userId,
      packageId,
      orgId,
    );

    // Validate service dependencies before execution
    const depError = await validateFlowDependencies(
      flow.manifest.requires.services,
      serviceProfiles,
      orgId,
    );
    if (depError) {
      return c.json(depError, 400);
    }

    const userProfileId = await getEffectiveProfileId(userId, packageId);

    // Build execution context (tokens, config, state, providers, package, version)
    const { promptContext, flowPackage, flowVersionId } = await buildExecutionContext({
      executionId,
      flow,
      serviceProfiles,
      orgId,
      userId,
      input: parsedInput,
      files: fileRefs,
    });

    // Create execution record (using admin's user_id), then link to share token
    await createExecution(
      executionId,
      packageId,
      userId,
      orgId,
      parsedInput ?? null,
      undefined,
      flowVersionId ?? undefined,
      userProfileId,
    );
    await linkExecutionToToken(tokenId, executionId);

    // Fire-and-forget
    executeFlowInBackground(
      executionId,
      userId,
      orgId,
      flow,
      promptContext,
      flowPackage,
      uploadedFiles,
    ).catch((err) => {
      logger.error("Unhandled error in shared execution", {
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return c.json({ executionId });
  });

  // GET /share/:token/status — polling endpoint for execution status (no JWT)
  router.get("/:token/status", rateLimitByIp(60), async (c) => {
    const token = c.req.param("token");
    const shareToken = await getShareToken(token);

    if (!shareToken) {
      return c.json({ error: "TOKEN_INVALID", message: "This link is no longer valid." }, 410);
    }

    if (!shareToken.executionId) {
      return c.json({ status: "pending" });
    }

    const rows = await db
      .select({
        status: executions.status,
        result: executions.result,
        error: executions.error,
      })
      .from(executions)
      .where(eq(executions.id, shareToken.executionId))
      .limit(1);

    const exec = rows[0];
    return c.json({
      status: exec?.status ?? "pending",
      ...(exec?.result ? { result: exec.result } : {}),
      ...(exec?.error ? { error: exec.error } : {}),
    });
  });

  return router;
}
