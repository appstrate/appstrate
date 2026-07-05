// SPDX-License-Identifier: Apache-2.0

/**
 * S3-backend-specific proxy-sink tests (issue #829) — run only when the test
 * tier provides a real MinIO (`describeRequiresS3` skips at TEST_TIER=0,
 * where the storage backend is the filesystem).
 *
 * The interesting failure mode here is multipart hygiene: bodies larger than
 * lib-storage's 5 MiB part floor go through CreateMultipartUpload →
 * UploadPart → CompleteMultipartUpload, and the `If-None-Match: *`
 * exclusivity that protects against token replay is only evaluated at the
 * COMPLETE step. lib-storage aborts the MPU itself when a part upload fails,
 * but not when the complete fails — without the explicit abort in
 * `createS3Storage().uploadStream()`, every replayed/raced >5 MiB PUT would
 * strand an incomplete multipart upload (billed parts on AWS/R2; ~24h of
 * dead space on MinIO).
 */

import { it, expect } from "bun:test";
import { S3Client, ListMultipartUploadsCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { describeRequiresS3 } from "../../helpers/tier.ts";
import { writeProxyUploadContent } from "../../../src/services/uploads.ts";
import { ApiError } from "../../../src/lib/errors.ts";

const UPLOAD_BUCKET = "uploads";

/** Raw S3 client against the test MinIO — mirrors the env the preload sets. */
function rawClient(): S3Client {
  return new S3Client({
    region: process.env.S3_REGION ?? "us-east-1",
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
  });
}

/** Multi-chunk stream big enough to force lib-storage into multipart mode. */
function bigBodyStream(totalBytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1024 * 1024).fill(7);
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunk.byteLength, totalBytes - sent);
      controller.enqueue(size === chunk.byteLength ? chunk : chunk.slice(0, size));
      sent += size;
    },
  });
}

describeRequiresS3("proxy sink on the S3 backend — multipart hygiene", () => {
  it("replayed >5MiB PUT against an existing object 409s AND leaves no orphaned multipart upload", async () => {
    const unique = `upl_mpu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const storagePath = `sink-s3-test/${unique}/file.bin`;
    const key = `${UPLOAD_BUCKET}/${storagePath}`;
    const bucket = process.env.S3_BUCKET!;
    const client = rawClient();

    // Winner: the object already exists at the key (a prior successful PUT).
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: new Uint8Array([1, 2, 3]),
      }),
    );

    // Loser: a replayed PUT with a >5 MiB body — goes multipart, uploads its
    // parts, then fails CompleteMultipartUpload on `If-None-Match: *` (412).
    const size = 6 * 1024 * 1024;
    try {
      await writeProxyUploadContent(key, bigBodyStream(size), size);
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(409);
    }

    // The failed completion must not strand an incomplete multipart upload.
    const mpus = await client.send(
      new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key }),
    );
    expect(mpus.Uploads ?? []).toEqual([]);
  });
});
