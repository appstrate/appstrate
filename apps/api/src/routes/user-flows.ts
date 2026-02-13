import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { importFlowFromZip, FlowImportError } from "../services/flow-import.ts";
import { deleteUserFlow, updateUserFlow, insertUserFlow } from "../services/user-flows.ts";
import { getRunningExecutionsForFlow } from "../services/state.ts";
import { validateManifest, validateFlowContent } from "../services/schema.ts";
import { getFlow, getAllFlowIds } from "../services/flow-service.ts";
import { createVersionSnapshot } from "../services/flow-versions.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requireAdmin, requireFlow } from "../middleware/guards.ts";

export function createUserFlowsRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/flows/import — import a flow from a ZIP file (admin-only)
  router.post("/import", rateLimit(10), requireAdmin(), async (c) => {
    const user = c.get("user");

    const formData = await c.req.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return c.json({ error: "VALIDATION_ERROR", message: "Aucun fichier fourni" }, 400);
    }

    if (!file.name.endsWith(".zip")) {
      return c.json(
        { error: "VALIDATION_ERROR", message: "Seuls les fichiers .zip sont acceptes" },
        400,
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const existingIds = await getAllFlowIds();

    try {
      const result = await importFlowFromZip(buffer, existingIds);

      // Create initial version snapshot (non-blocking)
      getFlow(result.flowId).then((flow) => {
        if (flow) {
          createVersionSnapshot(
            result.flowId,
            flow.manifest as unknown as Record<string, unknown>,
            flow.prompt,
            flow.skills
              .filter((s) => s.content)
              .map((s) => ({
                id: s.id,
                description: s.description,
                content: s.content!,
              })),
            user.id,
          );
        }
      });

      return c.json({ flowId: result.flowId, message: "Flow importe" }, 201);
    } catch (err) {
      if (err instanceof FlowImportError) {
        return c.json({ error: err.code, message: err.message, details: err.details }, 400);
      }
      throw err;
    }
  });

  // POST /api/flows — create a flow from admin (without ZIP)
  router.post("/", rateLimit(10), requireAdmin(), async (c) => {
    const user = c.get("user");

    const body = await c.req.json<{
      manifest: Record<string, unknown>;
      prompt: string;
      skills?: { id: string; description: string; content: string }[];
    }>();

    const { manifest, prompt, skills = [] } = body;

    // Validate manifest
    const manifestResult = validateManifest(manifest);
    if (!manifestResult.valid) {
      return c.json(
        { error: "INVALID_MANIFEST", message: "Manifest invalide", details: manifestResult.errors },
        400,
      );
    }

    // Validate prompt + skills
    const contentResult = validateFlowContent(prompt, skills);
    if (!contentResult.valid) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: "Contenu invalide",
          details: contentResult.errors,
        },
        400,
      );
    }

    const flowId = (manifest.metadata as { name: string }).name;
    const existingIds = await getAllFlowIds();

    if (existingIds.includes(flowId)) {
      return c.json(
        { error: "NAME_COLLISION", message: `Un flow avec l'identifiant '${flowId}' existe deja` },
        400,
      );
    }

    await insertUserFlow(flowId, manifest, prompt, skills);

    // Create initial version snapshot (non-blocking)
    createVersionSnapshot(flowId, manifest, prompt, skills, user.id);

    return c.json({ flowId, message: "Flow cree" }, 201);
  });

  // PUT /api/flows/:id — update a user flow (admin-only)
  router.put("/:id", requireFlow(), requireAdmin(), async (c) => {
    const flow = c.get("flow");
    const user = c.get("user");
    const flowId = flow.id;

    if (flow.source !== "user") {
      return c.json(
        { error: "OPERATION_NOT_ALLOWED", message: "Impossible de modifier un flow built-in" },
        403,
      );
    }

    const running = await getRunningExecutionsForFlow(flowId);
    if (running > 0) {
      return c.json(
        { error: "FLOW_IN_USE", message: `${running} execution(s) en cours pour ce flow` },
        409,
      );
    }

    const body = await c.req.json<{
      manifest: Record<string, unknown>;
      prompt: string;
      skills?: { id: string; description: string; content: string }[];
      updatedAt: string;
    }>();

    const { manifest, prompt, skills = [], updatedAt } = body;

    if (!updatedAt) {
      return c.json(
        { error: "VALIDATION_ERROR", message: "updatedAt est requis pour la mise a jour" },
        400,
      );
    }

    // Validate manifest
    const manifestResult = validateManifest(manifest);
    if (!manifestResult.valid) {
      return c.json(
        { error: "INVALID_MANIFEST", message: "Manifest invalide", details: manifestResult.errors },
        400,
      );
    }

    // Ensure ID immutability
    const newId = (manifest.metadata as { name: string }).name;
    if (newId !== flowId) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: `metadata.name ne peut pas changer (actuel: '${flowId}', recu: '${newId}')`,
        },
        400,
      );
    }

    // Validate prompt + skills
    const contentResult = validateFlowContent(prompt, skills);
    if (!contentResult.valid) {
      return c.json(
        { error: "VALIDATION_ERROR", message: "Contenu invalide", details: contentResult.errors },
        400,
      );
    }

    const updated = await updateUserFlow(flowId, { manifest, prompt, skills }, updatedAt);
    if (!updated) {
      return c.json(
        {
          error: "CONFLICT",
          message: "Le flow a ete modifie depuis votre derniere lecture. Rechargez et reessayez.",
        },
        409,
      );
    }

    // Create version snapshot (non-blocking)
    createVersionSnapshot(flowId, manifest, prompt, skills, user.id);

    return c.json({ flowId, message: "Flow mis a jour", updatedAt: updated.updated_at });
  });

  // DELETE /api/flows/:id — delete a user flow (admin-only)
  router.delete("/:id", requireFlow(), requireAdmin(), async (c) => {
    const flow = c.get("flow");
    const flowId = flow.id;

    if (flow.source !== "user") {
      return c.json(
        { error: "OPERATION_NOT_ALLOWED", message: "Impossible de supprimer un flow built-in" },
        403,
      );
    }

    const running = await getRunningExecutionsForFlow(flowId);
    if (running > 0) {
      return c.json(
        { error: "FLOW_IN_USE", message: `${running} execution(s) en cours pour ce flow` },
        409,
      );
    }

    await deleteUserFlow(flowId);

    return c.body(null, 204);
  });

  return router;
}
