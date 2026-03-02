import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import type { AppEnv } from "../types/index.ts";
import { parsePackageZip, PackageZipError } from "@appstrate/validation/zip";
import { insertPackage } from "../services/user-flows.ts";
import { postInstallPackage } from "../services/post-install-package.ts";
import { getAllPackageIds } from "../services/flow-service.ts";
import { publishPackage } from "../services/registry-publish.ts";
import { getAuthenticatedRegistryClient } from "../services/registry-auth.ts";
import { db } from "../lib/db.ts";
import { packages } from "@appstrate/db/schema";
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
    await insertPackage(packageId, orgId, packageType, manifest, content);

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
      const body = await c.req.json<{
        version?: string;
      }>();
      if (!body.version?.trim()) {
        return c.json({ error: "VALIDATION_ERROR", message: "Version is required" }, 400);
      }

      const result = await publishPackage(packageId, orgId, user.id, {
        version: body.version.trim(),
      });
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to publish package";
      logger.error("Publish failed", { packageId, error: message });
      return c.json({ error: "PUBLISH_FAILED", message }, 500);
    }
  });

  // GET /api/packages/:scope/:name/publish-info — get publish info for modal
  router.get("/:scope{@[^/]+}/:name/publish-info", async (c) => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const packageId = `${c.req.param("scope")}/${c.req.param("name")}`;

    const [pkg] = await db
      .select({
        manifest: packages.manifest,
        registryScope: packages.registryScope,
        registryName: packages.registryName,
        lastPublishedVersion: packages.lastPublishedVersion,
        lastPublishedAt: packages.lastPublishedAt,
      })
      .from(packages)
      .where(and(eq(packages.id, packageId), eq(packages.orgId, orgId)))
      .limit(1);

    if (!pkg) {
      return c.json({ error: "NOT_FOUND", message: "Package not found" }, 404);
    }

    // Optionally fetch registry scopes if connected
    let registryScopes: { name: string; ownerId: string }[] | undefined;
    const client = await getAuthenticatedRegistryClient(user.id);
    if (client) {
      try {
        registryScopes = await client.getMyScopes();
      } catch {
        // Ignore — scopes fetch is best-effort
      }
    }

    return c.json({
      ...pkg,
      lastPublishedAt: pkg.lastPublishedAt?.toISOString() ?? null,
      registryScopes,
    });
  });

  return router;
}
