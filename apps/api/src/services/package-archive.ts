// SPDX-License-Identifier: Apache-2.0

import {
  DecompressionLimitError,
  PACKAGE_ZIP_MAX_DECOMPRESSED_BYTES,
  unzipArtifact,
} from "@appstrate/core/zip";
import { ApiError } from "../lib/errors.ts";
import { logger } from "../lib/logger.ts";

/**
 * Expand stored package bytes under the same ceiling as package ingestion.
 *
 * Both mutable package-item archives and immutable version archives pass
 * through here. Keeping the budget and its HTTP error mapping together avoids
 * one storage path silently inheriting `unzipArtifact`'s larger generic default.
 */
export function unzipPackageArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  try {
    const startedAt = performance.now();
    const files = unzipArtifact(bytes, {
      maxDecompressedBytes: PACKAGE_ZIP_MAX_DECOMPRESSED_BYTES,
    });
    const durationMs = performance.now() - startedAt;
    let decompressedBytes = 0;
    for (const file of Object.values(files)) decompressedBytes += file.byteLength;

    logger.info("Package archive decompressed", {
      compressedBytes: bytes.byteLength,
      decompressedBytes,
      durationMs: Math.round(durationMs),
    });
    return files;
  } catch (error) {
    if (!(error instanceof DecompressionLimitError) || error.reason === "corrupt-archive") {
      throw error;
    }

    const limitMb = PACKAGE_ZIP_MAX_DECOMPRESSED_BYTES / 1024 / 1024;
    logger.warn("Refused to expand a package archive past its decompression budget", {
      reason: error.reason,
      compressedBytes: bytes.byteLength,
      maxDecompressedBytes: PACKAGE_ZIP_MAX_DECOMPRESSED_BYTES,
    });
    throw new ApiError({
      status: 422,
      code: "package_archive_unreadable",
      title: "Package Archive Unreadable",
      detail: `The package archive expands past the ${limitMb} MB decompression limit and was refused (${error.reason}). Republish the package from bytes that fit the limit.`,
    });
  }
}
