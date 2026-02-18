import { Hono } from "hono";
import { logger } from "../lib/logger.ts";
import { supabase } from "../lib/supabase.ts";
import {
  getShareToken,
  consumeShareToken,
  linkExecutionToToken,
} from "../services/share-tokens.ts";
import { getFlow } from "../services/flow-service.ts";
import {
  getFlowConfig,
  getLastExecutionState,
  createExecution,
  getAdminConnections,
} from "../services/state.ts";
import { getAccessToken, resolveServiceStatuses } from "../services/nango.ts";
import {
  validateInput,
  validateFileInputs,
  schemaHasFileFields,
  parseFormDataFiles,
} from "../services/schema.ts";
import { buildPromptContext, buildExecutionApi } from "../services/env-builder.ts";
import { getFlowPackage } from "../services/flow-package.ts";
import { getLatestVersionId } from "../services/flow-versions.ts";
import { uploadExecutionFiles } from "../services/file-storage.ts";
import { executeFlowInBackground } from "./executions.ts";
import { rateLimitByIp } from "../middleware/rate-limit.ts";
import type { UploadedFile } from "../services/adapters/types.ts";
import type { FileReference } from "../services/adapters/index.ts";

export function createShareRouter() {
  const router = new Hono();

  // GET /share/:token/flow — public flow metadata (no JWT)
  router.get("/:token/flow", rateLimitByIp(60), async (c) => {
    const token = c.req.param("token");
    const shareToken = await getShareToken(token);

    if (!shareToken || shareToken.expires_at! < new Date().toISOString()) {
      return c.json({ error: "TOKEN_INVALID", message: "Ce lien n'est plus valide." }, 410);
    }

    const orgId = shareToken.org_id as string;
    const flow = await getFlow(shareToken.flow_id, orgId);
    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: "Flow introuvable." }, 404);
    }

    // Resolve service statuses
    const adminConns = await getAdminConnections(orgId, flow.id);
    const serviceStatuses = await resolveServiceStatuses(
      flow.manifest.requires.services,
      adminConns,
      orgId,
    );

    const result: Record<string, unknown> = {
      displayName: flow.manifest.metadata.displayName,
      description: flow.manifest.metadata.description,
      ...(flow.manifest.input ? { input: { schema: flow.manifest.input.schema } } : {}),
      ...(serviceStatuses.length > 0 ? { services: serviceStatuses } : {}),
      consumed: !!shareToken.consumed_at,
    };

    // If already consumed and has execution, include execution status
    if (shareToken.consumed_at && shareToken.execution_id) {
      const { data: exec } = await supabase
        .from("executions")
        .select("status, result, error")
        .eq("id", shareToken.execution_id)
        .single();

      if (exec) {
        result.execution = {
          id: shareToken.execution_id,
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
        { error: "TOKEN_INVALID", message: "Ce lien a deja ete utilise ou n'est plus valide." },
        410,
      );
    }

    const { id: tokenId, flow_id: flowId, created_by: userId, org_id: orgId } = consumed;

    const flow = await getFlow(flowId, orgId);
    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: "Flow introuvable." }, 404);
    }

    const inputSchema = flow.manifest.input?.schema;
    const hasFileFields = schemaHasFileFields(inputSchema);

    let body: { input?: Record<string, unknown> };
    let uploadedFiles: UploadedFile[] | undefined;

    if (hasFileFields) {
      try {
        const formData = await c.req.formData();
        const parsed = await parseFormDataFiles(formData, inputSchema!);
        body = { input: parsed.input };
        uploadedFiles = parsed.files;
      } catch (err) {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: `Erreur de parsing FormData: ${err instanceof Error ? err.message : String(err)}`,
          },
          400,
        );
      }

      if (uploadedFiles.length > 0) {
        const fileValidation = validateFileInputs(uploadedFiles, inputSchema!);
        if (!fileValidation.valid) {
          const first = fileValidation.errors[0]!;
          return c.json(
            { error: "VALIDATION_ERROR", message: first.message, field: first.field },
            400,
          );
        }
      }
    } else {
      try {
        body = await c.req.json<{ input?: Record<string, unknown> }>();
      } catch {
        body = {};
      }
    }

    // Validate non-file input fields
    if (inputSchema) {
      const inputValidation = validateInput(body.input, inputSchema);
      if (!inputValidation.valid) {
        const first = inputValidation.errors[0]!;
        return c.json({ error: "INPUT_REQUIRED", message: first.message, field: first.field }, 400);
      }
    }

    const executionId = `exec_${crypto.randomUUID()}`;

    // Upload files to Supabase Storage
    let fileRefs: FileReference[] | undefined;
    if (uploadedFiles && uploadedFiles.length > 0) {
      try {
        fileRefs = await uploadExecutionFiles(executionId, uploadedFiles);
      } catch (err) {
        return c.json(
          {
            error: "FILE_UPLOAD_FAILED",
            message: `Echec de l'upload des fichiers: ${err instanceof Error ? err.message : String(err)}`,
          },
          500,
        );
      }
    }

    // Resolve config, previous state, and tokens using the admin's (created_by) credentials
    const adminConns = await getAdminConnections(orgId, flowId);
    const config = await getFlowConfig(orgId, flowId);
    const previousState = await getLastExecutionState(flowId, userId, orgId);
    const tokens: Record<string, string> = {};
    for (const svc of flow.manifest.requires.services) {
      const mode = svc.connectionMode ?? "user";
      const tokenUserId = mode === "admin" ? adminConns[svc.id] : userId;
      if (tokenUserId) {
        const accessToken = await getAccessToken(svc.provider, orgId, tokenUserId);
        if (accessToken) tokens[svc.id] = accessToken;
      }
    }

    // Build prompt context
    const promptContext = buildPromptContext({
      flow,
      tokens,
      config,
      previousState,
      executionApi: buildExecutionApi(executionId),
      input: body.input,
      files: fileRefs,
    });

    // Get flow package
    const flowPackage = await getFlowPackage(flow);

    // Get flow version ID
    const flowVersionId =
      flow.source === "user" ? await getLatestVersionId(flowId).catch(() => null) : null;

    // Create execution record (using admin's user_id), then link to share token
    await createExecution(
      executionId,
      flowId,
      userId,
      orgId,
      body.input ?? null,
      undefined,
      flowVersionId ?? undefined,
    );
    await linkExecutionToToken(tokenId, executionId);

    // Fire-and-forget
    executeFlowInBackground(
      executionId,
      flowId,
      userId,
      orgId,
      flow,
      promptContext,
      flowPackage,
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
      return c.json({ error: "TOKEN_INVALID", message: "Ce lien n'est plus valide." }, 410);
    }

    if (!shareToken.execution_id) {
      return c.json({ status: "pending" });
    }

    const { data: exec } = await supabase
      .from("executions")
      .select("status, result, error")
      .eq("id", shareToken.execution_id)
      .single();

    return c.json({
      status: exec?.status ?? "pending",
      ...(exec?.result ? { result: exec.result } : {}),
      ...(exec?.error ? { error: exec.error } : {}),
    });
  });

  return router;
}
