import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { scopedNameRegex } from "@appstrate/core/validation";
import { setFlowItems, SKILL_CONFIG, TOOL_CONFIG } from "../services/package-items/index.ts";
import { requireAdmin, requireFlow, requireMutableFlow } from "../middleware/guards.ts";
import { invalidRequest, parseBody } from "../lib/errors.ts";

const updateSkillsSchema = z.object({
  skillIds: z.array(z.string()).max(50),
});

const updateToolsSchema = z.object({
  toolIds: z.array(z.string()).max(50),
});

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

      const body = await c.req.json();
      const data = parseBody(updateSkillsSchema, body, "skillIds");
      const { skillIds } = data;

      const invalidIds = skillIds.filter((id) => !scopedNameRegex.test(id));
      if (invalidIds.length > 0) {
        throw invalidRequest(
          `Invalid skill IDs (must be scoped @scope/name): ${invalidIds.join(", ")}`,
          "skillIds",
        );
      }

      try {
        await setFlowItems(packageId, orgId, skillIds, SKILL_CONFIG);
      } catch (err) {
        throw invalidRequest(err instanceof Error ? err.message : String(err));
      }

      return c.json({ packageId, skillIds, message: "Skill references updated" });
    },
  );

  // PUT /api/flows/:scope/:name/tools — set tool references for a flow
  router.put(
    "/:scope{@[^/]+}/:name/tools",
    requireFlow(),
    requireAdmin(),
    requireMutableFlow(),
    async (c) => {
      const flow = c.get("flow");
      const orgId = c.get("orgId");
      const packageId = flow.id;

      const body = await c.req.json();
      const data = parseBody(updateToolsSchema, body, "toolIds");
      const { toolIds } = data;

      const invalidIds = toolIds.filter((id) => !scopedNameRegex.test(id));
      if (invalidIds.length > 0) {
        throw invalidRequest(
          `Invalid tool IDs (must be scoped @scope/name): ${invalidIds.join(", ")}`,
          "toolIds",
        );
      }

      try {
        await setFlowItems(packageId, orgId, toolIds, TOOL_CONFIG);
      } catch (err) {
        throw invalidRequest(err instanceof Error ? err.message : String(err));
      }

      return c.json({ packageId, toolIds, message: "Tool references updated" });
    },
  );

  return router;
}
