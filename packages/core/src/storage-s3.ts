// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import {
  S3Client,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import type { Storage } from "./storage.ts";

/** Configuration for the S3 storage client. */
export interface S3StorageConfig {
  /** S3 bucket name. */
  bucket: string;
  /** AWS region (e.g. "us-east-1"). */
  region: string;
  /** Custom endpoint URL for S3-compatible services (MinIO, R2). Enables path-style access. */
  endpoint?: string;
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

    async uploadFile(bucket, path, data) {
      const key = makeKey(bucket, path);
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: data,
        }),
      );
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

    async deleteFile(bucket, path) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: makeKey(bucket, path),
        }),
      );
    },
  };
}
