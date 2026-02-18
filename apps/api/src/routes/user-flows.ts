import { Hono } from "hono";
import { unzipSync } from "fflate";
import type { AppEnv } from "../types/index.ts";
import { importFlowFromZip, parseFlowZip, FlowImportError } from "../services/flow-import.ts";
import { deleteUserFlow, updateUserFlow, insertUserFlow } from "../services/user-flows.ts";
import { validateManifest } from "../services/schema.ts";
import { getAllFlowIds } from "../services/flow-service.ts";
import { createVersionAndUpload } from "../services/flow-versions.ts";
import {
  buildMinimalZip,
  rebuildPackageWithNewManifestAndPrompt,
  addExtractedZipToPackage,
  addFileToPackage,
  removeFilesFromPackage,
  stripZipDirectoryWrapper,
} from "../services/flow-package.ts";
import { extractSkillMeta } from "../services/skill-utils.ts";
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
      return c.json({ flowId: result.flowId, message: "Flow importe" }, 201);
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

  // POST /api/flows — create a flow (manifest + prompt only, no skills/extensions)
  router.post("/", rateLimit(10), requireAdmin(), async (c) => {
    const user = c.get("user");

    const body = await c.req.json<{
      manifest: Record<string, unknown>;
      prompt: string;
    }>();

    const { manifest, prompt } = body;

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

    const flowId = (manifest.metadata as { name: string }).name;
    const orgId = c.get("orgId");
    const existingIds = await getAllFlowIds(orgId);

    if (existingIds.includes(flowId)) {
      return c.json(
        { error: "NAME_COLLISION", message: `Un flow avec l'identifiant '${flowId}' existe deja` },
        400,
      );
    }

    // Store in DB (skills + extensions metadata live inside manifest.requires)
    await insertUserFlow(flowId, orgId, manifest, prompt);

    // Create version + upload minimal ZIP to Storage (non-blocking)
    try {
      const zipBuffer = buildMinimalZip(manifest, prompt);
      await createVersionAndUpload(flowId, user.id, zipBuffer);
    } catch {
      // Storage upload failure is non-fatal — flow is persisted in DB
    }

    return c.json({ flowId, message: "Flow cree" }, 201);
  });

  // PUT /api/flows/:id — update manifest + prompt (preserves skills/extensions in ZIP)
  router.put("/:id", requireFlow(), requireAdmin(), requireMutableFlow(), async (c) => {
    const flow = c.get("flow");
    const user = c.get("user");
    const flowId = flow.id;

    const body = await c.req.json<{
      manifest: Record<string, unknown>;
      prompt: string;
      updatedAt: string;
    }>();

    const { manifest, prompt, updatedAt } = body;

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

    if (!prompt || !prompt.trim()) {
      return c.json({ error: "VALIDATION_ERROR", message: "Le prompt ne peut pas etre vide" }, 400);
    }

    // Preserve existing skills/extensions if the client didn't send them
    const manifestRequires = (manifest.requires ?? {}) as Record<string, unknown>;
    if (!manifestRequires.skills) {
      manifestRequires.skills = flow.manifest.requires.skills ?? [];
    }
    if (!manifestRequires.extensions) {
      manifestRequires.extensions = flow.manifest.requires.extensions ?? [];
    }

    // Update DB: only manifest + prompt (skills/extensions metadata in manifest.requires)
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

    // Rebuild ZIP: replace manifest.json + prompt.md in existing ZIP, preserve skills/extensions files
    try {
      const zipBuffer = await rebuildPackageWithNewManifestAndPrompt(flowId, manifest, prompt);
      await createVersionAndUpload(flowId, user.id, zipBuffer);
    } catch {
      // Storage upload failure is non-fatal — flow is persisted in DB
    }

    return c.json({ flowId, message: "Flow mis a jour", updatedAt: updated.updated_at });
  });

  // PUT /api/flows/:id/package — upload a new ZIP for an existing user flow (full replace)
  router.put("/:id/package", requireFlow(), requireAdmin(), requireMutableFlow(), async (c) => {
    const flow = c.get("flow");
    const user = c.get("user");
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

    const { manifest, prompt } = parsed;

    // Ensure metadata.name matches the flow ID (immutable)
    const zipFlowId = (manifest.metadata as { name: string }).name;
    if (zipFlowId !== flowId) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: `metadata.name dans le ZIP ('${zipFlowId}') ne correspond pas au flow ('${flowId}')`,
        },
        400,
      );
    }

    // Update DB with new metadata from ZIP (skills + extensions inside manifest.requires)
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

    // Create version + upload ZIP to Storage
    try {
      await createVersionAndUpload(flowId, user.id, buffer);
    } catch {
      // Storage upload failure is non-fatal — flow is persisted in DB
    }

    return c.json({ flowId, message: "Package mis a jour", updatedAt: updated.updated_at });
  });

  // POST /api/flows/:id/skills — add a skill to a user flow (upload ZIP)
  router.post("/:id/skills", requireFlow(), requireAdmin(), requireMutableFlow(), async (c) => {
    const flow = c.get("flow");
    const user = c.get("user");
    const flowId = flow.id;

    const formData = await c.req.formData();
    const file = formData.get("file");
    const updatedAt = formData.get("updatedAt") as string | null;

    if (!updatedAt) {
      return c.json({ error: "VALIDATION_ERROR", message: "updatedAt est requis" }, 400);
    }

    if (!file || !(file instanceof File)) {
      return c.json({ error: "VALIDATION_ERROR", message: "Fichier .zip requis" }, 400);
    }

    if (!file.name.endsWith(".zip")) {
      return c.json(
        { error: "VALIDATION_ERROR", message: "Seuls les fichiers .zip sont acceptes" },
        400,
      );
    }

    const skillId = file.name.replace(/\.zip$/, "");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(skillId)) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: "Nom de fichier invalide (slug kebab-case requis, ex: web-search.zip)",
        },
        400,
      );
    }

    const existingSkills = flow.skills ?? [];
    if (existingSkills.some((s) => s.id === skillId)) {
      return c.json(
        { error: "VALIDATION_ERROR", message: `Le skill '${skillId}' existe deja` },
        400,
      );
    }

    // Unzip uploaded file and validate contents
    const uploadedBuffer = Buffer.from(await file.arrayBuffer());
    let normalizedFiles: Record<string, Uint8Array>;
    try {
      const rawFiles = unzipSync(new Uint8Array(uploadedBuffer));
      normalizedFiles = stripZipDirectoryWrapper(rawFiles);
    } catch {
      return c.json({ error: "VALIDATION_ERROR", message: "Fichier ZIP invalide" }, 400);
    }

    // Must contain SKILL.md at root (after stripping directory wrapper)
    if (!normalizedFiles["SKILL.md"]) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: "Le ZIP doit contenir un fichier SKILL.md a la racine",
        },
        400,
      );
    }

    const skillContent = new TextDecoder().decode(normalizedFiles["SKILL.md"]);
    const { name, description } = extractSkillMeta(skillContent);

    // Modify ZIP: extract uploaded ZIP contents under skills/{skillId}/
    const zipBuffer = await addExtractedZipToPackage(flowId, `skills/${skillId}/`, uploadedBuffer);

    // Update manifest.requires.skills (source of truth)
    const newSkills = [
      ...existingSkills,
      { id: skillId, ...(name ? { name } : {}), ...(description ? { description } : {}) },
    ];
    const updatedManifest = {
      ...(flow.manifest as unknown as Record<string, unknown>),
      requires: {
        ...flow.manifest.requires,
        skills: newSkills,
      },
    };

    const updated = await updateUserFlow(
      flowId,
      { manifest: updatedManifest, prompt: flow.prompt },
      updatedAt,
    );
    if (!updated) {
      return c.json(
        {
          error: "CONFLICT",
          message: "Le flow a ete modifie depuis votre derniere lecture. Rechargez et reessayez.",
        },
        409,
      );
    }

    // Create version + upload ZIP
    try {
      await createVersionAndUpload(flowId, user.id, zipBuffer);
    } catch {
      // Storage failure is non-fatal
    }

    return c.json({ flowId, skillId, message: "Skill ajoute", updatedAt: updated.updated_at });
  });

  // PUT /api/flows/:id/skills/:skillId — update skill name/description
  router.put(
    "/:id/skills/:skillId",
    requireFlow(),
    requireAdmin(),
    requireMutableFlow(),
    async (c) => {
      const flow = c.get("flow");
      const user = c.get("user");
      const flowId = flow.id;
      const skillId = c.req.param("skillId");

      const body = await c.req.json<{
        name?: string;
        description?: string;
        updatedAt: string;
      }>();

      const { name, description, updatedAt } = body;

      if (!updatedAt) {
        return c.json({ error: "VALIDATION_ERROR", message: "updatedAt est requis" }, 400);
      }

      const existingSkills = flow.skills ?? [];
      if (!existingSkills.some((s) => s.id === skillId)) {
        return c.json(
          { error: "VALIDATION_ERROR", message: `Le skill '${skillId}' n'existe pas` },
          404,
        );
      }

      const newSkills = existingSkills.map((s) =>
        s.id === skillId
          ? {
              ...s,
              ...(name !== undefined ? { name: name || undefined } : {}),
              ...(description !== undefined ? { description: description || undefined } : {}),
            }
          : s,
      );

      // Update manifest.requires.skills (source of truth)
      const updatedManifest = {
        ...(flow.manifest as unknown as Record<string, unknown>),
        requires: {
          ...flow.manifest.requires,
          skills: newSkills,
        },
      };

      const updated = await updateUserFlow(
        flowId,
        { manifest: updatedManifest, prompt: flow.prompt },
        updatedAt,
      );
      if (!updated) {
        return c.json(
          {
            error: "CONFLICT",
            message: "Le flow a ete modifie depuis votre derniere lecture. Rechargez et reessayez.",
          },
          409,
        );
      }

      // Rebuild ZIP with updated manifest + create version + upload
      try {
        const zipBuffer = await rebuildPackageWithNewManifestAndPrompt(
          flowId,
          updatedManifest,
          flow.prompt,
        );
        await createVersionAndUpload(flowId, user.id, zipBuffer);
      } catch {
        // Storage failure is non-fatal
      }

      return c.json({ flowId, skillId, updatedAt: updated.updated_at });
    },
  );

  // DELETE /api/flows/:id/skills/:skillId — remove a skill from a user flow
  router.delete(
    "/:id/skills/:skillId",
    requireFlow(),
    requireAdmin(),
    requireMutableFlow(),
    async (c) => {
      const flow = c.get("flow");
      const user = c.get("user");
      const flowId = flow.id;
      const skillId = c.req.param("skillId");

      const updatedAt = c.req.query("updatedAt");
      if (!updatedAt) {
        return c.json({ error: "VALIDATION_ERROR", message: "updatedAt est requis" }, 400);
      }

      const existingSkills = flow.skills ?? [];
      if (!existingSkills.some((s) => s.id === skillId)) {
        return c.json(
          { error: "VALIDATION_ERROR", message: `Le skill '${skillId}' n'existe pas` },
          400,
        );
      }

      // Modify ZIP
      const zipBuffer = await removeFilesFromPackage(flowId, `skills/${skillId}/`);

      // Update manifest.requires.skills (source of truth)
      const newSkills = existingSkills.filter((s) => s.id !== skillId);
      const updatedManifest = {
        ...(flow.manifest as unknown as Record<string, unknown>),
        requires: {
          ...flow.manifest.requires,
          skills: newSkills,
        },
      };

      const updated = await updateUserFlow(
        flowId,
        { manifest: updatedManifest, prompt: flow.prompt },
        updatedAt,
      );
      if (!updated) {
        return c.json(
          {
            error: "CONFLICT",
            message: "Le flow a ete modifie depuis votre derniere lecture. Rechargez et reessayez.",
          },
          409,
        );
      }

      // Create version + upload ZIP
      try {
        await createVersionAndUpload(flowId, user.id, zipBuffer);
      } catch {
        // Storage failure is non-fatal
      }

      return c.json({ flowId, message: "Skill supprime", updatedAt: updated.updated_at });
    },
  );

  // POST /api/flows/:id/extensions — add an extension to a user flow (upload ZIP)
  router.post("/:id/extensions", requireFlow(), requireAdmin(), requireMutableFlow(), async (c) => {
    const flow = c.get("flow");
    const user = c.get("user");
    const flowId = flow.id;

    const formData = await c.req.formData();
    const file = formData.get("file");
    const updatedAt = formData.get("updatedAt") as string | null;

    if (!updatedAt) {
      return c.json({ error: "VALIDATION_ERROR", message: "updatedAt est requis" }, 400);
    }

    if (!file || !(file instanceof File)) {
      return c.json({ error: "VALIDATION_ERROR", message: "Fichier .zip requis" }, 400);
    }

    if (!file.name.endsWith(".zip")) {
      return c.json(
        { error: "VALIDATION_ERROR", message: "Seuls les fichiers .zip sont acceptes" },
        400,
      );
    }

    const extId = file.name.replace(/\.zip$/, "");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(extId)) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: "Nom de fichier invalide (slug kebab-case requis, ex: web-fetch.zip)",
        },
        400,
      );
    }

    const existingExtensions = flow.extensions ?? [];
    if (existingExtensions.some((e) => e.id === extId)) {
      return c.json(
        { error: "VALIDATION_ERROR", message: `L'extension '${extId}' existe deja` },
        400,
      );
    }

    // Unzip uploaded file and validate contents
    const uploadedBuffer = Buffer.from(await file.arrayBuffer());
    let normalizedFiles: Record<string, Uint8Array>;
    try {
      const rawFiles = unzipSync(new Uint8Array(uploadedBuffer));
      normalizedFiles = stripZipDirectoryWrapper(rawFiles);
    } catch {
      return c.json({ error: "VALIDATION_ERROR", message: "Fichier ZIP invalide" }, 400);
    }

    // Must contain index.ts at root (after stripping directory wrapper)
    if (!normalizedFiles["index.ts"]) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: "Le ZIP doit contenir un fichier 'index.ts' a la racine",
        },
        400,
      );
    }

    // Modify ZIP: add index.ts as extensions/{extId}.ts
    const zipBuffer = await addFileToPackage(
      flowId,
      `extensions/${extId}.ts`,
      normalizedFiles["index.ts"]!,
    );

    // Update manifest.requires.extensions (source of truth)
    const newExtensions = [...existingExtensions, { id: extId }];
    const updatedManifest = {
      ...(flow.manifest as unknown as Record<string, unknown>),
      requires: {
        ...flow.manifest.requires,
        extensions: newExtensions,
      },
    };

    const updated = await updateUserFlow(
      flowId,
      { manifest: updatedManifest, prompt: flow.prompt },
      updatedAt,
    );
    if (!updated) {
      return c.json(
        {
          error: "CONFLICT",
          message: "Le flow a ete modifie depuis votre derniere lecture. Rechargez et reessayez.",
        },
        409,
      );
    }

    // Create version + upload ZIP
    try {
      await createVersionAndUpload(flowId, user.id, zipBuffer);
    } catch {
      // Storage failure is non-fatal
    }

    return c.json({
      flowId,
      extensionId: extId,
      message: "Extension ajoutee",
      updatedAt: updated.updated_at,
    });
  });

  // DELETE /api/flows/:id/extensions/:extId — remove an extension from a user flow
  router.delete(
    "/:id/extensions/:extId",
    requireFlow(),
    requireAdmin(),
    requireMutableFlow(),
    async (c) => {
      const flow = c.get("flow");
      const user = c.get("user");
      const flowId = flow.id;
      const extId = c.req.param("extId");

      const updatedAt = c.req.query("updatedAt");
      if (!updatedAt) {
        return c.json({ error: "VALIDATION_ERROR", message: "updatedAt est requis" }, 400);
      }

      const existingExtensions = flow.extensions ?? [];
      if (!existingExtensions.some((e) => e.id === extId)) {
        return c.json(
          { error: "VALIDATION_ERROR", message: `L'extension '${extId}' n'existe pas` },
          400,
        );
      }

      // Modify ZIP
      const zipBuffer = await removeFilesFromPackage(flowId, `extensions/${extId}.ts`);

      // Update manifest.requires.extensions (source of truth)
      const newExtensions = existingExtensions.filter((e) => e.id !== extId);
      const updatedManifest = {
        ...(flow.manifest as unknown as Record<string, unknown>),
        requires: {
          ...flow.manifest.requires,
          extensions: newExtensions,
        },
      };

      const updated = await updateUserFlow(
        flowId,
        { manifest: updatedManifest, prompt: flow.prompt },
        updatedAt,
      );
      if (!updated) {
        return c.json(
          {
            error: "CONFLICT",
            message: "Le flow a ete modifie depuis votre derniere lecture. Rechargez et reessayez.",
          },
          409,
        );
      }

      // Create version + upload ZIP
      try {
        await createVersionAndUpload(flowId, user.id, zipBuffer);
      } catch {
        // Storage failure is non-fatal
      }

      return c.json({ flowId, message: "Extension supprimee", updatedAt: updated.updated_at });
    },
  );

  // PUT /api/flows/:id/extensions/:extId — update extension name/description
  router.put(
    "/:id/extensions/:extId",
    requireFlow(),
    requireAdmin(),
    requireMutableFlow(),
    async (c) => {
      const flow = c.get("flow");
      const user = c.get("user");
      const flowId = flow.id;
      const extId = c.req.param("extId");

      const body = await c.req.json<{
        name?: string;
        description?: string;
        updatedAt: string;
      }>();

      const { name, description, updatedAt } = body;

      if (!updatedAt) {
        return c.json({ error: "VALIDATION_ERROR", message: "updatedAt est requis" }, 400);
      }

      const existingExtensions = flow.extensions ?? [];
      if (!existingExtensions.some((e) => e.id === extId)) {
        return c.json(
          { error: "VALIDATION_ERROR", message: `L'extension '${extId}' n'existe pas` },
          404,
        );
      }

      const newExtensions = existingExtensions.map((e) =>
        e.id === extId
          ? {
              ...e,
              ...(name !== undefined ? { name: name || undefined } : {}),
              ...(description !== undefined ? { description: description || undefined } : {}),
            }
          : e,
      );

      const updatedManifest = {
        ...(flow.manifest as unknown as Record<string, unknown>),
        requires: {
          ...flow.manifest.requires,
          extensions: newExtensions,
        },
      };

      const updated = await updateUserFlow(
        flowId,
        { manifest: updatedManifest, prompt: flow.prompt },
        updatedAt,
      );
      if (!updated) {
        return c.json(
          {
            error: "CONFLICT",
            message: "Le flow a ete modifie depuis votre derniere lecture. Rechargez et reessayez.",
          },
          409,
        );
      }

      // Rebuild ZIP manifest + create version
      try {
        const zipBuffer = await rebuildPackageWithNewManifestAndPrompt(
          flowId,
          updatedManifest,
          flow.prompt,
        );
        await createVersionAndUpload(flowId, user.id, zipBuffer);
      } catch {
        // Storage failure is non-fatal
      }

      return c.json({ flowId, extensionId: extId, updatedAt: updated.updated_at });
    },
  );

  // DELETE /api/flows/:id — delete a user flow (admin-only)
  router.delete("/:id", requireFlow(), requireAdmin(), requireMutableFlow(), async (c) => {
    const flow = c.get("flow");
    await deleteUserFlow(flow.id);
    return c.body(null, 204);
  });

  return router;
}
