#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Storage orphan reconciliation (operator one-shot, NOT a permanent scanner).
 *
 *   bun scripts/storage-orphans.ts [--delete]
 *
 * Lists every object in the `documents` bucket (via the storage `listObjects`
 * primitive — S3 ListObjectsV2 / filesystem walk) and diffs it against the
 * `documents.storage_key` rows. Objects with no backing row are orphans:
 * bytes whose owning row disappeared without the transactional deletion outbox
 * catching them (e.g. an object stranded by a bug predating this hardening, or
 * a pre-migration cascade delete).
 *
 * Default is DRY-RUN — it only reports. With `--delete` it enqueues a deletion
 * job (`storage_deletion_jobs`, reason `orphan_reconciliation`) for each orphan;
 * the running platform's worker then performs the idempotent physical delete.
 * The script never deletes objects directly — enqueuing keeps a durable,
 * auditable record and reuses the one delete path.
 *
 * Loads every `documents.storage_key` into memory to build the known-set — fine
 * for an operator run; not a hot path.
 */

import { parseArgs } from "node:util";
import { db } from "@appstrate/db/client";
import { documents, storageDeletionJobs } from "@appstrate/db/schema";
import { listObjects } from "@appstrate/db/storage";

const DOCUMENTS_BUCKET = "documents";

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      delete: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (values.help) {
    out("Usage: bun scripts/storage-orphans.ts [--delete]");
    out("  Diffs the documents bucket against documents.storage_key rows.");
    out("  Default: dry-run (report only). --delete: enqueue deletion jobs.");
    return 0;
  }

  const doDelete = values.delete === true;

  // Build the known-set of in-bucket keys (strip the `documents/` bucket prefix
  // off each stored key, which is `documents/{app}/{doc}/{name}`).
  const rows = await db.select({ storageKey: documents.storageKey }).from(documents);
  const known = new Set<string>();
  const prefix = `${DOCUMENTS_BUCKET}/`;
  for (const r of rows) {
    if (r.storageKey.startsWith(prefix)) known.add(r.storageKey.slice(prefix.length));
  }
  out(`Known document objects (rows): ${known.size}`);

  const orphans: { key: string; size?: number }[] = [];
  let scanned = 0;
  for await (const obj of listObjects(DOCUMENTS_BUCKET)) {
    scanned += 1;
    if (!known.has(obj.key)) orphans.push({ key: obj.key, size: obj.size });
  }
  out(`Objects scanned in bucket "${DOCUMENTS_BUCKET}": ${scanned}`);
  out(`Orphans (object with no row): ${orphans.length}`);

  let totalBytes = 0;
  for (const o of orphans) {
    totalBytes += o.size ?? 0;
    out(`  orphan  ${o.key}${o.size !== undefined ? `  (${o.size} bytes)` : ""}`);
  }
  out(`Orphan bytes (where reported): ${totalBytes}`);

  if (orphans.length === 0) {
    out("No orphans — nothing to do.");
    return 0;
  }

  if (!doDelete) {
    out("Dry-run: re-run with --delete to enqueue deletion jobs for the orphans above.");
    return 0;
  }

  const jobs = orphans.map((o) => ({
    id: `sdj_${crypto.randomUUID()}`,
    bucket: DOCUMENTS_BUCKET,
    storageKey: o.key,
    reason: "orphan_reconciliation",
  }));
  await db.insert(storageDeletionJobs).values(jobs).onConflictDoNothing();
  out(`Enqueued ${jobs.length} deletion job(s). The platform worker will purge them.`);
  return 0;
}

process.exit(await main());
