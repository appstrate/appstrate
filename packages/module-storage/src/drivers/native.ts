// SPDX-License-Identifier: Apache-2.0

/**
 * Native driver — the built-in default disk. Delegates straight to the
 * platform's storage facade (`@appstrate/db/storage`), the SAME layer the
 * core uploads/run-workspace use: S3 when `S3_BUCKET` is set, filesystem
 * fallback otherwise. No env duplication, no `PlatformServices` needed — the
 * facade resolves the backend from the platform env itself.
 *
 * Object bytes live under `storage/{orgId}/{key}` so every org's blobs are
 * key-prefixed (app-level isolation, like the rest of the platform — no RLS).
 */

import * as storage from "@appstrate/db/storage";
import type { StorageDriver } from "./types.ts";

/** Bucket prefix (the facade maps it to an S3 prefix / FS subdirectory). */
const BUCKET_PREFIX = "storage";

function randomKey(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/** Native driver for one org's default disk. */
export function createNativeDriver(orgId: string): StorageDriver {
  const keyOf = (driverKey: string) => `${orgId}/${driverKey}`;

  return {
    async read(driverKey, mime) {
      const bytes = await storage.downloadFile(BUCKET_PREFIX, keyOf(driverKey));
      if (bytes === null) return null;
      return { bytes, mime: mime ?? "application/octet-stream" };
    },

    async write(_name, _mime, data) {
      // The driver key is opaque (a random id); the original filename is kept
      // on the object row, not in the storage path.
      const driverKey = randomKey();
      await storage.uploadFile(BUCKET_PREFIX, keyOf(driverKey), data);
      return driverKey;
    },

    async remove(driverKey) {
      await storage.deleteFile(BUCKET_PREFIX, keyOf(driverKey));
    },

    // No `list`: the native disk's inventory is its `storage_objects` rows.
  };
}
