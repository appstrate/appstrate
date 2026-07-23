// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import type {
  Storage,
  CreateUploadUrlOptions,
  CreateDownloadUrlOptions,
  UploadUrlDescriptor,
} from "./storage.ts";
import { StorageAlreadyExistsError } from "./storage.ts";
import { createProxyUploadDescriptor } from "./storage-fs.ts";

/** Configuration for the S3 storage client. */
export interface S3StorageConfig {
  /** S3 bucket name. */
  bucket: string;
  /** AWS region (e.g. "us-east-1"). */
  region: string;
  /** Custom endpoint URL for S3-compatible services (MinIO, R2). Enables path-style access. */
  endpoint?: string;
  /**
   * Public endpoint used for presigned URLs. When set, `createUploadUrl()`
   * presigns direct-to-bucket PUT URLs against it — bytes bypass the
   * platform, so the bucket must be publicly reachable at this URL (the
   * GitLab `proxy_download: false` posture, for multi-node deployments that
   * want to offload upload traffic to S3). When unset and
   * `uploadBaseUrl`/`uploadSecret` are provided, uploads switch to proxy
   * mode instead (see `uploadBaseUrl`). When neither is configured,
   * presigning falls back to `endpoint` (legacy behavior for direct SDK
   * consumers).
   */
  publicEndpoint?: string;
  /**
   * Absolute public base URL of the platform API (e.g. `APP_URL`). Together
   * with `uploadSecret`, enables **proxy-upload mode** when `publicEndpoint`
   * is unset: `createUploadUrl()` returns an HMAC-signed URL on the app
   * domain (`PUT /api/uploads/_content`) and the platform streams the body
   * to S3 server-side — the bucket (e.g. a compose-internal MinIO) never
   * needs to be exposed on a second public FQDN.
   */
  uploadBaseUrl?: string;
  /**
   * Secret used to HMAC-sign proxy-upload tokens. Same keyring semantics as
   * the filesystem backend's `uploadSecret` (first key signs, all verify).
   */
  uploadSecret?: string | readonly string[];
}

/** S3 SDK error shape used for status code and name checks. */
type S3Error = { name?: string; $metadata?: { httpStatusCode?: number } };

/**
 * Create an S3-backed Storage implementation.
 * Supports AWS S3, MinIO, and Cloudflare R2 via configurable endpoint.
 * @param config - S3 connection configuration (bucket, region, optional endpoint)
 * @returns A Storage instance backed by S3
 */
export function createS3Storage(config: S3StorageConfig): Storage {
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
  });

  // Separate client for presigned URLs, for two reasons:
  //
  //  1. Endpoint: when a public endpoint is provided, the browser needs a URL
  //     it can reach, while the server-side SDK keeps talking to the internal
  //     endpoint.
  //  2. Checksums: since v3.729 the SDK defaults `requestChecksumCalculation`
  //     to WHEN_SUPPORTED, which makes the flexible-checksums middleware sign
  //     `x-amz-checksum-crc32` into presigned PutObject URLs. With no body at
  //     sign time the value is the CRC32 of the empty string (`AAAAAA==`), so
  //     S3 rejects every non-empty PUT unless the client overrides it with the
  //     real checksum header — an undocumented trap for direct-upload clients
  //     (aws-sdk-js-v3#6810). WHEN_REQUIRED keeps the checksum out of the
  //     signature so a plain PUT works. Integrity is not lost: upload size and
  //     magic-byte MIME are enforced server-side when the upload is consumed,
  //     and the regular (non-presign) client keeps default checksum behaviour.
  const presignEndpoint = config.publicEndpoint ?? config.endpoint;
  const presignClient = new S3Client({
    region: config.region,
    ...(presignEndpoint ? { endpoint: presignEndpoint, forcePathStyle: true } : {}),
    requestChecksumCalculation: "WHEN_REQUIRED",
  });

  function makeKey(bucket: string, filePath: string): string {
    const key = `${bucket}/${filePath}`.replace(/\/+/g, "/");
    if (key.includes("..")) throw new Error("Path traversal detected");
    return key;
  }

  return {
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
      } catch (e: unknown) {
        const err = e as S3Error;
        if (err.$metadata?.httpStatusCode === 404 || err.name === "NotFound") {
          throw new Error(`S3 bucket "${config.bucket}" does not exist`, { cause: e });
        }
        if (err.$metadata?.httpStatusCode === 403) {
          throw new Error(`No permission to access S3 bucket "${config.bucket}"`, { cause: e });
        }
        throw e;
      }
    },

    safePath(bucket, filePath) {
      return makeKey(bucket, filePath);
    },

    async uploadFile(bucket, path, data, opts) {
      const key = makeKey(bucket, path);
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: data,
            // S3 (as of 2024) supports `If-None-Match: *` on PutObject — it
            // fails with 412 Precondition Failed if the key already exists,
            // giving us an atomic create-new-or-fail primitive. Older S3-
            // compatible services may ignore it; callers that rely on
            // exclusivity for security should not use such backends.
            ...(opts?.exclusive ? { IfNoneMatch: "*" } : {}),
          }),
        );
      } catch (err: unknown) {
        if (opts?.exclusive) {
          const s3err = err as { name?: string; $metadata?: { httpStatusCode?: number } };
          if (
            s3err.name === "PreconditionFailed" ||
            s3err.$metadata?.httpStatusCode === 412 ||
            s3err.$metadata?.httpStatusCode === 409
          ) {
            throw new StorageAlreadyExistsError();
          }
        }
        throw err;
      }
      return key;
    },

    async uploadStream(bucket, path, stream, opts) {
      const key = makeKey(bucket, path);
      // `@aws-sdk/lib-storage` Upload runs a multipart upload that consumes the
      // source stream chunk-by-chunk with backpressure — no full buffering and
      // no need to know the content length up front.
      //
      // `partSize` is pinned to the 5 MiB S3 floor and `queueSize` to 1 so the
      // in-flight buffer is one part (~5 MiB) rather than the SDK default of
      // queueSize 4 × 5 MiB = ~20 MiB. This keeps per-stream memory bounded and
      // predictable when many documents stream concurrently; the trade-off is no
      // parallel part upload per object, which is fine for input documents
      // (modest sizes, latency dominated by the copy itself, not part fan-out).
      //
      // `exclusive` maps to `If-None-Match: *` — lib-storage forwards the param
      // to PutObject (bodies ≤ one part) and CompleteMultipartUpload (larger
      // bodies), both of which support conditional writes on S3 (since 2024)
      // and MinIO. Same atomic create-new-or-fail primitive as uploadFile.
      const upload = new Upload({
        client,
        params: {
          Bucket: config.bucket,
          Key: key,
          Body: stream,
          ...(opts?.exclusive ? { IfNoneMatch: "*" } : {}),
        },
        partSize: 5 * 1024 * 1024,
        queueSize: 1,
      });
      try {
        await upload.done();
      } catch (err: unknown) {
        // lib-storage aborts the multipart upload itself when a PART upload
        // (or the source stream) fails, but NOT when the final
        // CompleteMultipartUpload fails — which is exactly the
        // `If-None-Match` 412 path taken by a concurrent or replayed
        // exclusive PUT. Without an explicit abort the already-uploaded
        // parts are orphaned as an incomplete MPU: MinIO expires those
        // after ~24h, but AWS S3 / R2 retain (and bill) them indefinitely
        // unless the bucket has an AbortIncompleteMultipartUpload
        // lifecycle rule. `uploadId` is only set once the upload went
        // multipart; re-aborting an MPU lib-storage already cleaned up
        // 404s harmlessly (hence the swallow).
        const uploadId = (upload as unknown as { uploadId?: string }).uploadId;
        if (uploadId) {
          await client
            .send(
              new AbortMultipartUploadCommand({
                Bucket: config.bucket,
                Key: key,
                UploadId: uploadId,
              }),
            )
            .catch(() => {});
        }
        if (opts?.exclusive) {
          const s3err = err as S3Error;
          if (
            s3err.name === "PreconditionFailed" ||
            s3err.$metadata?.httpStatusCode === 412 ||
            s3err.$metadata?.httpStatusCode === 409
          ) {
            throw new StorageAlreadyExistsError();
          }
        }
        throw err;
      }
      return key;
    },

    async downloadFile(bucket, path) {
      try {
        const res = await client.send(
          new GetObjectCommand({
            Bucket: config.bucket,
            Key: makeKey(bucket, path),
          }),
        );
        return new Uint8Array(await res.Body!.transformToByteArray());
      } catch (e: unknown) {
        const err = e as S3Error;
        if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
          return null;
        }
        throw e;
      }
    },

    async downloadStream(bucket, path) {
      try {
        const res = await client.send(
          new GetObjectCommand({
            Bucket: config.bucket,
            Key: makeKey(bucket, path),
          }),
        );
        // SDK v3 exposes a Web ReadableStream view over the response body — pipe
        // it through without materialising the whole object in memory.
        return res.Body!.transformToWebStream();
      } catch (e: unknown) {
        const err = e as S3Error;
        if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
          return null;
        }
        throw e;
      }
    },

    async fileExists(bucket, path) {
      try {
        await client.send(
          new HeadObjectCommand({
            Bucket: config.bucket,
            Key: makeKey(bucket, path),
          }),
        );
        return true;
      } catch (e: unknown) {
        const err = e as S3Error;
        if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
          return false;
        }
        throw e;
      }
    },

    async deleteFile(bucket, path) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: makeKey(bucket, path),
        }),
      );
    },

    async createUploadUrl(
      bucket: string,
      path: string,
      opts?: CreateUploadUrlOptions,
    ): Promise<UploadUrlDescriptor> {
      const expiresIn = opts?.expiresIn ?? 900;
      const key = makeKey(bucket, path);
      // Proxy-upload mode (issue #829): no public S3 endpoint configured →
      // sign an app-domain URL instead of presigning against the bucket.
      // The platform's `/api/uploads/_content` sink streams the body to S3
      // through `uploadStream` (multipart, bounded memory, `If-None-Match`
      // exclusivity), so the blob store stays private. Setting
      // `publicEndpoint` opts back into direct presign for deployments that
      // want bytes off the platform's network path.
      if (!config.publicEndpoint && config.uploadBaseUrl && config.uploadSecret) {
        return createProxyUploadDescriptor(
          { uploadBaseUrl: config.uploadBaseUrl, uploadSecret: config.uploadSecret },
          key,
          opts,
        );
      }
      // ContentLength IS signed when the caller declares a size (`maxSize`):
      // `content-length` lands in X-Amz-SignedHeaders, so S3 rejects any PUT
      // whose Content-Length differs from the declared byte count. That makes
      // the declared size an upload-time contract — a client cannot reserve a
      // 1 KB slot and PUT 100 MB — instead of relying solely on the
      // server-side size check at consume time.
      const cmd = new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ...(opts?.mime ? { ContentType: opts.mime } : {}),
        ...(opts?.maxSize && opts.maxSize > 0 ? { ContentLength: opts.maxSize } : {}),
      });
      // `@aws-sdk/s3-request-presigner` and `@aws-sdk/client-s3` resolve to
      // different physical `@smithy/core` copies in the lockfile (transitive
      // aws-sdk deps pulled by other packages sit on an older smithy generation
      // than our direct s3 deps), so the shared `Client` base class has two
      // structurally identical but nominally distinct declarations. `S3Client`
      // is a valid argument at runtime; the cast bridges that type-identity gap
      // without widening to `any` (the command + options stay type-checked).
      const url = await getSignedUrl(
        presignClient as unknown as Parameters<typeof getSignedUrl>[0],
        cmd as unknown as Parameters<typeof getSignedUrl>[1],
        { expiresIn },
      );
      // Clients must echo the headers bound into the signature. Content-Length
      // is a forbidden header in browsers — fetch()/XHR set it automatically
      // from the body, so echoing the descriptor verbatim stays safe there;
      // listing it documents the exact byte count the signature requires.
      const headers: Record<string, string> = {};
      if (opts?.mime) headers["Content-Type"] = opts.mime;
      if (opts?.maxSize && opts.maxSize > 0) headers["Content-Length"] = String(opts.maxSize);
      return { url, method: "PUT", headers, expiresIn };
    },

    async createDownloadUrl(
      bucket: string,
      path: string,
      opts?: CreateDownloadUrlOptions,
    ): Promise<string | null> {
      // Only presign when a public endpoint is configured — same flip as
      // createUploadUrl (issue #829 / PR #830). Without it the bucket is
      // private (proxy mode) and a presigned URL against the internal endpoint
      // is not browser-reachable, so return null and let the caller
      // proxy-stream the bytes through the API.
      //
      // A presigned URL is only valid until the EARLIER of `expiresIn` and the
      // expiration of the credentials that signed it. Deployments that
      // authenticate via temporary credentials (IAM role / STS session) can see
      // URLs die before their nominal expiry — a 403 on a link we consider
      // valid. Documented in the self-hosting guide; keep `expiresIn` short so
      // the window where this matters stays small.
      if (!config.publicEndpoint) return null;
      const expiresIn = opts?.expiresIn ?? 900;
      const cmd = new GetObjectCommand({
        Bucket: config.bucket,
        Key: makeKey(bucket, path),
        ...(opts?.filename
          ? {
              ResponseContentDisposition: `attachment; filename="${opts.filename.replace(/"/g, "")}"`,
            }
          : {}),
        ...(opts?.contentType ? { ResponseContentType: opts.contentType } : {}),
      });
      return getSignedUrl(
        presignClient as unknown as Parameters<typeof getSignedUrl>[0],
        cmd as unknown as Parameters<typeof getSignedUrl>[1],
        { expiresIn },
      );
    },
  };
}
