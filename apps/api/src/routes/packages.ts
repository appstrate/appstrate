import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { parsePackageZip, PackageZipError } from "@appstrate/validation/zip";
import { scopedNameToPackageId } from "@appstrate/validation/naming";
import { insertPackage } from "../services/user-flows.ts";
import { postInstallPackage } from "../services/post-install-package.ts";
import { getAllPackageIds } from "../services/flow-service.ts";
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
    const scopedName = manifest.name as string;
    const packageId = scopedNameToPackageId(scopedName);

    // Check collision
    const existingIds = await getAllPackageIds(orgId);
    if (existingIds.includes(packageId)) {
      return c.json(
        {
          error: "NAME_COLLISION",
          message: `A package with identifier '${packageId}' already exists`,
        },
        400,
      );
    }

    // Insert into DB (generic — works for all types)
    const displayName = (manifest.displayName as string | undefined) ?? scopedName.split("/")[1];
    await insertPackage(packageId, orgId, packageType, manifest, content, {
      name: scopedName,
      displayName,
    });

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

  return router;
}
