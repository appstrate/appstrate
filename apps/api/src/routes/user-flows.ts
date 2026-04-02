// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages } from "@appstrate/db/schema";
import type { AppEnv } from "../types/index.ts";
import { scopedNameRegex } from "@appstrate/core/validation";
import { requireFlow, requireMutableFlow } from "../middleware/guards.ts";
import { invalidRequest, parseBody } from "../lib/errors.ts";
import { asRecord } from "../lib/safe-json.ts";

const updateSkillsSchema = z.object({
  skillIds: z.array(z.string()).max(50),
});

const updateToolsSchema = z.object({
  toolIds: z.array(z.string()).max(50),
});

/** Update a dep section (skills or tools) in the manifest. */
async function updateManifestDeps(
  packageId: string,
  depKey: "skills" | "tools",
  ids: string[],
): Promise<void> {
  const [row] = await db
    .select({ draftManifest: packages.draftManifest })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);
  if (!row) return;

  const manifest = asRecord(row.draftManifest);
  const deps = asRecord(manifest.dependencies);
  const updated: Record<string, string> = {};
  for (const id of ids) updated[id] = "*";
  deps[depKey] = updated;
  manifest.dependencies = deps;

  await db
    .update(packages)
    .set({ draftManifest: manifest, updatedAt: new Date() })
    .where(eq(packages.id, packageId));
}

export function createUserFlowsRouter() {
  const router = new Hono<AppEnv>();

  // PUT /api/flows/:scope/:name/skills — set skill references for a flow
  router.put("/:scope{@[^/]+}/:name/skills", requireFlow(), requireMutableFlow(), async (c) => {
    const flow = c.get("flow");
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

    await updateManifestDeps(packageId, "skills", skillIds);

    return c.json({ packageId, skillIds, message: "Skill references updated" });
  });

  // PUT /api/flows/:scope/:name/tools — set tool references for a flow
  router.put("/:scope{@[^/]+}/:name/tools", requireFlow(), requireMutableFlow(), async (c) => {
    const flow = c.get("flow");
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

    await updateManifestDeps(packageId, "tools", toolIds);

    return c.json({ packageId, toolIds, message: "Tool references updated" });
  });

  return router;
}
