// SPDX-License-Identifier: Apache-2.0

/**
 * Search ingestion pipeline — the storage→search seam in motion.
 *
 * Flow (strategy §5): storage emits an object event → search reacts. Reads are
 * by OPAQUE id over storage's public API (`readStorageObject`, loopback), never
 * a JOIN. The ACL is denormalised onto the index and RE-SYNCED on
 * `object.acl_changed` (the Onyx pitfall this whole split is built to avoid).
 *
 * The heavy work (extract → chunk → embed) runs on a job queue (`services.
 * queues`, BullMQ under Redis / in-memory otherwise) so a storage upsert never
 * blocks on indexing: the event handler upserts a `pending` registry row and
 * enqueues; the worker drains.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { searchChunks, searchItems } from "@appstrate/db/schema";
import { extractText } from "@appstrate/core/extraction";
import type { Logger } from "@appstrate/core/logger";
import type {
  ModuleInitContext,
  ModuleJobQueue,
  StorageObjectUpsertedParams,
  StorageObjectDeletedParams,
  StorageObjectAclChangedParams,
} from "@appstrate/core/module";
import { chunkDocument, enrichedContentForIndex } from "./chunker.ts";
import { embedDocuments, getTokenCounter } from "./inference.ts";
import { semanticSearchEnabled } from "./capability.ts";
import { mintLoopbackToken, selfOrigin } from "./loopback.ts";

interface IndexJobData {
  searchItemId: string;
  orgId: string;
}

interface ChunkRow {
  searchItemId: string;
  orgId: string;
  visibility: "org" | "private";
  ownerId: string | null;
  chunkIndex: number;
  content: string;
  /** Present ONLY when the semantic path computed it — absence keeps the column
   *  out of the INSERT so a no-pgvector deployment never references it. */
  embedding?: number[];
}

// Placeholder identity for the ingestion loopback when an object is org-visible
// (ownerId = null): the storage ACL passes org-visible objects for any id, so
// the value is never matched against — it only fills the token's required
// `userId` claim. Private objects carry their real owner id and ARE matched.
const SYSTEM_READER = "system:search-indexer";

let queue: ModuleJobQueue<IndexJobData> | null = null;
let logger: Logger | null = null;

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function initSearchIngestion(ctx: ModuleInitContext): Promise<void> {
  logger = ctx.services.logger;
  queue = await ctx.services.queues.create<IndexJobData>("search-indexing", {
    attempts: 3,
    removeOnComplete: 100,
    removeOnFail: 500,
  });
  queue.process(async (job) => handleIndexJob(job.data), { concurrency: 2 });
  if (!ctx.services.queues.processingEnabled) {
    logger.info("search indexing enqueues only — jobs consumed by the worker-role process");
  }
}

export async function shutdownSearchIngestion(): Promise<void> {
  await queue?.shutdown();
  queue = null;
}

// ---------------------------------------------------------------------------
// Event handlers (called from events.ts) — the storage→search reactions.
// Each is a side-effect; the platform isolates errors per handler.
// ---------------------------------------------------------------------------

/** `object.upserted` → upsert the registry row (pending) + enqueue indexing. */
export async function onObjectUpserted(params: StorageObjectUpsertedParams): Promise<void> {
  const { id, orgId, mime, acl } = params;
  const [item] = await db
    .insert(searchItems)
    .values({
      id: newId("sidx"),
      orgId,
      storageObjectId: id,
      mime,
      visibility: acl.visibility,
      ownerId: acl.ownerId,
      status: "pending",
    })
    .onConflictDoUpdate({
      target: [searchItems.orgId, searchItems.storageObjectId],
      set: {
        mime,
        visibility: acl.visibility,
        ownerId: acl.ownerId,
        status: "pending",
        updatedAt: new Date(),
      },
    })
    .returning({ id: searchItems.id });
  if (!queue) throw new Error("search ingestion not initialized");
  await queue.add("index", { searchItemId: item!.id, orgId });
}

/** `object.deleted` → evict the item (chunks cascade). */
export async function onObjectDeleted(params: StorageObjectDeletedParams): Promise<void> {
  const { id, orgId } = params;
  await db
    .delete(searchItems)
    .where(and(eq(searchItems.orgId, orgId), eq(searchItems.storageObjectId, id)));
}

/** `object.acl_changed` → re-scope the denormalised ACL on the item AND its
 *  chunks (the chunk copy is what the retrieval WHERE filters on). */
export async function onObjectAclChanged(params: StorageObjectAclChangedParams): Promise<void> {
  const { id, orgId, acl } = params;
  const [item] = await db
    .update(searchItems)
    .set({ visibility: acl.visibility, ownerId: acl.ownerId, updatedAt: new Date() })
    .where(and(eq(searchItems.orgId, orgId), eq(searchItems.storageObjectId, id)))
    .returning({ id: searchItems.id });
  if (!item) return;
  await db
    .update(searchChunks)
    .set({ visibility: acl.visibility, ownerId: acl.ownerId })
    .where(eq(searchChunks.searchItemId, item.id));
}

// ---------------------------------------------------------------------------
// Loopback read — bytes (+ name) by opaque id, through storage's public API.
// ---------------------------------------------------------------------------

interface ReadObject {
  name: string | null;
  mime: string | null;
  bytes: Uint8Array;
}

/**
 * Fetch an object's metadata + bytes from storage by id, as the object's owner
 * (so the ACL resolves). Returns `null` when the object is gone (404) — the
 * caller treats that as "evict, don't retry".
 */
async function readStorageObject(
  id: string,
  orgId: string,
  ownerId: string | null,
): Promise<ReadObject | null> {
  const token = mintLoopbackToken({ userId: ownerId ?? SYSTEM_READER, orgId });
  const headers = { Authorization: `Bearer ${token}`, "X-Org-Id": orgId };
  const base = `${selfOrigin()}/api/storage/objects/${encodeURIComponent(id)}`;

  const metaRes = await fetch(base, { headers });
  if (metaRes.status === 404) return null;
  if (!metaRes.ok) throw new Error(`storage metadata read failed (${metaRes.status})`);
  const meta = (await metaRes.json()) as { name?: string; mime?: string | null };

  const contentRes = await fetch(`${base}/content`, { headers });
  if (contentRes.status === 404) return null;
  if (!contentRes.ok) throw new Error(`storage content read failed (${contentRes.status})`);
  const bytes = new Uint8Array(await contentRes.arrayBuffer());
  return { name: meta.name ?? null, mime: meta.mime ?? null, bytes };
}

// ---------------------------------------------------------------------------
// Index job — read bytes → extract → chunk → embed → write the index.
// ---------------------------------------------------------------------------

async function handleIndexJob(job: IndexJobData): Promise<void> {
  const { searchItemId, orgId } = job;
  const [item] = await db
    .select()
    .from(searchItems)
    .where(and(eq(searchItems.id, searchItemId), eq(searchItems.orgId, orgId)))
    .limit(1);
  if (!item) {
    // The item was deleted (e.g. object.deleted fired between enqueue and now)
    // — nothing to index, and no point retrying.
    logger?.info("search item gone before indexing — skipping", { searchItemId });
    return;
  }

  const object = await readStorageObject(item.storageObjectId, orgId, item.ownerId);
  if (!object) {
    // Object vanished between the event and ingestion — evict, don't retry.
    await db.delete(searchItems).where(eq(searchItems.id, searchItemId));
    return;
  }

  // Capture the name read from storage (the event carries no name).
  const name = object.name;
  const mime = object.mime ?? item.mime;

  try {
    const text = await extractText(object.bytes, mime, name ?? undefined);
    // Nothing extractable (unsupported type / scanned PDF / empty) — mark indexed
    // with zero chunks so we don't retry a file that has no text to offer.
    if (text === null) {
      await db.delete(searchChunks).where(eq(searchChunks.searchItemId, searchItemId));
      await db
        .update(searchItems)
        .set({ name, status: "indexed", syncedAt: new Date(), updatedAt: new Date() })
        .where(eq(searchItems.id, searchItemId));
      logger?.info("search item has no extractable text — indexed empty", { searchItemId, mime });
      return;
    }

    // Real tokenizer when the semantic path is on (chunk budgets must match the
    // embedding model's window); cheap approximation otherwise.
    const countTokens = semanticSearchEnabled()
      ? await getTokenCounter().catch((err) => {
          logger?.warn("tokenizer load failed — falling back to approximate counting", {
            err: String(err),
          });
          return undefined;
        })
      : undefined;
    const chunks = chunkDocument(
      { title: name, content: text },
      countTokens ? { countTokens } : {},
    );
    // The `embedding` key is left ABSENT (not `undefined`) on the row unless we
    // actually compute it: drizzle omits a column whose key is missing, so on a
    // deployment without the pgvector column the INSERT never references it.
    const rows: ChunkRow[] = chunks.map((chunk) => ({
      searchItemId,
      orgId,
      visibility: item.visibility,
      ownerId: item.ownerId,
      chunkIndex: chunk.chunkIndex,
      content: enrichedContentForIndex(chunk),
    }));

    // Re-index = replace: drop previous chunks, insert the new set.
    await db.delete(searchChunks).where(eq(searchChunks.searchItemId, searchItemId));
    if (rows.length > 0) {
      if (semanticSearchEnabled()) {
        // pgvector present → the `embedding` column exists: embed locally
        // (Transformers.js) and let drizzle write the full row.
        const vectors = await embedDocuments(rows.map((r) => r.content));
        rows.forEach((row, i) => {
          row.embedding = vectors[i];
        });
        await db.insert(searchChunks).values(rows);
      } else {
        // No pgvector → the `embedding` column does NOT exist. A drizzle insert
        // always lists EVERY table column (unprovided ones as DEFAULT), so it
        // would reference the missing `embedding` and fail. Insert via raw SQL
        // naming only the columns that exist (keyword-only degradation).
        const tuples = rows.map(
          (r) =>
            sql`(${r.searchItemId}, ${r.orgId}, ${r.visibility}, ${r.ownerId}, ${r.chunkIndex}, ${r.content})`,
        );
        await db.execute(
          sql`INSERT INTO search_chunks (search_item_id, org_id, visibility, owner_id, chunk_index, content) VALUES ${sql.join(tuples, sql`, `)}`,
        );
      }
    }

    await db
      .update(searchItems)
      .set({ name, status: "indexed", syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(searchItems.id, searchItemId));
    logger?.info("search item indexed", {
      searchItemId,
      chunks: rows.length,
      semantic: semanticSearchEnabled(),
    });
  } catch (err) {
    await db
      .update(searchItems)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(searchItems.id, searchItemId));
    throw err;
  }
}
