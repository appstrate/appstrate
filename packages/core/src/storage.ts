// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/** Options for creating a direct-upload URL. */
export interface CreateUploadUrlOptions {
  /** Declared MIME type (advisory; storage adapters may enforce it in the signature). */
  mime?: string;
  /** Maximum allowed upload size in bytes (adapters enforce when possible). */
  maxSize?: number;
  /** Seconds until the URL expires. Default: 900 (15 min). */
  expiresIn?: number;
}

/** Returned descriptor for a client-side direct upload. */
export interface UploadUrlDescriptor {
  /** Absolute URL the client should PUT the binary to. */
  url: string;
  /** HTTP method to use (always "PUT" for current backends, kept for forward-compat). */
  method: "PUT";
  /** Headers the client MUST send with the upload request. */
  headers: Record<string, string>;
  /** Seconds until the upload URL expires (mirrors opts.expiresIn, resolved). */
  expiresIn: number;
}

/** Options for uploading a file. */
export interface UploadFileOptions {
  /**
   * When true, refuse to overwrite an existing object at the same key.
   * Implemented via `O_EXCL` on filesystem storage and `If-None-Match: *`
   * on S3. Throws `StorageAlreadyExistsError` if the object already exists.
   */
  exclusive?: boolean;
}

/** Thrown by `uploadFile` when `exclusive: true` and the target already exists. */
export class StorageAlreadyExistsError extends Error {
  readonly code = "STORAGE_ALREADY_EXISTS" as const;
  constructor(message = "storage object already exists") {
    super(message);
    this.name = "StorageAlreadyExistsError";
  }
}

/** Abstract file storage interface for bucket-based object storage. */
export interface Storage {
  /** Verify that the backing storage bucket exists and is accessible. */
  ensureBucket(): Promise<void>;
  /** Build a safe, normalized storage key from a bucket prefix and file path. */
  safePath(bucket: string, filePath: string): string;
  /** Upload binary data to the given bucket/path and return the storage key. */
  uploadFile(
    bucket: string,
    path: string,
    data: Uint8Array | Buffer,
    opts?: UploadFileOptions,
  ): Promise<string>;
  /** Download a file from storage. Returns null if the file does not exist. */
  downloadFile(bucket: string, path: string): Promise<Uint8Array | null>;
  /** Delete a file from storage. */
  deleteFile(bucket: string, path: string): Promise<void>;
  /**
   * Report whether a file exists at the given path. Cheaper than downloadFile() —
   * backends implement via HEAD / stat, not a full fetch. Used by the direct-upload
   * sink to refuse overwrites on a single-use signed URL.
   */
  fileExists(bucket: string, path: string): Promise<boolean>;
  /**
   * Create a URL the client can PUT a binary payload to directly, without proxying
   * through the API server. For S3, this is a pre-signed URL. For filesystem storage,
   * this is a short-lived signed URL pointing at an internal API route.
   */
  createUploadUrl(
    bucket: string,
    path: string,
    opts?: CreateUploadUrlOptions,
  ): Promise<UploadUrlDescriptor>;
}
