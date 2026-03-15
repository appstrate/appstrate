import { Hono } from "hono";
import type { PackageType } from "../services/package-items/config.ts";
import type { AppEnv } from "../types/index.ts";
import {
  getMarketplaceStatus,
  searchMarketplace,
  getMarketplacePackageWithInstallStatus,
  installFromMarketplace,
  getInstalledRegistryPackages,
  checkRegistryUpdates,
} from "../services/marketplace.ts";
import { requireAdmin } from "../middleware/guards.ts";

export function createMarketplaceRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/marketplace/status — check registry connection status
  router.get("/status", async (c) => {
    const status = getMarketplaceStatus();
    return c.json(status);
  });

  // GET /api/marketplace/search — search packages in registry
  router.get("/search", async (c) => {
    const status = getMarketplaceStatus();
    if (!status.configured) {
      return c.json(
        { error: "REGISTRY_NOT_CONFIGURED", message: "No registry URL configured" },
        400,
      );
    }

    const q = c.req.query("q");
    const type = c.req.query("type");
    const sort = c.req.query("sort");
    const page = parseInt(c.req.query("page") || "1", 10);
    const perPage = parseInt(c.req.query("per_page") || "20", 10);

    try {
      const results = await searchMarketplace({
        q,
        type: type as PackageType | undefined,
        sort: sort as "relevance" | "downloads" | "recent" | undefined,
        page,
        perPage,
      });
      return c.json(results);
    } catch (err) {
      return c.json(
        { error: "REGISTRY_ERROR", message: err instanceof Error ? err.message : String(err) },
        502,
      );
    }
  });

  // GET /api/marketplace/installed — list installed registry packages
  router.get("/installed", async (c) => {
    const orgId = c.get("orgId");
    const installed = await getInstalledRegistryPackages(orgId);
    return c.json({ packages: installed });
  });

  // GET /api/marketplace/updates — check for updates
  router.get("/updates", async (c) => {
    const orgId = c.get("orgId");
    try {
      const updates = await checkRegistryUpdates(orgId);
      return c.json({ updates });
    } catch (err) {
      return c.json(
        { error: "REGISTRY_ERROR", message: err instanceof Error ? err.message : String(err) },
        502,
      );
    }
  });

  // POST /api/marketplace/update — update an installed package to latest (admin-only)
  router.post("/update", requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const user = c.get("user");

    const body = await c.req.json<{
      scope: string;
      name: string;
      accessToken?: string;
    }>();

    if (!body.scope || !body.name) {
      return c.json({ error: "VALIDATION_ERROR", message: "scope and name are required" }, 400);
    }

    try {
      const result = await installFromMarketplace(
        body.scope,
        body.name,
        undefined, // latest
        orgId,
        user.id,
        body.accessToken || undefined,
      );
      return c.json(result);
    } catch (err) {
      return c.json(
        { error: "UPDATE_ERROR", message: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  // GET /api/marketplace/packages/:scope/:name — package detail from registry (with install status)
  router.get("/packages/:scope/:name", async (c) => {
    const rawScope = c.req.param("scope");
    const name = c.req.param("name");
    const orgId = c.get("orgId");

    try {
      const pkg = await getMarketplacePackageWithInstallStatus(rawScope, name, orgId);
      return c.json(pkg);
    } catch (err) {
      return c.json(
        { error: "REGISTRY_ERROR", message: err instanceof Error ? err.message : String(err) },
        502,
      );
    }
  });

  // POST /api/marketplace/install — install a package from registry (admin-only)
  router.post("/install", requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const user = c.get("user");

    const body = await c.req.json<{
      scope: string;
      name: string;
      version?: string;
      accessToken?: string;
      force?: boolean;
    }>();

    if (!body.scope || !body.name) {
      return c.json({ error: "VALIDATION_ERROR", message: "scope and name are required" }, 400);
    }

    try {
      const result = await installFromMarketplace(
        body.scope,
        body.name,
        body.version,
        orgId,
        user.id,
        body.accessToken || undefined,
        body.force,
      );
      return c.json(result, 201);
    } catch (err) {
      return c.json(
        { error: "INSTALL_ERROR", message: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  return router;
}
