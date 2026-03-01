import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import {
  getMarketplaceStatus,
  searchMarketplace,
  getMarketplacePackage,
  installFromMarketplace,
  MissingDependencyError,
} from "../services/marketplace.ts";
import { requireAdmin } from "../middleware/guards.ts";
import { normalizeScope } from "@appstrate/validation/naming";

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
        type: type as "flow" | "skill" | "extension" | undefined,
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

  // GET /api/marketplace/packages/:scope/:name — package detail from registry
  router.get("/packages/:scope/:name", async (c) => {
    const rawScope = c.req.param("scope");
    const scope = normalizeScope(rawScope);
    const name = c.req.param("name");

    try {
      const pkg = await getMarketplacePackage(scope, name);
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
      );
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof MissingDependencyError) {
        return c.json(
          {
            error: "MISSING_DEPENDENCIES",
            message: err.message,
            missing: err.missing,
          },
          400,
        );
      }
      return c.json(
        { error: "INSTALL_ERROR", message: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  return router;
}
