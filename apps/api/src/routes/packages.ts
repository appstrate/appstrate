import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { parsePackageZip, PackageZipError } from "@appstrate/core/zip";
import { eq } from "drizzle-orm";
import { packages } from "@appstrate/db/schema";
import { db } from "../lib/db.ts";
import { getPackageById, insertPackage } from "../services/user-flows.ts";
import { postInstallPackage } from "../services/post-install-package.ts";
import { isBuiltInFlow } from "../services/flow-service.ts";
import { isBuiltInSkill, isBuiltInExtension } from "../services/builtin-library.ts";
import { publishPackage, PublishValidationError } from "../services/registry-publish.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requireAdmin } from "../middleware/guards.ts";
import { logger } from "../lib/logger.ts";

export function createPackagesRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/packages/import — import any package type from ZIP
  router.post("/import", rateLimit(10), requireAdmin(), async (c) => {
    const user = c.get("user");
    const orgId = c.get("orgId");

    const formData = await c.req.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return c.json({ error: "VALIDATION_ERROR", message: "No file provided" }, 400);
    }
    if (!file.name.endsWith(".zip")) {
      return c.json({ error: "VALIDATION_ERROR", message: "Only .zip files are accepted" }, 400);
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

    const { manifest, content, files, type: packageType } = parsed;
    const packageId = manifest.name as string;

    // Built-in packages are immutable
    const isBuiltIn =
      isBuiltInFlow(packageId) || isBuiltInSkill(packageId) || isBuiltInExtension(packageId);
    if (isBuiltIn) {
      return c.json(
        {
          error: "NAME_COLLISION",
          message: `'${packageId}' is a built-in package and cannot be overwritten`,
        },
        400,
      );
    }

    // Check for existing user package
    const existing = await getPackageById(packageId);

    if (existing) {
      if (existing.orgId !== orgId) {
        return c.json(
          {
            error: "NAME_COLLISION",
            message: `A package with identifier '${packageId}' already exists`,
          },
          400,
        );
      }
      if (existing.type !== packageType) {
        return c.json(
          {
            error: "TYPE_MISMATCH",
            message: `Package '${packageId}' exists as type '${existing.type}', cannot import as '${packageType}'`,
          },
          400,
        );
      }
      // Update existing package manifest and content
      await db
        .update(packages)
        .set({ manifest, content, updatedAt: new Date() })
        .where(eq(packages.id, packageId));
    } else {
      // New package — insert
      await insertPackage(packageId, orgId, packageType, manifest, content);
    }

    // Per-type post-install (version, library upsert, storage upload)
    await postInstallPackage({
      packageType,
      packageId,
      orgId,
      userId: user.id,
      content,
      files,
      zipBuffer: buffer,
    });

    logger.info("Package imported", { packageId, type: packageType, orgId });
    return c.json({ packageId, type: packageType }, 201);
  });

  // POST /api/packages/:scope/:name/publish — publish a package to registry
  router.post("/:scope{@[^/]+}/:name/publish", requireAdmin(), async (c) => {
    const user = c.get("user");
    const orgId = c.get("orgId");
    const packageId = `${c.req.param("scope")}/${c.req.param("name")}`;

    try {
      const result = await publishPackage(packageId, orgId, user.id);
      return c.json(result);
    } catch (err) {
      if (err instanceof PublishValidationError) {
        logger.warn("Publish validation error", {
          packageId,
          code: err.code,
          error: err.message,
        });
        return c.json({ error: err.code, message: err.message }, err.statusCode as 400 | 409 | 502);
      }
      const message = err instanceof Error ? err.message : "Failed to publish package";
      logger.error("Publish failed", { packageId, error: message });
      return c.json({ error: "PUBLISH_FAILED", message }, 500);
    }
  });

  return router;
}
