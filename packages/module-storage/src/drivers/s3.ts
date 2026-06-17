// SPDX-License-Identifier: Apache-2.0

/**
 * S3 cloud driver — a connected S3-compatible bucket (AWS S3, MinIO, R2…) via
 * `endpoint` + `force_path_style`. Full read/write/delete + list. Credentials
 * live encrypted on the disk row (the module talks to the bucket directly, so
 * it needs nothing from the platform's injected services).
 *
 * Config (wire snake_case, stored on the disk row):
 *   { bucket, region?, endpoint?, force_path_style?, prefix?,
 *     access_key_id, secret_access_key (encrypted at rest) }
 *
 * Incrementality: S3 cannot filter ListObjectsV2 by date server-side, so
 * listing is full each sync and the `since` watermark filters client-side on
 * LastModified (the sync re-checks per object anyway).
 */

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { decrypt } from "@appstrate/connect";
import type { StorageDriver, DriverObject, ObjectBytes } from "./types.ts";

interface S3Config {
  bucket: string;
  region?: string;
  endpoint?: string;
  force_path_style?: boolean;
  prefix?: string;
  access_key_id: string;
  /** Ciphertext (encrypted with the platform CONNECTION_ENCRYPTION_KEY). */
  secret_access_key: string;
}

function clientFor(config: S3Config): S3Client {
  return new S3Client({
    region: config.region ?? "us-east-1",
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.force_path_style ?? false,
    credentials: {
      accessKeyId: config.access_key_id,
      secretAccessKey: decrypt(config.secret_access_key),
    },
  });
}

/** Join the disk's configured prefix with an object name for writes. */
function keyFor(config: S3Config, name: string): string {
  const prefix = config.prefix?.replace(/\/+$/, "");
  return prefix ? `${prefix}/${name}` : name;
}

export function createS3Driver(rawConfig: Record<string, unknown>): StorageDriver {
  const config = rawConfig as unknown as S3Config;

  return {
    async *list(since): AsyncGenerator<DriverObject> {
      const client = clientFor(config);
      try {
        let continuationToken: string | undefined;
        do {
          const page = await client.send(
            new ListObjectsV2Command({
              Bucket: config.bucket,
              Prefix: config.prefix,
              ContinuationToken: continuationToken,
            }),
          );
          for (const object of page.Contents ?? []) {
            if (!object.Key || object.Key.endsWith("/")) continue;
            if (since && object.LastModified && object.LastModified <= since) continue;
            yield {
              driverKey: object.Key,
              name: object.Key.split("/").pop() ?? object.Key,
              mime: null,
              sizeBytes: object.Size ?? null,
              modifiedAt: object.LastModified ?? null,
            };
          }
          continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (continuationToken);
      } finally {
        client.destroy();
      }
    },

    async read(driverKey, mime): Promise<ObjectBytes | null> {
      const client = clientFor(config);
      try {
        const res = await client.send(
          new GetObjectCommand({ Bucket: config.bucket, Key: driverKey }),
        );
        const bytes = await res.Body?.transformToByteArray();
        if (bytes === undefined) return null;
        return { bytes, mime: res.ContentType ?? mime ?? "application/octet-stream" };
      } catch (err) {
        // Object vanished between listing and read → treat as absent.
        if ((err as { name?: string }).name === "NoSuchKey") return null;
        throw err;
      } finally {
        client.destroy();
      }
    },

    async write(name, mime, data): Promise<string> {
      const client = clientFor(config);
      const key = keyFor(config, name);
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: data,
            ContentType: mime,
          }),
        );
        return key;
      } finally {
        client.destroy();
      }
    },

    async remove(driverKey): Promise<void> {
      const client = clientFor(config);
      try {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: driverKey }));
      } finally {
        client.destroy();
      }
    },
  };
}
