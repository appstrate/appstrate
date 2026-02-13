import { Hono } from "hono";
import type { LoadedFlow, FlowManifest, SkillMeta, AppEnv } from "../types/index.ts";
import { importFlowFromZip, FlowImportError } from "../services/flow-import.ts";
import {
  deleteUserFlow,
  updateUserFlow,
  insertUserFlow,
  getFlowById,
} from "../services/user-flows.ts";
import { getRunningExecutionsForFlow } from "../services/state.ts";
import { validateManifest, validateFlowContent } from "../services/schema.ts";
import { isAdmin } from "../lib/supabase.ts";

interface UserFlowsRouterOptions {
  flows: Map<string, LoadedFlow>;
}

async function reloadFlowFromDB(
  flowId: string,
  flows: Map<string, LoadedFlow>,
): Promise<LoadedFlow> {
  const row = await getFlowById(flowId);
  if (!row) throw new Error(`Flow '${flowId}' introuvable en DB apres write`);

  const skills: SkillMeta[] = (
    (row.skills ?? []) as { id: string; description: string; content?: string }[]
  ).map((s) => ({ id: s.id, description: s.description, content: s.content }));

  const loaded: LoadedFlow = {
    id: row.id,
    manifest: row.manifest as unknown as FlowManifest,
    prompt: row.prompt,
    skills,
    source: "user",
  };

  flows.set(row.id, loaded);
  return loaded;
}

export function createUserFlowsRouter({ flows }: UserFlowsRouterOptions) {
  const router = new Hono<AppEnv>();

  // POST /api/flows/import — import a flow from a ZIP file (admin-only)
  router.post("/import", async (c) => {
    const user = c.get("user");

    if (!(await isAdmin(user.id))) {
      return c.json(
        { error: "FORBIDDEN", message: "Seuls les administrateurs peuvent importer des flows" },
        403,
      );
    }

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
    const existingIds = Array.from(flows.keys());

    try {
      const result = await importFlowFromZip(buffer, existingIds);

      try {
        await reloadFlowFromDB(result.flowId, flows);
      } catch (err) {
        console.error(`Flow ${result.flowId}: reload failed after import`, err);
        await deleteUserFlow(result.flowId).catch(() => {});
        return c.json(
          { error: "INTERNAL_ERROR", message: "Import echoue lors du rechargement" },
          500,
        );
      }

      return c.json({ flowId: result.flowId, message: "Flow importe" }, 201);
    } catch (err) {
      if (err instanceof FlowImportError) {
        return c.json({ error: err.code, message: err.message, details: err.details }, 400);
      }
      throw err;
    }
  });

  // POST /api/flows — create a flow from admin (without ZIP)
  router.post("/", async (c) => {
    const user = c.get("user");

    if (!(await isAdmin(user.id))) {
      return c.json(
        { error: "FORBIDDEN", message: "Seuls les administrateurs peuvent creer des flows" },
        403,
      );
    }

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
    const existingIds = Array.from(flows.keys());

    if (existingIds.includes(flowId)) {
      return c.json(
        { error: "NAME_COLLISION", message: `Un flow avec l'identifiant '${flowId}' existe deja` },
        400,
      );
    }

    await insertUserFlow(flowId, manifest, prompt, skills);

    try {
      await reloadFlowFromDB(flowId, flows);
    } catch (err) {
      console.error(`Flow ${flowId}: reload failed after create`, err);
      await deleteUserFlow(flowId).catch(() => {});
      return c.json(
        { error: "INTERNAL_ERROR", message: "Creation echouee lors du rechargement" },
        500,
      );
    }

    return c.json({ flowId, message: "Flow cree" }, 201);
  });

  // PUT /api/flows/:id — update a user flow (admin-only)
  router.put("/:id", async (c) => {
    const flowId = c.req.param("id");
    const flow = flows.get(flowId);
    const user = c.get("user");

    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: `Flow '${flowId}' introuvable` }, 404);
    }

    if (flow.source !== "user") {
      return c.json(
        { error: "OPERATION_NOT_ALLOWED", message: "Impossible de modifier un flow built-in" },
        403,
      );
    }

    if (!(await isAdmin(user.id))) {
      return c.json(
        { error: "FORBIDDEN", message: "Seuls les administrateurs peuvent modifier des flows" },
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

    try {
      await reloadFlowFromDB(flowId, flows);
    } catch (err) {
      // Keep the OLD entry in the Map — flow stays operational with previous version
      console.error(
        `Flow ${flowId}: reload failed after update, keeping old version in memory`,
        err,
      );
      return c.json(
        {
          error: "INTERNAL_ERROR",
          message:
            "Mise a jour DB reussie mais rechargement echoue. L'ancienne version reste active.",
        },
        500,
      );
    }

    return c.json({ flowId, message: "Flow mis a jour", updatedAt: updated.updated_at });
  });

  // DELETE /api/flows/:id — delete a user flow (admin-only)
  router.delete("/:id", async (c) => {
    const flowId = c.req.param("id");
    const flow = flows.get(flowId);
    const user = c.get("user");

    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: `Flow '${flowId}' introuvable` }, 404);
    }

    if (flow.source !== "user") {
      return c.json(
        { error: "OPERATION_NOT_ALLOWED", message: "Impossible de supprimer un flow built-in" },
        403,
      );
    }

    if (!(await isAdmin(user.id))) {
      return c.json(
        { error: "FORBIDDEN", message: "Seuls les administrateurs peuvent supprimer des flows" },
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
    flows.delete(flowId);

    return c.body(null, 204);
  });

  return router;
}
