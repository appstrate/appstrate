import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { scopedNameRegex } from "@appstrate/core/validation";
import { setFlowItems, SKILL_CONFIG, EXTENSION_CONFIG } from "../services/package-items.ts";
import { requireAdmin, requireFlow, requireMutableFlow } from "../middleware/guards.ts";

export function createUserFlowsRouter() {
  const router = new Hono<AppEnv>();

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

      const invalidIds = skillIds.filter((id) => !scopedNameRegex.test(id));
      if (invalidIds.length > 0) {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: `Invalid skill IDs (must be scoped @scope/name): ${invalidIds.join(", ")}`,
          },
          400,
        );
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

      const invalidIds = extensionIds.filter((id) => !scopedNameRegex.test(id));
      if (invalidIds.length > 0) {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: `Invalid extension IDs (must be scoped @scope/name): ${invalidIds.join(", ")}`,
          },
          400,
        );
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

  return router;
}
