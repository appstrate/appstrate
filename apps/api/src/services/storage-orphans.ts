// SPDX-License-Identifier: Apache-2.0

/**
 * Storage orphan reconciliation — the reusable half of
 * `scripts/storage-orphans.ts`.
 *
 * The transactional deletion outbox guarantees that a row delete never leaves
 * its bytes behind. Reconciliation is the BACKSTOP for everything that
 * predates or escapes it: objects stranded by an older cascade, by a rollback
 * whose best-effort cleanup failed, or by a code path still doing a direct
 * delete. It diffs what is physically IN a bucket against the set of keys the
 * database says should be there, and reports (or enqueues) the difference.
 *
 * The design decisions this module preserves (they are load-bearing, see the
 * script header):
 *
 *   - **Dry-run by default** — the script only reports unless `--delete`.
 *   - **Enqueue, never delete directly** — `--delete` inserts
 *     `storage_deletion_jobs` rows so the platform's one idempotent delete path
 *     performs the purge, leaving a durable auditable record.
 *   - **Grace window** — every writer uploads the object BEFORE committing its
 *     row, so a key with no row is legitimately expected for the width of that
 *     window. Objects modified within `--min-age-hours` are SKIPPED, never
 *     treated as orphans. An object whose backend reports no `lastModified` is
 *     treated as old, so the diff still finds genuinely-stranded bytes.
 *
 * ## Why one descriptor table instead of a per-bucket copy
 *
 * Every bucket answers the same two questions — "what keys does the DB know
 * about" and "which object key maps to which known identity" — so each is one
 * {@link OrphanScanBucket} row and they all run through {@link diffBucket}.
 * A copy-pasted diff per bucket is how a grace window or a `_system/` carve-out
 * ends up applied to two buckets out of four.
 *
 * ## Identities, not just keys
 *
 * Most buckets store one object per row, so the identity IS the key. The
 * `run-workspace` bucket stores several objects per run (bundle, manifest, and
 * one object per input document whose names live inside the manifest, not in
 * any table). Its descriptor therefore maps an object key back to its owning
 * runId and diffs against the set of live run ids. `identityOf` returning
 * `null` means "key shape not recognised" — reported separately and NEVER
 * treated as an orphan, because an unparseable key is a gap in this reader's
 * knowledge, not evidence that the bytes are dead.
 */

import { db } from "@appstrate/db/client";
import {
  documents,
  uploads,
  runs,
  packages,
  packageVersions,
  storageDeletionJobs,
} from "@appstrate/db/schema";
import type { StorageObject } from "@appstrate/core/storage";
import { DOCUMENTS_BUCKET } from "./documents.ts";
import { UPLOAD_BUCKET } from "./uploads.ts";
import { RUN_WORKSPACE_BUCKET } from "./run-workspace-manifest.ts";
import { AGENT_PACKAGES_BUCKET, versionZipKey } from "./package-storage-keys.ts";
import {
  PACKAGE_ITEMS_BUCKET,
  packageItemKey,
  packageItemOwnerNamespace,
  storageFolderForType,
} from "./package-items/config.ts";

/** Reason recorded on every job this reconciliation enqueues. */
const ORPHAN_RECONCILIATION_REASON = "orphan_reconciliation";

/** One bucket the scanner knows how to reconcile against the database. */
export interface OrphanScanBucket {
  /** Physical bucket name passed to `listObjects`. */
  bucket: string;
  /** What the known-set is, for the operator's report. */
  describes: string;
  /** Load every identity the DB says should exist in this bucket. */
  loadKnown: () => Promise<Set<string>>;
  /**
   * Map an in-bucket object key to the identity looked up in the known set.
   * Omitted = the key IS the identity. `null` = unrecognised key shape (never
   * an orphan).
   */
  identityOf?: (key: string) => string | null;
}

/** Per-bucket outcome of a diff pass. */
interface BucketDiff {
  bucket: string;
  /** Objects enumerated in the bucket. */
  scanned: number;
  /** Objects skipped because they are younger than the grace window. */
  recentSkipped: number;
  /** Objects whose key shape this reader does not understand (not orphans). */
  unrecognized: string[];
  /** Objects with no backing row, older than the grace window. */
  orphans: { key: string; size?: number }[];
}

/**
 * Strip a stored `bucket/path` key down to its in-bucket path. `documents` and
 * `uploads` persist the bucket as part of `storage_key`; `listObjects` yields
 * keys without it. Returns null when the row's key does not belong to `bucket`.
 */
function inBucketKey(storageKey: string, bucket: string): string | null {
  const prefix = `${bucket}/`;
  return storageKey.startsWith(prefix) ? storageKey.slice(prefix.length) : null;
}

/**
 * Which run owns a `run-workspace` object. Two key shapes exist:
 * `{runId}.afps` (the bundle) and `{runId}/…` (manifest + documents).
 */
export function runWorkspaceOwner(key: string): string | null {
  const slash = key.indexOf("/");
  if (slash > 0) return key.slice(0, slash);
  if (key.endsWith(".afps")) return key.slice(0, -".afps".length) || null;
  return null;
}

/**
 * The buckets with a DB-backed known-set, in operator report order.
 *
 * `packages` rows with `org_id IS NULL` are the SYSTEM catalog: their library
 * artifacts live under the global `_system/` namespace and their published
 * versions under the same `{packageId}/{version}.afps` key space as everyone
 * else. Both are loaded here from the same unfiltered queries, so a system
 * object can never be reported as an orphan — that is exactly why the
 * known-sets are built with no `orgId` filter at all.
 */
export function orphanScanBuckets(): OrphanScanBucket[] {
  return [
    {
      bucket: DOCUMENTS_BUCKET,
      describes: "documents.storage_key",
      loadKnown: async () => {
        const rows = await db.select({ storageKey: documents.storageKey }).from(documents);
        return collectInBucketKeys(rows, DOCUMENTS_BUCKET);
      },
    },
    {
      bucket: UPLOAD_BUCKET,
      describes: "uploads.storage_key",
      loadKnown: async () => {
        const rows = await db.select({ storageKey: uploads.storageKey }).from(uploads);
        return collectInBucketKeys(rows, UPLOAD_BUCKET);
      },
    },
    {
      bucket: AGENT_PACKAGES_BUCKET,
      describes: "package_versions (published version artifacts)",
      loadKnown: async () => {
        // No org filter: the key space is global (`packages.id` is the PK), so
        // the known-set must span every org AND the system catalog.
        const rows = await db
          .select({ packageId: packageVersions.packageId, version: packageVersions.version })
          .from(packageVersions);
        return new Set(rows.map((r) => versionZipKey(r.packageId, r.version)));
      },
    },
    {
      bucket: PACKAGE_ITEMS_BUCKET,
      describes: "packages (library item artifacts, incl. _system/)",
      loadKnown: async () => {
        const rows = await db
          .select({ id: packages.id, type: packages.type, orgId: packages.orgId })
          .from(packages);
        return new Set(
          rows.map((r) =>
            packageItemKey(storageFolderForType(r.type), packageItemOwnerNamespace(r.orgId), r.id),
          ),
        );
      },
    },
    {
      bucket: RUN_WORKSPACE_BUCKET,
      describes: "runs.id (bundle + manifest + input documents per run)",
      // Document names live inside the manifest object, not in any table, so
      // the known-set is the set of live run ids and each object is matched by
      // the run prefix it sits under.
      identityOf: runWorkspaceOwner,
      loadKnown: async () => {
        const rows = await db.select({ id: runs.id }).from(runs);
        return new Set(rows.map((r) => r.id));
      },
    },
  ];
}

function collectInBucketKeys(rows: { storageKey: string }[], bucket: string): Set<string> {
  const known = new Set<string>();
  for (const r of rows) {
    const key = inBucketKey(r.storageKey, bucket);
    if (key !== null) known.add(key);
  }
  return known;
}

/**
 * Diff one bucket's objects against its known-set. Pure: no DB, no storage, no
 * clock — the caller supplies the enumerated objects, the known identities and
 * the cutoff, which is what makes the grace window and the `_system/` carve-out
 * directly testable.
 */
export async function diffBucket(
  bucket: string,
  objects: AsyncIterable<StorageObject> | Iterable<StorageObject>,
  known: ReadonlySet<string>,
  opts: { cutoffMs: number; identityOf?: (key: string) => string | null },
): Promise<BucketDiff> {
  const identityOf = opts.identityOf ?? ((key: string) => key);
  const diff: BucketDiff = { bucket, scanned: 0, recentSkipped: 0, unrecognized: [], orphans: [] };

  for await (const obj of objects) {
    diff.scanned += 1;

    const identity = identityOf(obj.key);
    // Unrecognised shape → this reader cannot prove the object is dead. Report
    // it for a human, never enqueue it.
    if (identity === null) {
      diff.unrecognized.push(obj.key);
      continue;
    }
    if (known.has(identity)) continue;

    // Grace window: writers upload BEFORE committing the row, so a young
    // object with no row is likely mid-write, not stranded. A missing
    // `lastModified` is treated as old so the diff still catches real orphans.
    if (obj.lastModified !== undefined && obj.lastModified.getTime() > opts.cutoffMs) {
      diff.recentSkipped += 1;
      continue;
    }

    diff.orphans.push({ key: obj.key, size: obj.size });
  }

  return diff;
}

/**
 * Enqueue a deletion job per orphan. Deliberately goes through the outbox table
 * rather than deleting: the platform worker owns the single idempotent delete
 * path and the row is the audit trail. `onConflictDoNothing` de-dupes against
 * an already-pending job for the same object (partial unique index on
 * `(bucket, storage_key) WHERE completed_at IS NULL`), so re-running the script
 * is safe.
 */
export async function enqueueOrphanDeletions(
  orphans: { bucket: string; key: string }[],
): Promise<number> {
  if (orphans.length === 0) return 0;
  await db
    .insert(storageDeletionJobs)
    .values(
      orphans.map((o) => ({
        id: `sdj_${crypto.randomUUID()}`,
        bucket: o.bucket,
        storageKey: o.key,
        reason: ORPHAN_RECONCILIATION_REASON,
      })),
    )
    .onConflictDoNothing();
  return orphans.length;
}
