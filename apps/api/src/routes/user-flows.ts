import { Hono } from "hono";
import type { FlowManifest, LoadedFlow, SkillMeta } from "../types/index.ts";
import { importFlowFromZip, FlowImportError } from "../services/flow-import.ts";
import { deleteUserFlow, getUserFlow } from "../services/user-flows.ts";
import { materializeFlow, USER_FLOWS_DIR, cleanupFlowDir } from "../services/flow-materializer.ts";
import { getRunningExecutionsForFlow } from "../services/state.ts";

interface UserFlowsRouterOptions {
  flows: Map<string, LoadedFlow>;
}

export function createUserFlowsRouter({ flows }: UserFlowsRouterOptions) {
  const router = new Hono();

  // POST /api/flows/import — import a flow from a ZIP file
  router.post("/import", async (c) => {
    const formData = await c.req.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return c.json({ error: "VALIDATION_ERROR", message: "Aucun fichier fourni" }, 400);
    }

    if (!file.name.endsWith(".zip")) {
      return c.json({ error: "VALIDATION_ERROR", message: "Seuls les fichiers .zip sont acceptés" }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const existingIds = Array.from(flows.keys());

    try {
      const result = await importFlowFromZip(buffer, existingIds);

      // Materialize and add to in-memory map
      const row = await getUserFlow(result.flowId);
      if (row) {
        const path = await materializeFlow(row, USER_FLOWS_DIR);
        const skills: SkillMeta[] = (row.skills || []).map((s) => ({
          id: s.id,
          description: s.description,
        }));

        flows.set(row.id, {
          id: row.id,
          manifest: row.manifest as FlowManifest,
          prompt: row.prompt,
          path,
          skills,
          source: "user",
        });
      }

      return c.json({ flowId: result.flowId, message: "Flow importé" }, 201);
    } catch (err) {
      if (err instanceof FlowImportError) {
        return c.json(
          { error: err.code, message: err.message, details: err.details },
          400,
        );
      }
      throw err;
    }
  });

  // DELETE /api/flows/:id — delete a user flow
  router.delete("/:id", async (c) => {
    const flowId = c.req.param("id");
    const flow = flows.get(flowId);

    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: `Flow '${flowId}' introuvable` }, 404);
    }

    if (flow.source !== "user") {
      return c.json(
        { error: "OPERATION_NOT_ALLOWED", message: "Impossible de supprimer un flow built-in" },
        403,
      );
    }

    const running = await getRunningExecutionsForFlow(flowId);
    if (running > 0) {
      return c.json(
        { error: "FLOW_IN_USE", message: `${running} exécution(s) en cours pour ce flow` },
        409,
      );
    }

    await deleteUserFlow(flowId);
    await cleanupFlowDir(flowId);
    flows.delete(flowId);

    return c.body(null, 204);
  });

  return router;
}
