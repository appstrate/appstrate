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
import {
  createExecution,
  getAdminConnections,
  getPackageConfig,
  listExecutionLogs,
} from "../services/state/index.ts";
import { resolveProviderStatuses } from "../services/connection-manager/index.ts";
import { parseRequestInput } from "../services/input-parser.ts";
import { buildExecutionContext, ModelNotConfiguredError } from "../services/env-builder.ts";
import { validateFlowReadiness } from "../services/flow-readiness.ts";
import type { PromptContext } from "../services/adapters/types.ts";
import { executeFlowInBackground } from "./executions.ts";
import { rateLimitByIp } from "../middleware/rate-limit.ts";
import { resolveProviderProfiles, getEffectiveProfileId } from "../services/connection-profiles.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";

export function createShareRouter() {
  const router = new Hono();

  // GET /share/:token/flow — public flow metadata (no JWT)
  router.get("/:token/flow", rateLimitByIp(60), async (c) => {
    const token = c.req.param("token")!;
    const shareToken = await getShareToken(token);

    if (!shareToken || shareToken.expiresAt < new Date()) {
      return c.json({ error: "TOKEN_INVALID", message: "This link is no longer valid." }, 410);
    }

    const orgId = shareToken.orgId;
    const flow = await getPackage(shareToken.packageId, orgId);
    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: "Flow not found." }, 404);
    }

    // Use the snapshotted manifest if available, otherwise fall back to current draft
    const manifest = shareToken.manifest
      ? (shareToken.manifest as typeof flow.manifest)
      : flow.manifest;

    // Resolve provider statuses
    const adminConns = await getAdminConnections(orgId, flow.id);
    const providerStatuses = await resolveProviderStatuses(
      resolveManifestProviders(manifest),
      adminConns,
      orgId,
      undefined,
    );

    const result: Record<string, unknown> = {
      displayName: manifest.displayName,
      description: manifest.description,
      ...(manifest.input ? { input: { schema: manifest.input.schema } } : {}),
      ...(manifest.output ? { output: { schema: manifest.output.schema } } : {}),
      ...(providerStatuses.length > 0 ? { providers: providerStatuses } : {}),
      consumed: !!shareToken.consumedAt,
    };

    // If already consumed and has execution, include execution status + logs
    if (shareToken.consumedAt && shareToken.executionId) {
      const [execRows, allLogs] = await Promise.all([
        db
          .select({
            status: executions.status,
            result: executions.result,
            error: executions.error,
          })
          .from(executions)
          .where(eq(executions.id, shareToken.executionId))
          .limit(1),
        listExecutionLogs(shareToken.executionId, shareToken.orgId),
      ]);

      const exec = execRows[0];
      if (exec) {
        result.execution = {
          id: shareToken.executionId,
          status: exec.status,
          ...(exec.result ? { result: exec.result } : {}),
          ...(exec.error ? { error: exec.error } : {}),
          logs: allLogs,
        };
      }
    }

    return c.json(result);
  });

  // POST /share/:token/run — validate, then consume token and execute (no JWT)
  router.post("/:token/run", rateLimitByIp(5), async (c) => {
    const token = c.req.param("token")!;

    // Verify token is valid (without consuming it yet)
    const shareToken = await getShareToken(token);
    if (!shareToken || shareToken.consumedAt || shareToken.expiresAt < new Date()) {
      return c.json(
        {
          error: "TOKEN_INVALID",
          message: "This link has already been used or is no longer valid.",
        },
        410,
      );
    }

    const { id: tokenId, packageId, createdBy: userId, orgId } = shareToken;
    const snapshotManifest = shareToken.manifest as Record<string, unknown> | null;

    const flow = await getPackage(packageId, orgId);
    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: "Flow not found." }, 404);
    }

    // Use the snapshotted manifest if available, otherwise fall back to current draft
    const effectiveFlow = snapshotManifest
      ? { ...flow, manifest: snapshotManifest as typeof flow.manifest }
      : flow;

    // --- Validate everything BEFORE consuming the token ---

    const inputSchema = effectiveFlow.manifest.input?.schema;
    const inputResult = await parseRequestInput(c, inputSchema);
    if (!inputResult.ok) {
      return c.json(inputResult.error, inputResult.status);
    }
    const { input: parsedInput, uploadedFiles } = inputResult.data;

    const manifestProviders = resolveManifestProviders(effectiveFlow.manifest);
    const [providerProfiles, config] = await Promise.all([
      resolveProviderProfiles(manifestProviders, userId, packageId, orgId),
      getPackageConfig(orgId, packageId),
    ]);

    const readinessError = await validateFlowReadiness({
      flow: effectiveFlow,
      providerProfiles,
      orgId,
      config,
    });
    if (readinessError) {
      return c.json(readinessError, 400);
    }

    // --- All validations passed — now atomically consume the token ---

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

    const executionId = `exec_${crypto.randomUUID()}`;

    const fileRefs = uploadedFiles?.map((f) => ({
      fieldName: f.fieldName,
      name: f.name,
      type: f.type,
      size: f.size,
    }));

    const userProfileId = await getEffectiveProfileId(userId, packageId);

    let promptContext: PromptContext;
    let flowPackage: Buffer | null;
    let flowVersionId: number | null;
    let proxyLabel: string | null;
    let modelLabel: string | null;
    try {
      ({ promptContext, flowPackage, flowVersionId, proxyLabel, modelLabel } =
        await buildExecutionContext({
          executionId,
          flow: effectiveFlow,
          providerProfiles,
          orgId,
          userId,
          input: parsedInput,
          files: fileRefs,
          config,
        }));
    } catch (err) {
      if (err instanceof ModelNotConfiguredError) {
        return c.json({ error: "MODEL_NOT_CONFIGURED", message: err.message }, 400);
      }
      throw err;
    }

    await createExecution(
      executionId,
      packageId,
      userId,
      orgId,
      parsedInput ?? null,
      undefined,
      flowVersionId ?? undefined,
      userProfileId,
      proxyLabel ?? undefined,
      modelLabel ?? undefined,
    );
    await linkExecutionToToken(tokenId, executionId);

    // Fire-and-forget
    executeFlowInBackground(
      executionId,
      userId,
      orgId,
      effectiveFlow,
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

  // GET /share/:token/status — polling endpoint for execution status + public logs (no JWT)
  router.get("/:token/status", rateLimitByIp(60), async (c) => {
    const token = c.req.param("token")!;
    const shareToken = await getShareToken(token);

    if (!shareToken) {
      return c.json({ error: "TOKEN_INVALID", message: "This link is no longer valid." }, 410);
    }

    if (!shareToken.executionId) {
      return c.json({ status: "pending", logs: [] });
    }

    const [execRows, allLogs] = await Promise.all([
      db
        .select({
          status: executions.status,
          result: executions.result,
          error: executions.error,
        })
        .from(executions)
        .where(eq(executions.id, shareToken.executionId))
        .limit(1),
      listExecutionLogs(shareToken.executionId, shareToken.orgId),
    ]);

    const exec = execRows[0];

    return c.json({
      status: exec?.status ?? "pending",
      ...(exec?.result ? { result: exec.result } : {}),
      ...(exec?.error ? { error: exec.error } : {}),
      logs: allLogs,
    });
  });

  return router;
}
