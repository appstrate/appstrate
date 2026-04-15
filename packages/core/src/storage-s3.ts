// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Storage, CreateUploadUrlOptions, UploadUrlDescriptor } from "./storage.ts";
import { StorageAlreadyExistsError } from "./storage.ts";

/** Configuration for the S3 storage client. */
export interface S3StorageConfig {
  /** S3 bucket name. */
  bucket: string;
  /** AWS region (e.g. "us-east-1"). */
  region: string;
  /** Custom endpoint URL for S3-compatible services (MinIO, R2). Enables path-style access. */
  endpoint?: string;
  /** Public endpoint used only for presigned URLs. Falls back to `endpoint` when unset. */
  publicEndpoint?: string;
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

  // Separate client for presigned URLs when a public endpoint is provided.
  // The browser needs a URL it can reach, while the server-side SDK keeps
  // talking to the internal endpoint.
  const presignClient = config.publicEndpoint
    ? new S3Client({
        region: config.region,
        endpoint: config.publicEndpoint,
        forcePathStyle: true,
      })
    : client;

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
      // ContentLength is intentionally NOT signed — S3 would then require the
      // PUT to send exactly that many bytes, breaking any client-declared vs.
      // actual size mismatch. Size is enforced server-side on consume instead.
      const cmd = new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ...(opts?.mime ? { ContentType: opts.mime } : {}),
      });
      const url = await getSignedUrl(presignClient, cmd, { expiresIn });
      // Client must echo the same Content-Type declared in the signature.
      const headers: Record<string, string> = {};
      if (opts?.mime) headers["Content-Type"] = opts.mime;
      return { url, method: "PUT", headers, expiresIn };
    },
  };
}
