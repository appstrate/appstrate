import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { parsePackageZip, PackageZipError } from "@appstrate/core/zip";
import { validateManifest } from "@appstrate/core/validation";
import { deletePackage, updatePackage, insertPackage } from "../services/user-flows.ts";
import { getAllPackageIds } from "../services/flow-service.ts";
import { createVersionAndUpload } from "../services/package-versions.ts";
import { buildMinimalZip } from "../services/package-storage.ts";
import { setFlowItems, SKILL_CONFIG, EXTENSION_CONFIG } from "../services/library.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requireAdmin, requireFlow, requireMutableFlow } from "../middleware/guards.ts";
import { logger } from "../lib/logger.ts";
import { extractDepsFromManifest } from "../lib/manifest-utils.ts";

/** Synchronise the junction table after save. */
async function syncFlowDepsJunctionTable(
  packageId: string,
  orgId: string,
  skillIds: string[],
  extensionIds: string[],
) {
  await setFlowItems(packageId, orgId, skillIds, SKILL_CONFIG);
  await setFlowItems(packageId, orgId, extensionIds, EXTENSION_CONFIG);
}

export function createUserFlowsRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/flows — create a flow (manifest + prompt)
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
        { error: "INVALID_MANIFEST", message: "Invalid manifest", details: manifestResult.errors },
        400,
      );
    }
    const validatedManifest = manifestResult.manifest;

    if (!prompt || !prompt.trim()) {
      return c.json({ error: "VALIDATION_ERROR", message: "Prompt cannot be empty" }, 400);
    }

    const packageId = validatedManifest.name;
    const orgId = c.get("orgId");
    const existingIds = await getAllPackageIds(orgId);

    if (existingIds.includes(packageId)) {
      return c.json(
        {
          error: "NAME_COLLISION",
          message: `A flow with identifier '${packageId}' already exists`,
        },
        400,
      );
    }

    // Extract dependency IDs from manifest
    const { skillIds, extensionIds } = extractDepsFromManifest(validatedManifest);

    // Store in DB
    await insertPackage(packageId, orgId, "flow", validatedManifest, prompt);

    // Sync junction table for dependency tracking
    await syncFlowDepsJunctionTable(packageId, orgId, skillIds, extensionIds);

    // Create version + upload minimal ZIP to Storage (non-blocking)
    try {
      const zipBuffer = buildMinimalZip(validatedManifest, prompt);
      await createVersionAndUpload(packageId, user.id, zipBuffer);
    } catch (error) {
      logger.warn("Version upload failed (non-fatal)", { packageId, error });
    }

    return c.json({ packageId, message: "Flow created" }, 201);
  });

  // PUT /api/flows/:scope/:name — update manifest + prompt
  router.put(
    "/:scope{@[^/]+}/:name",
    requireFlow(),
    requireAdmin(),
    requireMutableFlow(),
    async (c) => {
      const flow = c.get("flow");
      const user = c.get("user");
      const orgId = c.get("orgId");
      const packageId = flow.id;

      const body = await c.req.json<{
        manifest: Record<string, unknown>;
        prompt: string;
        updatedAt: string;
      }>();

      const { manifest, prompt, updatedAt } = body;

      if (!updatedAt) {
        return c.json(
          { error: "VALIDATION_ERROR", message: "updatedAt is required for updates" },
          400,
        );
      }

      // Validate manifest
      const manifestResult = validateManifest(manifest);
      if (!manifestResult.valid) {
        return c.json(
          {
            error: "INVALID_MANIFEST",
            message: "Invalid manifest",
            details: manifestResult.errors,
          },
          400,
        );
      }

      // Ensure ID immutability
      const newScopedName = (manifest as { name: string }).name;
      if (newScopedName !== packageId) {
        return c.json({ error: "VALIDATION_ERROR", message: "name cannot change" }, 400);
      }

      if (!prompt || !prompt.trim()) {
        return c.json({ error: "VALIDATION_ERROR", message: "Prompt cannot be empty" }, 400);
      }

      // Extract dependency IDs from manifest
      const { skillIds, extensionIds } = extractDepsFromManifest(manifest);

      // Update DB: manifest + prompt
      const updated = await updatePackage(packageId, { manifest, content: prompt }, updatedAt);
      if (!updated) {
        return c.json(
          {
            error: "CONFLICT",
            message: "Flow has been modified since your last read. Reload and try again.",
          },
          409,
        );
      }

      // Sync junction table for dependency tracking
      await syncFlowDepsJunctionTable(packageId, orgId, skillIds, extensionIds);

      // Create version + upload minimal ZIP
      try {
        const zipBuffer = buildMinimalZip(manifest, prompt);
        await createVersionAndUpload(packageId, user.id, zipBuffer);
      } catch (error) {
        logger.warn("Version upload failed (non-fatal)", { packageId, error });
      }

      return c.json({ packageId, message: "Flow updated", updatedAt: updated.updatedAt });
    },
  );

  // PUT /api/flows/:scope/:name/package — upload a new ZIP for an existing user flow
  router.put(
    "/:scope{@[^/]+}/:name/package",
    requireFlow(),
    requireAdmin(),
    requireMutableFlow(),
    async (c) => {
      const flow = c.get("flow");
      const user = c.get("user");
      const packageId = flow.id;

      const formData = await c.req.formData();
      const file = formData.get("file");
      const updatedAt = formData.get("updatedAt") as string | null;

      if (!file || !(file instanceof File)) {
        return c.json({ error: "VALIDATION_ERROR", message: "No file provided" }, 400);
      }

      if (!file.name.endsWith(".zip")) {
        return c.json({ error: "VALIDATION_ERROR", message: "Only .zip files are accepted" }, 400);
      }

      if (!updatedAt) {
        return c.json(
          { error: "VALIDATION_ERROR", message: "updatedAt is required for updates" },
          400,
        );
      }

      const buffer = Buffer.from(await file.arrayBuffer());

      let parsed;
      try {
        parsed = parsePackageZip(new Uint8Array(buffer));
      } catch (err) {
        if (err instanceof PackageZipError) {
          return c.json({ error: err.code, message: err.message, details: err.details }, 400);
        }
        throw err;
      }

      if (parsed.type !== "flow") {
        return c.json({ error: "INVALID_TYPE", message: "Expected type: flow" }, 400);
      }

      const { manifest, content } = parsed;

      // Ensure name matches the flow ID (immutable)
      const zipScopedName = (manifest as { name: string }).name;
      if (zipScopedName !== packageId) {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: `name in ZIP ('${zipScopedName}') does not match flow`,
          },
          400,
        );
      }

      // Update DB with new metadata from ZIP
      const updated = await updatePackage(packageId, { manifest, content }, updatedAt);
      if (!updated) {
        return c.json(
          {
            error: "CONFLICT",
            message: "Flow has been modified since your last read. Reload and try again.",
          },
          409,
        );
      }

      // Create version + upload ZIP to Storage
      try {
        await createVersionAndUpload(packageId, user.id, buffer);
      } catch (error) {
        logger.warn("Version upload failed (non-fatal)", { packageId, error });
      }

      return c.json({ packageId, message: "Package updated", updatedAt: updated.updatedAt });
    },
  );

  // PUT /api/flows/:scope/:name/skills — set skill references for a flow
  router.put(
    "/:scope{@[^/]+}/:name/skills",
    requireFlow(),
    requireAdmin(),
    requireMutableFlow(),
    async (c) => {
      const flow = c.get("flow");
      const orgId = c.get("orgId");
      const packageId = flow.id;

      const body = await c.req.json<{ skillIds: string[] }>();
      const { skillIds } = body;

      if (!Array.isArray(skillIds)) {
        return c.json({ error: "VALIDATION_ERROR", message: "skillIds must be an array" }, 400);
      }

      try {
        await setFlowItems(packageId, orgId, skillIds, SKILL_CONFIG);
      } catch (err) {
        return c.json(
          { error: "VALIDATION_ERROR", message: err instanceof Error ? err.message : String(err) },
          400,
        );
      }

      return c.json({ packageId, skillIds, message: "Skill references updated" });
    },
  );

  // PUT /api/flows/:scope/:name/extensions — set extension references for a flow
  router.put(
    "/:scope{@[^/]+}/:name/extensions",
    requireFlow(),
    requireAdmin(),
    requireMutableFlow(),
    async (c) => {
      const flow = c.get("flow");
      const orgId = c.get("orgId");
      const packageId = flow.id;

      const body = await c.req.json<{ extensionIds: string[] }>();
      const { extensionIds } = body;

      if (!Array.isArray(extensionIds)) {
        return c.json({ error: "VALIDATION_ERROR", message: "extensionIds must be an array" }, 400);
      }

      try {
        await setFlowItems(packageId, orgId, extensionIds, EXTENSION_CONFIG);
      } catch (err) {
        return c.json(
          { error: "VALIDATION_ERROR", message: err instanceof Error ? err.message : String(err) },
          400,
        );
      }

      return c.json({ packageId, extensionIds, message: "Extension references updated" });
    },
  );

  // DELETE /api/flows/:scope/:name — delete a user flow (admin-only)
  router.delete(
    "/:scope{@[^/]+}/:name",
    requireFlow(),
    requireAdmin(),
    requireMutableFlow(),
    async (c) => {
      const flow = c.get("flow");
      await deletePackage(flow.id);
      return c.body(null, 204);
    },
  );

  return router;
}
