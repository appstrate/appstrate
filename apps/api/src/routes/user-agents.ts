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
import { buildAgentDetailDto } from "./agent-detail-handler.ts";
import { internalError, invalidRequest, parseBody } from "../lib/errors.ts";
import { logger } from "../lib/logger.ts";
import { asRecord } from "@appstrate/core/safe-json";
import { orgOrSystemFilter } from "../lib/package-helpers.ts";
import { SCOPED_PACKAGE_ROUTE } from "./scoped-package-route.ts";
export const updateSkillsSchema = z.object({
  skillIds: z.array(z.string()).max(50),
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

/** Update the skills dep section in the manifest. */
async function updateManifestDeps(orgId: string, packageId: string, ids: string[]): Promise<void> {
  const [row] = await db
    .select({ draftManifest: packages.draftManifest })
    .from(packages)
    .where(and(eq(packages.id, packageId), orgOrSystemFilter(orgId)))
    .limit(1);
  if (!row) return;

  const manifest = asRecord(row.draftManifest);
  const deps = asRecord(manifest.dependencies);
  deps.skills = await resolveCaretRanges(orgId, ids);
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
    `/${SCOPED_PACKAGE_ROUTE}/skills`,
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

      await updateManifestDeps(c.get("orgId"), packageId, skillIds);

      // Return the updated agent resource bare — same serializer as the GET
      // agent detail (issue #657). The new skill references appear in
      // `dependencies.skills`. `requireAccess: false`: the caller just wrote
      // this agent in their org, so the app-install gate must not 404 a
      // successful write.
      const detail = await buildAgentDetailDto(c, { itemId: packageId, requireAccess: false });
      if (!detail) {
        logger.error("Updated agent could not be re-read", {
          packageId,
          orgId: c.get("orgId"),
        });
        throw internalError();
      }
      return c.json(detail);
    },
  );

  return router;
}
