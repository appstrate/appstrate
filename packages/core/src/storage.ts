// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/** Abstract file storage interface for bucket-based object storage. */
export interface Storage {
  /** Verify that the backing storage bucket exists and is accessible. */
  ensureBucket(): Promise<void>;
  /** Build a safe, normalized storage key from a bucket prefix and file path. */
  safePath(bucket: string, filePath: string): string;
  /** Upload binary data to the given bucket/path and return the storage key. */
  uploadFile(bucket: string, path: string, data: Uint8Array | Buffer): Promise<string>;
  /** Download a file from storage. Returns null if the file does not exist. */
  downloadFile(bucket: string, path: string): Promise<Uint8Array | null>;
  /** Delete a file from storage. */
  deleteFile(bucket: string, path: string): Promise<void>;
}
