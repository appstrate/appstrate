// SPDX-License-Identifier: Apache-2.0

/**
 * The MCP Skills extension (SEP-2640) as REST, for `appstrate code sync`, whose
 * CLI token is bound to the API, not to an MCP resource. Every route calls the
 * skill server the MCP endpoint serves (`./skills.ts`), for the space the
 * request names (`X-Space-Id`) and behind `skills:read`:
 *
 * - `GET /api/mcp/skills`: the entries of `skills/list`; with
 *   `?definition=draft`, the entries of the drafts the caller may read, at
 *   their `@draft` URIs (those `skills/get` serves);
 * - `GET /api/mcp/skills/archive?uri=`: a ZIP of every file `resources/read`
 *   serves for the skill whose `SKILL.md` is at `uri`, so a sync reads one
 *   skill in one request.
 *
 * The paths sit under the module's `/api/mcp` and outside `/api/mcp/o`, the
 * RFC 8707 resource family, so they take the token every other REST route takes.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { enterSpaceContext } from "@appstrate/core/permissions";
import type { AppEnv } from "../../types/index.ts";
import { invalidRequest, notFound } from "../../lib/errors.ts";
import { listResponse } from "../../lib/list-response.ts";
import { logger } from "../../lib/logger.ts";
import { rateLimit } from "../../middleware/rate-limit.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import { resolveSkillRead, type SkillReadSpace } from "../../services/skill-read.ts";
import { listActivePackages } from "../../services/space-packages.ts";
import { SKILL_MAX_TOTAL_BYTES } from "@appstrate/core/skill-uri";
import { zipArtifact } from "@appstrate/core/zip";
import { createServedSkillCache } from "./skill-cache.ts";
import { buildSkillServer, type SkillServer } from "./skills.ts";

const SKILLS_REST_PATH = "/api/mcp/skills";

/**
 * The published skills served by this process, shared by every request: room
 * for four skills at the SEP-2640 size limit, and for hundreds of skills of a
 * few hundred KiB, the size skills usually have.
 */
const servedSkills = createServedSkillCache(4 * SKILL_MAX_TOTAL_BYTES);

/** The skill server over `spaces`, each read with the caller's permissions in that space. */
export function skillServerFor(c: Context<AppEnv>, spaces: readonly SkillReadSpace[]): SkillServer {
  const bySpace = new Map(spaces.map((space) => [space.spaceId, space]));
  return buildSkillServer({
    spaceIds: [...bySpace.keys()],
    // Published: a system skill's stored tree, or a `latest` dist-tag. Draft: any
    // organization skill (a system skill has none).
    listActiveSkillIds: async (spaceId, definition) =>
      (await listActivePackages(bySpace.get(spaceId)!, "skill"))
        .filter((row) =>
          definition === "draft"
            ? row.source !== "system"
            : row.source === "system" || row.latestVersionId !== null,
        )
        .map((row) => row.id),
    readSkill: (spaceId, packageId, definition) =>
      resolveSkillRead(c, bySpace.get(spaceId)!, packageId, definition),
    cache: servedSkills,
    logUnservable: (event) =>
      logger.warn("mcp.skill_unservable", { requestId: c.get("requestId"), ...event }),
  });
}

/** The skill server of the space the request entered. */
function requestSkillServer(c: Context<AppEnv>): SkillServer {
  return skillServerFor(c, [
    { orgId: c.get("orgId"), spaceId: c.get("space")!.id, permissions: c.get("permissions")! },
  ]);
}

function uriParam(c: Context<AppEnv>): string {
  const uri = c.req.query("uri");
  if (!uri) throw invalidRequest("The `uri` query parameter is required", "uri");
  return uri;
}

export function createSkillRouter(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const enterSpace = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    await enterSpaceContext(c);
    return next();
  };
  // `/x/*` matches `/x` too: the list and the read by URI.
  app.use(`${SKILLS_REST_PATH}/*`, rateLimit(50));
  app.use(`${SKILLS_REST_PATH}/*`, enterSpace);
  app.use(`${SKILLS_REST_PATH}/*`, requirePermission("skills", "read"));

  app.get(SKILLS_REST_PATH, async (c) => {
    const definition = c.req.query("definition") ?? "published";
    if (definition !== "published" && definition !== "draft") {
      throw invalidRequest("`definition` must be `published` or `draft`", "definition");
    }
    return c.json(listResponse(await requestSkillServer(c).list(definition)));
  });

  app.get(`${SKILLS_REST_PATH}/archive`, async (c) => {
    const uri = uriParam(c);
    const files = await requestSkillServer(c).skillFiles(uri);
    if (!files) throw notFound(`No skill readable at ${uri}`);
    return new Response(new Uint8Array(zipArtifact(files)), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-cache",
      },
    });
  });
  return app;
}
