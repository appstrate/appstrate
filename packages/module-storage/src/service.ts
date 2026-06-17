// SPDX-License-Identifier: Apache-2.0

/**
 * Storage service — disk lifecycle + on-demand cloud sync.
 *
 * v1 is SYNCHRONOUS (no worker, no queue): the sync route awaits `syncDisk`
 * and returns the counts. Raw storage does no extraction/chunking/embedding —
 * that pipeline belongs to `module-search`. Cloud disks list remote objects,
 * dedup on (diskId, driverKey), and advance the disk's watermark cursor.
 *
 * Cloud connection-backed disks (Drive) reach their API through the platform
 * credential-proxy — captured at module init via `setCredentialProxy` and
 * threaded into the driver per request alongside the calling actor.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { storageDisks, storageObjects } from "@appstrate/db/schema";
import type { Logger } from "@appstrate/core/logger";
import { resolveDriver, type DriverContext } from "./drivers/index.ts";
import { emitStorageObjectEvent } from "./events.ts";

export interface SyncResult {
  listed: number;
  upserted: number;
}

export type RequestActor = { type: "user" | "end_user"; id: string };

// Platform credential-proxy, captured at init (modules can't import apps/api).
let credentialProxy: DriverContext["proxyCall"] | null = null;

export function setCredentialProxy(fn: DriverContext["proxyCall"] | null): void {
  credentialProxy = fn;
}

/** Build the per-request driver context (actor + proxy) for cloud disks. */
export function makeDriverContext(actor: RequestActor): DriverContext | undefined {
  return credentialProxy ? { actor, proxyCall: credentialProxy } : undefined;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Get-or-create the org's native default disk (the platform S3/FS blob). */
export async function ensureDefaultDisk(orgId: string): Promise<string> {
  const [existing] = await db
    .select({ id: storageDisks.id })
    .from(storageDisks)
    .where(and(eq(storageDisks.orgId, orgId), eq(storageDisks.isDefault, true)))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(storageDisks)
    .values({ id: newId("sdsk"), orgId, kind: "native", name: "Stockage", isDefault: true })
    .onConflictDoNothing()
    .returning({ id: storageDisks.id });
  if (created) return created.id;

  // Lost the create race (the partial unique index rejected the second
  // default) — read the winner.
  const [retry] = await db
    .select({ id: storageDisks.id })
    .from(storageDisks)
    .where(and(eq(storageDisks.orgId, orgId), eq(storageDisks.isDefault, true)))
    .limit(1);
  return retry!.id;
}

/**
 * Synchronously sync one cloud disk: list its objects, upsert/dedup on
 * (diskId, driverKey), advance the watermark. Returns the counts. `actor` is
 * the caller — Drive disks decrypt that actor's integration connection.
 */
export async function syncDisk(
  diskId: string,
  orgId: string,
  actor: RequestActor,
  logger?: Logger | null,
): Promise<SyncResult> {
  const [disk] = await db
    .select()
    .from(storageDisks)
    .where(and(eq(storageDisks.id, diskId), eq(storageDisks.orgId, orgId)))
    .limit(1);
  if (!disk) throw new Error(`storage disk ${diskId} no longer exists`);
  if (!disk.enabled) return { listed: 0, upserted: 0 };

  const driver = resolveDriver(disk, makeDriverContext(actor));
  if (!driver.list) throw new Error(`disk kind "${disk.kind}" cannot be synced`);

  const since = disk.syncCursor ? new Date(disk.syncCursor) : null;
  // Synced cloud objects are org-visible; provenance = the syncing member.
  const visibility = "org" as const;
  const ownerId = actor.id;

  let listed = 0;
  let upserted = 0;
  let watermark = since;

  for await (const object of driver.list(since)) {
    listed++;
    if (object.modifiedAt && (!watermark || object.modifiedAt > watermark)) {
      watermark = object.modifiedAt;
    }

    const [existing] = await db
      .select({ id: storageObjects.id })
      .from(storageObjects)
      .where(and(eq(storageObjects.diskId, diskId), eq(storageObjects.driverKey, object.driverKey)))
      .limit(1);

    let objectId: string;
    if (existing) {
      objectId = existing.id;
      await db
        .update(storageObjects)
        .set({
          name: object.name,
          mime: object.mime,
          sizeBytes: object.sizeBytes,
          syncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(storageObjects.id, objectId));
    } else {
      objectId = newId("sobj");
      await db.insert(storageObjects).values({
        id: objectId,
        orgId,
        diskId,
        driverKey: object.driverKey,
        name: object.name,
        mime: object.mime,
        sizeBytes: object.sizeBytes,
        visibility,
        ownerId,
        syncedAt: new Date(),
      });
    }

    // Storage owns the object ACL; emit the contract event so the future
    // search index can (re)index + mirror rights. Today a no-op seam.
    emitStorageObjectEvent({
      type: "object.upserted",
      id: objectId,
      orgId,
      diskId,
      mime: object.mime,
      acl: { visibility, ownerId },
    });
    upserted++;
  }

  await db
    .update(storageDisks)
    .set({
      syncCursor: watermark ? watermark.toISOString() : disk.syncCursor,
      updatedAt: new Date(),
    })
    .where(eq(storageDisks.id, diskId));

  logger?.info("storage disk sync done", { diskId, kind: disk.kind, listed, upserted });
  return { listed, upserted };
}
