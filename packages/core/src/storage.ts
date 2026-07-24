// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/** Options for creating a direct-upload URL. */
export interface CreateUploadUrlOptions {
  /** Declared MIME type (advisory; storage adapters may enforce it in the signature). */
  mime?: string;
  /**
   * Declared upload size in bytes. Callers pass the EXACT size the client
   * declared: S3 signs it as the presigned PUT's `Content-Length` (the upload
   * is rejected unless the body is exactly that many bytes); filesystem
   * storage encodes it into the signed token as the upper bound the FS sink
   * enforces while streaming the body to disk.
   */
  maxSize?: number;
  /** Seconds until the URL expires. Default: 900 (15 min). */
  expiresIn?: number;
  /**
   * Optional client-declared SHA-256 of the payload, lowercase hex (64 chars).
   * When set the backend binds it so the upload is verified server-side:
   * S3/MinIO get an `x-amz-checksum-sha256` header signed into the presigned PUT
   * (rejected on mismatch); the proxy sink encodes it into the signed token so
   * `writeProxyUploadContent` re-hashes the streamed bytes and rejects a
   * mismatch. Omitted ⇒ no integrity binding (byte-identical to before).
   */
  sha256?: string;
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

/** Options for creating a direct-download URL. */
export interface CreateDownloadUrlOptions {
  /** Seconds until the URL expires. Default: 900 (15 min). */
  expiresIn?: number;
  /**
   * Filename to force in the `Content-Disposition: attachment` of the
   * downloaded response. When set, the backend binds a
   * `response-content-disposition` override into the presigned URL so the
   * browser saves rather than renders the object.
   */
  filename?: string;
  /** MIME to force in the downloaded response's `Content-Type`. */
  contentType?: string;
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

/** A single object enumerated by {@link Storage.listObjects}. */
export interface StorageObject {
  /**
   * Object key WITHIN the bucket (no `bucket/` prefix) — the exact form
   * `deleteFile` / `downloadFile` accept as their `path` argument.
   */
  key: string;
  /** Object size in bytes when the backend reports it (S3 always; filesystem via stat). */
  size?: number;
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
  /**
   * Stream binary data to the given bucket/path without buffering the whole
   * payload in memory. Prefer this over uploadFile() when the source is itself
   * a stream (e.g. copying a large object between buckets) — it pipes from the
   * source to the backend a chunk at a time. Backends: S3 uses a multipart
   * upload (`@aws-sdk/lib-storage`), which handles an unknown content length;
   * filesystem pipes the web stream straight to disk. Returns the storage key.
   *
   * `opts.exclusive` gives the same atomic create-new-or-fail semantics as
   * uploadFile(): filesystem opens the destination with `O_EXCL` (and removes
   * the partial file if the stream errors mid-write, so a retry is not
   * poisoned); S3 sends `If-None-Match: *` on PutObject / CompleteMultipart-
   * Upload (conditional writes, supported by AWS S3 and MinIO since 2024).
   * Throws `StorageAlreadyExistsError` when the object already exists.
   */
  uploadStream(
    bucket: string,
    path: string,
    stream: ReadableStream<Uint8Array>,
    opts?: UploadFileOptions,
  ): Promise<string>;
  /** Download a file from storage. Returns null if the file does not exist. */
  downloadFile(bucket: string, path: string): Promise<Uint8Array | null>;
  /**
   * Stream a file's bytes. Returns null if the file does not exist. Prefer this
   * over downloadFile() when serving a potentially large object straight to an
   * HTTP response — it pipes from the backend without buffering the whole
   * object in memory. Backends: S3 streams the GetObject body; filesystem
   * streams the file handle.
   */
  downloadStream(bucket: string, path: string): Promise<ReadableStream<Uint8Array> | null>;
  /** Delete a file from storage. */
  deleteFile(bucket: string, path: string): Promise<void>;
  /**
   * Report whether a file exists at the given path. Cheaper than downloadFile() —
   * backends implement via HEAD / stat, not a full fetch. Used by the direct-upload
   * sink to refuse overwrites on a single-use signed URL.
   */
  fileExists(bucket: string, path: string): Promise<boolean>;
  /**
   * Enumerate objects in a bucket, optionally filtered to those whose in-bucket
   * key starts with `prefix`. Yields keys WITHOUT the `bucket/` prefix (the form
   * deleteFile/downloadFile accept). Backends paginate internally (S3
   * ListObjectsV2 continuation tokens; filesystem recursive walk) and yield
   * lazily, so a caller can stream a large bucket without materialising the
   * whole listing. Used by the orphan-reconciliation operator tool.
   */
  listObjects(bucket: string, prefix?: string): AsyncIterable<StorageObject>;
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
  /**
   * Create a browser-usable URL the client can GET the object's bytes from
   * directly, without proxying through the API server. For S3 with a public
   * endpoint configured, this is a pre-signed GET URL (the download analog of
   * {@link createUploadUrl}'s presign path). Returns `null` when the backend
   * cannot produce a browser-reachable URL — filesystem storage, and S3 in
   * proxy mode (no public endpoint, the bucket stays private) — in which case
   * the caller must proxy-stream the bytes itself.
   */
  createDownloadUrl(
    bucket: string,
    path: string,
    opts?: CreateDownloadUrlOptions,
  ): Promise<string | null>;
}
