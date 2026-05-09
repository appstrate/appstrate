// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages } from "@appstrate/db/schema";
import type { AppEnv } from "../types/index.ts";
import { scopedNameRegex } from "@appstrate/core/validation";
import { caretRange } from "@appstrate/core/semver";
import { requireOrgAgent, requireMutableAgent } from "../middleware/guards.ts";
import { invalidRequest, parseBody } from "../lib/errors.ts";
import { asRecord } from "@appstrate/core/safe-json";
import { orgOrSystemFilter } from "../lib/package-helpers.ts";
export const updateSkillsSchema = z.object({
  skillIds: z.array(z.string()).max(50),
});

export const updateToolsSchema = z.object({
  toolIds: z.array(z.string()).max(50),
});

/**
 * Resolve each dep ID to its canonical caret range (`^X.Y.Z`) from the
 * org/system catalog. IDs whose row is missing or whose draft manifest
 * carries no version are dropped — better than persisting an
 * unresolvable wildcard, and `requireMutableAgent` already ensures the
 * caller intends a fresh deps section.
 */
async function resolveCaretRanges(orgId: string, ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const rows = await db
    .select({ id: packages.id, draftManifest: packages.draftManifest })
    .from(packages)
    .where(and(inArray(packages.id, ids), orgOrSystemFilter(orgId)));
  const result: Record<string, string> = {};
  for (const row of rows) {
    const version = asRecord(row.draftManifest).version;
    if (typeof version === "string") {
      result[row.id] = caretRange(version);
    }
  }
  return result;
}

/** Update a dep section (skills or tools) in the manifest. */
async function updateManifestDeps(
  orgId: string,
  packageId: string,
  depKey: "skills" | "tools",
  ids: string[],
): Promise<void> {
  const [row] = await db
    .select({ draftManifest: packages.draftManifest })
    .from(packages)
    .where(and(eq(packages.id, packageId), orgOrSystemFilter(orgId)))
    .limit(1);
  if (!row) return;

  const manifest = asRecord(row.draftManifest);
  const deps = asRecord(manifest.dependencies);
  deps[depKey] = await resolveCaretRanges(orgId, ids);
  manifest.dependencies = deps;

  await db
    .update(packages)
    .set({ draftManifest: manifest, updatedAt: new Date() })
    .where(and(eq(packages.id, packageId), eq(packages.orgId, orgId)));
}

export function createUserAgentsRouter() {
  const router = new Hono<AppEnv>();

  // PUT /api/agents/:scope/:name/skills — set skill references for an agent
  router.put(
    "/:scope{@[^/]+}/:name/skills",
    requireOrgAgent(),
    requireMutableAgent(),
    async (c) => {
      const agent = c.get("package");
      const packageId = agent.id;

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

      await updateManifestDeps(c.get("orgId"), packageId, "skills", skillIds);

      return c.json({ packageId, skillIds, message: "Skill references updated" });
    },
  );

  // PUT /api/agents/:scope/:name/tools — set tool references for an agent
  router.put("/:scope{@[^/]+}/:name/tools", requireOrgAgent(), requireMutableAgent(), async (c) => {
    const agent = c.get("package");
    const packageId = agent.id;

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

    await updateManifestDeps(c.get("orgId"), packageId, "tools", toolIds);

    return c.json({ packageId, toolIds, message: "Tool references updated" });
  });

  return router;
}
