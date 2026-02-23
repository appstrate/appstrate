import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import {
  importFlowFromZip,
  parseFlowZip,
  upsertSkillsAndExtensionsFromFiles,
  FlowImportError,
} from "../services/flow-import.ts";
import { deleteUserFlow, updateUserFlow, insertUserFlow } from "../services/user-flows.ts";
import { validateManifest } from "../services/schema.ts";
import { getAllFlowIds } from "../services/flow-service.ts";
import { createVersionAndUpload } from "../services/flow-versions.ts";
import { buildMinimalZip } from "../services/flow-package.ts";
import { setFlowSkills, setFlowExtensions } from "../services/library.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requireAdmin, requireFlow, requireMutableFlow } from "../middleware/guards.ts";
import { logger } from "../lib/logger.ts";

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
    logger.info("Flow import: received ZIP", {
      fileName: file.name,
      size: buffer.length,
      userId: user.id,
    });

    const orgId = c.get("orgId");
    let existingIds: string[];
    try {
      existingIds = await getAllFlowIds(orgId);
      logger.info("Flow import: existing IDs fetched", {
        count: existingIds.length,
        ids: existingIds,
      });
    } catch (err) {
      logger.error("Flow import: failed to fetch existing IDs", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      throw err;
    }

    try {
      const result = await importFlowFromZip(buffer, existingIds, user.id, orgId);
      logger.info("Flow import: success", { flowId: result.flowId });
      return c.json(
        {
          flowId: result.flowId,
          message: "Flow importe",
          skillsCreated: result.skillsCreated,
          skillsMatched: result.skillsMatched,
          extensionsCreated: result.extensionsCreated,
          extensionsMatched: result.extensionsMatched,
        },
        201,
      );
    } catch (err) {
      if (err instanceof FlowImportError) {
        logger.warn("Flow import: FlowImportError", {
          code: err.code,
          message: err.message,
          details: err.details,
        });
        return c.json({ error: err.code, message: err.message, details: err.details }, 400);
      }
      logger.error("Flow import: unexpected error", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        name: err instanceof Error ? err.name : undefined,
        type: typeof err,
      });
      throw err;
    }
  });

  // POST /api/flows — create a flow (manifest + prompt, optional skillIds/extensionIds)
  router.post("/", rateLimit(10), requireAdmin(), async (c) => {
    const user = c.get("user");

    const body = await c.req.json<{
      manifest: Record<string, unknown>;
      prompt: string;
      skillIds?: string[];
      extensionIds?: string[];
    }>();

    const { manifest, prompt, skillIds, extensionIds } = body;

    // Validate manifest
    const manifestResult = validateManifest(manifest);
    if (!manifestResult.valid) {
      return c.json(
        { error: "INVALID_MANIFEST", message: "Manifest invalide", details: manifestResult.errors },
        400,
      );
    }

    if (!prompt || !prompt.trim()) {
      return c.json({ error: "VALIDATION_ERROR", message: "Le prompt ne peut pas etre vide" }, 400);
    }

    const flowId = (manifest.metadata as { id: string }).id;
    const orgId = c.get("orgId");
    const existingIds = await getAllFlowIds(orgId);

    if (existingIds.includes(flowId)) {
      return c.json(
        { error: "NAME_COLLISION", message: `Un flow avec l'identifiant '${flowId}' existe deja` },
        400,
      );
    }

    // Store in DB
    await insertUserFlow(flowId, orgId, manifest, prompt);

    // Create skill/extension references
    if (skillIds && skillIds.length > 0) {
      await setFlowSkills(flowId, orgId, skillIds);
    }
    if (extensionIds && extensionIds.length > 0) {
      await setFlowExtensions(flowId, orgId, extensionIds);
    }

    // Create version + upload minimal ZIP to Storage (non-blocking)
    try {
      const zipBuffer = buildMinimalZip(manifest, prompt);
      await createVersionAndUpload(flowId, user.id, zipBuffer);
    } catch {
      // Storage upload failure is non-fatal — flow is persisted in DB
    }

    return c.json({ flowId, message: "Flow cree" }, 201);
  });

  // PUT /api/flows/:id — update manifest + prompt (optional skillIds/extensionIds)
  router.put("/:id", requireFlow(), requireAdmin(), requireMutableFlow(), async (c) => {
    const flow = c.get("flow");
    const user = c.get("user");
    const orgId = c.get("orgId");
    const flowId = flow.id;

    const body = await c.req.json<{
      manifest: Record<string, unknown>;
      prompt: string;
      updatedAt: string;
      skillIds?: string[];
      extensionIds?: string[];
    }>();

    const { manifest, prompt, updatedAt, skillIds, extensionIds } = body;

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
    const newId = (manifest.metadata as { id: string }).id;
    if (newId !== flowId) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: `metadata.id ne peut pas changer (actuel: '${flowId}', recu: '${newId}')`,
        },
        400,
      );
    }

    if (!prompt || !prompt.trim()) {
      return c.json({ error: "VALIDATION_ERROR", message: "Le prompt ne peut pas etre vide" }, 400);
    }

    // Update DB: manifest + prompt
    const updated = await updateUserFlow(flowId, { manifest, prompt }, updatedAt);
    if (!updated) {
      return c.json(
        {
          error: "CONFLICT",
          message: "Le flow a ete modifie depuis votre derniere lecture. Rechargez et reessayez.",
        },
        409,
      );
    }

    // Update skill/extension references if provided
    if (skillIds !== undefined) {
      await setFlowSkills(flowId, orgId, skillIds);
    }
    if (extensionIds !== undefined) {
      await setFlowExtensions(flowId, orgId, extensionIds);
    }

    // Create version + upload minimal ZIP
    try {
      const zipBuffer = buildMinimalZip(manifest, prompt);
      await createVersionAndUpload(flowId, user.id, zipBuffer);
    } catch {
      // Storage upload failure is non-fatal
    }

    return c.json({ flowId, message: "Flow mis a jour", updatedAt: updated.updated_at });
  });

  // PUT /api/flows/:id/package — upload a new ZIP for an existing user flow (retro-compat)
  // Parses the ZIP, upserts skills/extensions into the org library, creates references
  router.put("/:id/package", requireFlow(), requireAdmin(), requireMutableFlow(), async (c) => {
    const flow = c.get("flow");
    const user = c.get("user");
    const orgId = c.get("orgId");
    const flowId = flow.id;

    const formData = await c.req.formData();
    const file = formData.get("file");
    const updatedAt = formData.get("updatedAt") as string | null;

    if (!file || !(file instanceof File)) {
      return c.json({ error: "VALIDATION_ERROR", message: "Aucun fichier fourni" }, 400);
    }

    if (!file.name.endsWith(".zip")) {
      return c.json(
        { error: "VALIDATION_ERROR", message: "Seuls les fichiers .zip sont acceptes" },
        400,
      );
    }

    if (!updatedAt) {
      return c.json(
        { error: "VALIDATION_ERROR", message: "updatedAt est requis pour la mise a jour" },
        400,
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    let parsed;
    try {
      parsed = parseFlowZip(buffer);
    } catch (err) {
      if (err instanceof FlowImportError) {
        return c.json({ error: err.code, message: err.message, details: err.details }, 400);
      }
      throw err;
    }

    const { manifest, prompt, files } = parsed;

    // Ensure metadata.id matches the flow ID (immutable)
    const zipFlowId = (manifest.metadata as { id: string }).id;
    if (zipFlowId !== flowId) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: `metadata.id dans le ZIP ('${zipFlowId}') ne correspond pas au flow ('${flowId}')`,
        },
        400,
      );
    }

    // Update DB with new metadata from ZIP
    const updated = await updateUserFlow(flowId, { manifest, prompt }, updatedAt);
    if (!updated) {
      return c.json(
        {
          error: "CONFLICT",
          message: "Le flow a ete modifie depuis votre derniere lecture. Rechargez et reessayez.",
        },
        409,
      );
    }

    // Upsert skills/extensions from the ZIP into the org library + create references
    await upsertSkillsAndExtensionsFromFiles(files, flowId, orgId, user.id);

    // Create version + upload ZIP to Storage
    try {
      await createVersionAndUpload(flowId, user.id, buffer);
    } catch {
      // Storage upload failure is non-fatal
    }

    return c.json({ flowId, message: "Package mis a jour", updatedAt: updated.updated_at });
  });

  // PUT /api/flows/:id/skills — set skill references for a flow
  router.put("/:id/skills", requireFlow(), requireAdmin(), requireMutableFlow(), async (c) => {
    const flow = c.get("flow");
    const orgId = c.get("orgId");
    const flowId = flow.id;

    const body = await c.req.json<{ skillIds: string[] }>();
    const { skillIds } = body;

    if (!Array.isArray(skillIds)) {
      return c.json({ error: "VALIDATION_ERROR", message: "skillIds doit etre un tableau" }, 400);
    }

    try {
      await setFlowSkills(flowId, orgId, skillIds);
    } catch (err) {
      return c.json(
        { error: "VALIDATION_ERROR", message: err instanceof Error ? err.message : String(err) },
        400,
      );
    }

    return c.json({ flowId, skillIds, message: "References skills mises a jour" });
  });

  // PUT /api/flows/:id/extensions — set extension references for a flow
  router.put("/:id/extensions", requireFlow(), requireAdmin(), requireMutableFlow(), async (c) => {
    const flow = c.get("flow");
    const orgId = c.get("orgId");
    const flowId = flow.id;

    const body = await c.req.json<{ extensionIds: string[] }>();
    const { extensionIds } = body;

    if (!Array.isArray(extensionIds)) {
      return c.json(
        { error: "VALIDATION_ERROR", message: "extensionIds doit etre un tableau" },
        400,
      );
    }

    try {
      await setFlowExtensions(flowId, orgId, extensionIds);
    } catch (err) {
      return c.json(
        { error: "VALIDATION_ERROR", message: err instanceof Error ? err.message : String(err) },
        400,
      );
    }

    return c.json({ flowId, extensionIds, message: "References extensions mises a jour" });
  });

  // DELETE /api/flows/:id — delete a user flow (admin-only)
  router.delete("/:id", requireFlow(), requireAdmin(), requireMutableFlow(), async (c) => {
    const flow = c.get("flow");
    await deleteUserFlow(flow.id);
    return c.body(null, 204);
  });

  return router;
}
