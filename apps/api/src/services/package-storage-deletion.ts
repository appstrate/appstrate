// SPDX-License-Identifier: Apache-2.0

/**
 * Transactional-outbox enumeration for the two PACKAGE object-storage buckets.
 *
 *   - `agent-packages`   — published version artifacts, `{packageId}/{version}.afps`
 *   - `library-packages` — draft/library item ZIPs, `{orgId}/{folder}/{itemId}.afps`
 *
 * Both sat outside the outbox: `deleteOrganization` dropped every `packages`
 * row of an org while their bytes stayed in S3 forever. This module produces
 * the jobs that close that hole, computed from DB rows only (no storage I/O),
 * so a caller can enqueue them INSIDE the very transaction that performs the
 * cascade — the atomicity the outbox invariant rests on.
 *
 * ## Why enumerating by `orgId` is safe for `agent-packages`
 *
 * `agent-packages` keys are NOT org-prefixed, which raises the obvious
 * cross-tenant question: could purging org A's versions delete bytes org B (or
 * the system catalog) still resolves? No. `packages.id` — the `@scope/name`
 * string that forms the key prefix — is the table's PRIMARY KEY, so exactly
 * one `packages` row exists per id platform-wide, and `package_versions` is
 * unique on `(package_id, version)`. A key therefore belongs to exactly one
 * row, whose single `org_id` decides ownership; two orgs can never both own
 * `@scope/name`, and system packages (`org_id IS NULL`) are excluded by
 * `eq(packages.orgId, orgId)` (SQL `= NULL` is never true). Ownership is read
 * off the row rather than parsed out of the scope in the key — an org may
 * legitimately own a package under a foreign-looking scope
 * (`requirePackageInOrg` gates on the row's `orgId`, not on scope identity),
 * so scope-string matching would be exactly the wrong test.
 *
 * Note this enqueues a job for every package row, including rows that never
 * had a `library-packages` object written (a draft created through
 * `createOrgItem` alone). That is deliberate: `storage.deleteFile` is
 * idempotent on a missing object, so an over-broad enqueue costs one no-op
 * worker pass, whereas an under-broad one leaks bytes forever.
 */

import { and, eq, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, packageVersions } from "@appstrate/db/schema";
import type { StorageDeletionJobInput } from "./storage-deletion.ts";
import { AGENT_PACKAGES_BUCKET, versionZipKey } from "./package-storage-keys.ts";
import {
  PACKAGE_ITEMS_BUCKET,
  packageItemKey,
  packageItemOwnerNamespace,
  storageFolderForType,
} from "./package-items/config.ts";

/** A Drizzle executor — either the root `db` or an open transaction handle. */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Every package object matching a predicate over `packages`, as outbox jobs.
 *
 * THE single enumeration path — an org-wide purge and a single-item purge
 * differ only by the `where`. Two enumerations that can disagree eventually
 * will, and the failure is silent: a job aimed at a key the writer never wrote
 * deletes nothing while the row count still looks green.
 *
 * Queries run sequentially: a Drizzle transaction multiplexes a single
 * connection, so concurrent queries on `tx` are unsafe.
 */
async function packageStorageJobsWhere(
  tx: DbOrTx,
  scope: SQL | undefined,
  reason: string,
): Promise<StorageDeletionJobInput[]> {
  const jobs: StorageDeletionJobInput[] = [];

  // library-packages: one object per package row, namespaced by the OWNING org
  // (or `_system/` — the namespace helper is the only place that decides).
  const itemRows = await tx
    .select({ id: packages.id, type: packages.type, orgId: packages.orgId })
    .from(packages)
    .where(scope);
  for (const row of itemRows) {
    jobs.push({
      bucket: PACKAGE_ITEMS_BUCKET,
      storageKey: packageItemKey(
        storageFolderForType(row.type),
        packageItemOwnerNamespace(row.orgId),
        row.id,
      ),
      reason,
    });
  }

  // agent-packages: one object per published version of those packages. Joined
  // through `packages` so ownership comes from the row, never from the key.
  const versionRows = await tx
    .select({ packageId: packageVersions.packageId, version: packageVersions.version })
    .from(packageVersions)
    .innerJoin(packages, eq(packageVersions.packageId, packages.id))
    .where(scope);
  for (const row of versionRows) {
    jobs.push({
      bucket: AGENT_PACKAGES_BUCKET,
      storageKey: versionZipKey(row.packageId, row.version),
      reason,
    });
  }

  return jobs;
}

/**
 * The outbox jobs purging every `agent-packages` + `library-packages` object
 * owned by `orgId`. MUST be awaited (and enqueued) BEFORE the cascade drops
 * the `packages` rows — once they are gone the keys are unrecoverable.
 */
export function orgPackageStorageDeletionJobs(
  tx: DbOrTx,
  orgId: string,
  reason: string,
): Promise<StorageDeletionJobInput[]> {
  return packageStorageJobsWhere(tx, eq(packages.orgId, orgId), reason);
}

/**
 * The outbox jobs purging ONE package's objects: its `library-packages` item
 * ZIP plus every published `agent-packages` version artifact (the set that
 * `ON DELETE CASCADE` on `package_versions` is about to make unrecoverable).
 *
 * The `orgId` predicate is kept alongside the id deliberately — not as
 * belt-and-braces, but so this can never be aimed at another org's or the
 * system catalog's (`org_id IS NULL`) artifacts even if a caller passes an id
 * it does not own.
 */
export function packageStorageDeletionJobs(
  tx: DbOrTx,
  orgId: string,
  packageId: string,
  reason: string,
): Promise<StorageDeletionJobInput[]> {
  return packageStorageJobsWhere(
    tx,
    and(eq(packages.orgId, orgId), eq(packages.id, packageId)),
    reason,
  );
}
