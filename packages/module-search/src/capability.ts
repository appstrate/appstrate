// SPDX-License-Identifier: Apache-2.0

/**
 * Semantic-search capability detection.
 *
 * The `search_chunks.embedding` column is created by a GUARDED migration: it
 * exists when the pgvector extension is available (PGlite Tier 0 bundles it;
 * most managed Postgres ship it) and is silently absent otherwise. The module
 * probes once at init and every embedding read/write branches on the result —
 * a deployment without pgvector keeps working with keyword search.
 */

import { sql } from "drizzle-orm";
import { db, toRows } from "@appstrate/db/client";
import type { Logger } from "@appstrate/core/logger";

let semantic = false;

export function semanticSearchEnabled(): boolean {
  return semantic;
}

export async function detectSemanticCapability(logger: Logger): Promise<void> {
  try {
    const rows = toRows(
      await db.execute(
        sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'search_chunks' AND column_name = 'embedding'`,
      ),
    );
    semantic = rows.length > 0;
  } catch (err) {
    semantic = false;
    logger.warn("semantic capability probe failed — keyword search only", { err: String(err) });
    return;
  }
  if (semantic) {
    logger.info("search semantic mode enabled (pgvector + local embeddings)");
  } else {
    logger.warn("pgvector unavailable on this database — search degrades to keyword matching");
  }
}
