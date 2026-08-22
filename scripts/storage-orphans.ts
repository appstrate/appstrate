#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Storage orphan reconciliation (operator one-shot, NOT a permanent scanner).
 *
 *   bun scripts/storage-orphans.ts [--delete] [--min-age-hours=N] [--bucket=NAME]
 *
 * For every bucket with a DB-backed known-set, lists the objects it physically
 * contains (via the storage `listObjects` primitive — S3 ListObjectsV2 /
 * filesystem walk) and diffs them against the rows that should own them.
 * Objects with no backing row are orphans: bytes whose owning row disappeared
 * without the transactional deletion outbox catching them (e.g. an object
 * stranded by a bug predating this hardening, or a pre-migration cascade
 * delete).
 *
 * Buckets covered (descriptor table lives in
 * `apps/api/src/services/storage-orphans.ts`, which also holds the single diff
 * loop so a bucket can never silently miss the grace window or the `_system/`
 * carve-out):
 *
 *   documents        ← files.storage_key
 *   uploads          ← uploads.storage_key
 *   agent-packages   ← package_versions  (published version artifacts)
 *   library-packages ← packages          (library item artifacts, incl. _system/)
 *   run-workspace    ← runs.id           (bundle + manifest + input files)
 *
 * The `documents` bucket is NOT a typo and there is no `files` bucket. #1177
 * renamed the TABLE `documents` → `files`; the S3 bucket / key prefix stayed
 * `documents` because every stored `storage_key` already starts with
 * `documents/` and those are live bytes. So this one line reconciles the
 * `documents/` object namespace against `files.storage_key` values that all
 * begin with `documents/`. Same for the run-workspace bucket, whose per-run
 * input objects are keyed `{runId}/documents/<name>`.
 *
 * SYSTEM packages (`packages.org_id IS NULL`, objects under `_system/`) are
 * part of the known-set by construction — the queries apply no org filter — so
 * they are never reported as orphans.
 *
 * Grace window (`--min-age-hours`, default 24): an object whose last-modified
 * time is within the window is SKIPPED, never treated as an orphan. Every
 * writer puts the object in the bucket BEFORE it commits the owning row, so a
 * freshly-written object legitimately has no backing row for the split second
 * between the storage write and the DB commit. Without the window a scan racing
 * that gap would enqueue a live object for deletion. The window is applied from
 * `StorageObject.lastModified`; an object whose backend does not report a
 * timestamp is treated as old (not skipped) so the diff still finds genuinely-
 * stranded bytes.
 *
 * Default is DRY-RUN — it only reports. With `--delete` it enqueues a deletion
 * job (`storage_deletion_jobs`, reason `orphan_reconciliation`) for each orphan;
 * the running platform's worker then performs the idempotent physical delete.
 * The script never deletes objects directly — enqueuing keeps a durable,
 * auditable record and reuses the one delete path.
 *
 * Loads every known key into memory to build the per-bucket known-set — fine
 * for an operator run; not a hot path.
 */

import { parseArgs } from "node:util";
import { listObjects } from "@appstrate/db/storage";
import {
  orphanScanBuckets,
  diffBucket,
  enqueueOrphanDeletions,
} from "../apps/api/src/services/storage-orphans.ts";

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      delete: { type: "boolean" },
      "min-age-hours": { type: "string" },
      bucket: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  const buckets = orphanScanBuckets();

  if (values.help) {
    out("Usage: bun scripts/storage-orphans.ts [--delete] [--min-age-hours=N] [--bucket=NAME]");
    out("  Diffs each storage bucket against the DB rows that should own its objects.");
    out("  Default: dry-run (report only). --delete: enqueue deletion jobs.");
    out("  --min-age-hours=N: skip objects modified within the last N hours (default 24).");
    out("  --bucket=NAME: restrict the scan to one bucket.");
    out(`  Buckets: ${buckets.map((b) => b.bucket).join(", ")}`);
    return 0;
  }

  const doDelete = values.delete === true;

  // Grace window: objects modified within this many hours are skipped so a scan
  // never acts on an object written between the storage upload and its DB commit.
  const minAgeHoursRaw = values["min-age-hours"];
  const minAgeHours = minAgeHoursRaw === undefined ? 24 : Number(minAgeHoursRaw);
  if (!Number.isFinite(minAgeHours) || minAgeHours < 0) {
    out(`Invalid --min-age-hours: ${minAgeHoursRaw}`);
    return 1;
  }
  const cutoffMs = Date.now() - minAgeHours * 60 * 60 * 1000;

  const selected = values.bucket ? buckets.filter((b) => b.bucket === values.bucket) : buckets;
  if (selected.length === 0) {
    out(`Unknown --bucket: ${values.bucket}`);
    out(`Known buckets: ${buckets.map((b) => b.bucket).join(", ")}`);
    return 1;
  }

  const allOrphans: { bucket: string; key: string }[] = [];
  let totalBytes = 0;

  for (const descriptor of selected) {
    const known = await descriptor.loadKnown();
    const diff = await diffBucket(descriptor.bucket, listObjects(descriptor.bucket), known, {
      cutoffMs,
      identityOf: descriptor.identityOf,
    });

    out("");
    out(`── ${descriptor.bucket} ──────────────────────────────`);
    out(`  Known objects (${descriptor.describes}): ${known.size}`);
    out(`  Objects scanned in bucket: ${diff.scanned}`);
    out(`  Recent objects skipped (grace window ${minAgeHours}h): ${diff.recentSkipped}`);
    if (diff.unrecognized.length > 0) {
      out(
        `  Unrecognized key shapes (NOT orphans, reported for review): ${diff.unrecognized.length}`,
      );
      for (const key of diff.unrecognized) out(`    unknown  ${key}`);
    }
    out(`  Orphans (object with no row): ${diff.orphans.length}`);
    for (const o of diff.orphans) {
      totalBytes += o.size ?? 0;
      out(`    orphan  ${o.key}${o.size !== undefined ? `  (${o.size} bytes)` : ""}`);
      allOrphans.push({ bucket: descriptor.bucket, key: o.key });
    }
  }

  out("");
  out(`Total orphans: ${allOrphans.length}`);
  out(`Orphan bytes (where reported): ${totalBytes}`);

  if (allOrphans.length === 0) {
    out("No orphans — nothing to do.");
    return 0;
  }

  if (!doDelete) {
    out("Dry-run: re-run with --delete to enqueue deletion jobs for the orphans above.");
    return 0;
  }

  const enqueued = await enqueueOrphanDeletions(allOrphans);
  out(`Enqueued ${enqueued} deletion job(s). The platform worker will purge them.`);
  return 0;
}

process.exit(await main());
