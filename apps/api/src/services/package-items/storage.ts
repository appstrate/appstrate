// SPDX-License-Identifier: Apache-2.0

import { zipArtifact, unzipArtifact } from "@appstrate/core/zip";
import { computeIntegrity } from "@appstrate/core/integrity";
import { verifyArtifactIntegrity } from "@appstrate/core/integrity";
import * as storage from "@appstrate/db/storage";
import { logger } from "../../lib/logger.ts";
import { PACKAGE_ITEMS_BUCKET } from "./config.ts";
import { getErrorMessage } from "@appstrate/core/errors";

// ─────────────────────────────────────────────
// Package item Storage (full ZIP)
// ─────────────────────────────────────────────

/** Upload a package item's full normalized files to Storage. Returns SHA256 SRI integrity hash. */
export async function uploadPackageFiles(
  type: "agents" | "skills" | "integrations" | "mcp-servers",
  orgId: string,
  itemId: string,
  normalizedFiles: Record<string, Uint8Array>,
): Promise<string> {
  const zip = zipArtifact(normalizedFiles, 6);
  const integrity = computeIntegrity(zip);
  const path = `${orgId}/${type}/${itemId}.afps`;
  try {
    await storage.uploadFile(PACKAGE_ITEMS_BUCKET, path, zip);
  } catch (err) {
    const message = getErrorMessage(err);
    logger.error("Failed to upload package files", { type, orgId, itemId, error: message });
    throw err;
  }
  return integrity;
}

/** Global namespace for system packages in S3 (not org-scoped). */
export const SYSTEM_STORAGE_NAMESPACE = "_system";

/**
 * Where a package's files live in the bucket. Derived from the package
 * row's `orgId` (`null` → system, non-null → org). Callers that already
 * hold the row pass the hint so a system package costs ONE storage GET
 * instead of always paying a missed org-path GET first.
 */
export type PackageStorageOwnership = "org" | "system";

/** Download a package item's full files from Storage. Returns normalized file map or null.
 *  With an `ownership` hint, fetches the correct path directly (org-scoped or
 *  global _system/ namespace). Without it (ambiguous callers), tries the
 *  org-scoped path first and falls back to the system namespace.
 *  When expectedIntegrity is provided, verifies SHA256 SRI hash before unzipping. */
export async function downloadPackageFiles(
  type: "agents" | "skills" | "integrations" | "mcp-servers",
  orgId: string,
  itemId: string,
  expectedIntegrity?: string | null,
  ownership?: PackageStorageOwnership,
): Promise<Record<string, Uint8Array> | null> {
  const orgPath = `${orgId}/${type}/${itemId}.afps`;
  const systemPath = `${SYSTEM_STORAGE_NAMESPACE}/${type}/${itemId}.afps`;

  let data: Awaited<ReturnType<typeof storage.downloadFile>>;
  if (ownership === "system") {
    data = await storage.downloadFile(PACKAGE_ITEMS_BUCKET, systemPath);
  } else if (ownership === "org") {
    data = await storage.downloadFile(PACKAGE_ITEMS_BUCKET, orgPath);
  } else {
    // Ambiguous — try org-scoped path first, fall back to system namespace.
    data = await storage.downloadFile(PACKAGE_ITEMS_BUCKET, orgPath);
    if (!data) {
      data = await storage.downloadFile(PACKAGE_ITEMS_BUCKET, systemPath);
    }
  }
  if (!data) return null;

  const bytes = new Uint8Array(data);
  if (expectedIntegrity) {
    const result = verifyArtifactIntegrity(bytes, expectedIntegrity);
    if (!result.valid) {
      throw new Error(
        `Integrity check failed for ${type}/${itemId}: expected ${expectedIntegrity}, got ${result.computed}`,
      );
    }
  }
  return unzipArtifact(bytes);
}

/** Delete a package item's files from Storage. */
export async function deletePackageFiles(
  type: "agents" | "skills" | "integrations" | "mcp-servers",
  orgId: string,
  itemId: string,
): Promise<void> {
  const path = `${orgId}/${type}/${itemId}.afps`;
  await storage.deleteFile(PACKAGE_ITEMS_BUCKET, path);
}
