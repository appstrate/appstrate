// SPDX-License-Identifier: Apache-2.0

/**
 * Search API — one route: hybrid retrieval over the org's index.
 *
 * Auto-exposed over MCP through the `mcp` module's `invoke_operation` (the
 * OpenAPI doc is the contract), so the chat RAG path and agents query the same
 * surface. The `orgId` bound is mandatory on every query (ACL layer 1).
 */

import { Hono } from "hono";
import { z } from "zod";
import { requireModulePermission } from "@appstrate/core/permissions";
import { parseBody } from "@appstrate/core/api-errors";
import { searchChunksFor, type SearchHit } from "./search.ts";
import { logger } from "./logger.ts";

type SearchEnv = {
  Variables: {
    user: { id: string; email: string; name: string };
    orgId: string;
  };
};

const searchSchema = z.object({
  query: z.string().min(1).max(1000),
  limit: z.coerce.number().int().min(1).max(50).catch(10),
});

function toHitDto(hit: SearchHit) {
  return {
    object: "search_hit" as const,
    chunkId: hit.chunkId,
    storageObjectId: hit.storageObjectId,
    name: hit.name,
    chunkIndex: hit.chunkIndex,
    content: hit.content,
  };
}

export function createSearchRouter() {
  const router = new Hono<SearchEnv>();

  // POST /api/search — hybrid retrieval, ACL-filtered to the caller.
  router.post("/api/search", requireModulePermission("search", "read"), async (c) => {
    const { query, limit } = parseBody(searchSchema, await c.req.json());
    const hits = await searchChunksFor(
      query,
      { orgId: c.get("orgId"), userId: c.get("user").id },
      limit,
      logger,
    );
    return c.json({ object: "list", data: hits.map(toHitDto), hasMore: false });
  });

  return router;
}
