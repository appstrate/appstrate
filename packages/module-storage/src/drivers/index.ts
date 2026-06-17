// SPDX-License-Identifier: Apache-2.0

import type { storageDisks } from "@appstrate/db/schema";
import type { StorageDriver, DriverContext } from "./types.ts";
import { createNativeDriver } from "./native.ts";
import { createS3Driver } from "./s3.ts";
import { createGdriveDriver } from "./gdrive.ts";

export type { StorageDriver, DriverObject, ObjectBytes, DriverContext } from "./types.ts";

type DiskRow = typeof storageDisks.$inferSelect;

/**
 * Resolve the driver for a disk row. Cloud connection-backed drivers (Drive)
 * need the per-request `ctx` (actor + credential-proxy); native/S3 disks
 * ignore it.
 */
export function resolveDriver(disk: DiskRow, ctx?: DriverContext): StorageDriver {
  const config = disk.config as Record<string, unknown>;
  switch (disk.kind) {
    case "native":
      return createNativeDriver(disk.orgId);
    case "s3":
      return createS3Driver(config);
    case "google_drive":
      if (!ctx) throw new Error("google_drive disk requires a request context (actor + proxy)");
      return createGdriveDriver(config, ctx);
    default:
      throw new Error(`storage disk kind "${disk.kind}" has no driver`);
  }
}

/** Whether a disk kind can be enumerated (cloud disks have a `list`). */
export function isCloudKind(kind: string): boolean {
  return kind === "s3" || kind === "google_drive";
}
