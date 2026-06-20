// SPDX-License-Identifier: Apache-2.0

/**
 * Hybrid org-scoped retrieval over the search index.
 *
 * Two retrievers run against the SAME WHERE clause (org bound + ACL:
 * org-visible OR private-and-owned — rights and ranking can never drift):
 *
 *   1. Semantic — pgvector cosine distance over local nomic embeddings
 *      (only when the capability is on).
 *   2. Lexical — Postgres full-text (`websearch_to_tsquery`, `simple` config:
 *      no language stemming, fits a multilingual corpus), with an ILIKE
 *      fallback for partial-word matches.
 *
 * Results merge with Reciprocal Rank Fusion (k=60, the standard constant),
 * then an optional local cross-encoder reranks the head.
 *
 * The ACL filter is on `search_chunks` columns ALONE — a single-table scan,
 * never a live JOIN against an ACL table (strategy §5bis). The join to
 * `search_items` only fetches display fields (the storage object id + name)
 * for the result; it carries no rights.
 */

import { and, eq, or, ilike, isNotNull, sql, cosineDistance, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { searchChunks, searchItems } from "@appstrate/db/schema";
import type { Logger } from "@appstrate/core/logger";
import { semanticSearchEnabled } from "./capability.ts";
import { embedQuery, rerank, rerankerEnabled } from "./inference.ts";

const CANDIDATES_PER_RETRIEVER = 30;
const RRF_K = 60;

export interface SearchHit {
  chunkId: string;
  /** The opaque storage object id — the consumer reads bytes by it. */
  storageObjectId: string;
  name: string | null;
  chunkIndex: number;
  content: string;
}

interface RankedHit extends SearchHit {
  rrfScore: number;
}

interface CallerIdentity {
  orgId: string;
  userId: string;
}

/** Org bound + ACL — shared verbatim by every retriever, on chunk columns. */
function aclWhere(caller: CallerIdentity): SQL {
  return and(
    eq(searchChunks.orgId, caller.orgId),
    or(
      eq(searchChunks.visibility, "org"),
      and(eq(searchChunks.visibility, "private"), eq(searchChunks.ownerId, caller.userId)),
    ),
  )!;
}

const hitColumns = {
  chunkId: searchChunks.id,
  storageObjectId: searchItems.storageObjectId,
  name: searchItems.name,
  chunkIndex: searchChunks.chunkIndex,
  content: searchChunks.content,
};

async function semanticRetrieve(query: string, caller: CallerIdentity): Promise<SearchHit[]> {
  const vector = await embedQuery(query);
  return db
    .select(hitColumns)
    .from(searchChunks)
    .innerJoin(searchItems, eq(searchItems.id, searchChunks.searchItemId))
    .where(and(aclWhere(caller), isNotNull(searchChunks.embedding)))
    .orderBy(cosineDistance(searchChunks.embedding, vector))
    .limit(CANDIDATES_PER_RETRIEVER);
}

async function lexicalRetrieve(query: string, caller: CallerIdentity): Promise<SearchHit[]> {
  const tsQuery = sql`websearch_to_tsquery('simple', ${query})`;
  const matches = await db
    .select(hitColumns)
    .from(searchChunks)
    .innerJoin(searchItems, eq(searchItems.id, searchChunks.searchItemId))
    .where(and(aclWhere(caller), sql`to_tsvector('simple', ${searchChunks.content}) @@ ${tsQuery}`))
    .orderBy(sql`ts_rank(to_tsvector('simple', ${searchChunks.content}), ${tsQuery}) DESC`)
    .limit(CANDIDATES_PER_RETRIEVER);
  if (matches.length > 0) return matches;

  // Partial-word fallback (e.g. a prefix the tokenizer won't match).
  return db
    .select(hitColumns)
    .from(searchChunks)
    .innerJoin(searchItems, eq(searchItems.id, searchChunks.searchItemId))
    .where(and(aclWhere(caller), ilike(searchChunks.content, `%${query.replaceAll("%", "\\%")}%`)))
    .orderBy(sql`length(${searchChunks.content}) asc`)
    .limit(CANDIDATES_PER_RETRIEVER);
}

/** Reciprocal Rank Fusion over the retrievers' ranked lists. */
function rrfMerge(lists: SearchHit[][]): RankedHit[] {
  const byId = new Map<string, RankedHit>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const entry = byId.get(hit.chunkId) ?? { ...hit, rrfScore: 0 };
      entry.rrfScore += 1 / (RRF_K + rank + 1);
      byId.set(hit.chunkId, entry);
    });
  }
  return [...byId.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}

export async function searchChunksFor(
  query: string,
  caller: CallerIdentity,
  limit: number,
  logger?: Logger,
): Promise<SearchHit[]> {
  const retrievers: Promise<SearchHit[]>[] = [lexicalRetrieve(query, caller)];
  if (semanticSearchEnabled()) {
    retrievers.push(
      semanticRetrieve(query, caller).catch((err) => {
        // Embedding/model failures must never take search down with them.
        logger?.warn("semantic retrieval failed — lexical only for this query", {
          err: String(err),
        });
        return [];
      }),
    );
  }

  let merged: SearchHit[] = rrfMerge(await Promise.all(retrievers));

  if (rerankerEnabled() && merged.length > 1) {
    const head = merged.slice(0, CANDIDATES_PER_RETRIEVER);
    const order = await rerank(
      query,
      head.map((h) => h.content),
      logger,
    );
    merged = [...order.map((i) => head[i]!), ...merged.slice(CANDIDATES_PER_RETRIEVER)];
  }

  return merged.slice(0, limit);
}
