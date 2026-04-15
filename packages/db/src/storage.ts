// SPDX-License-Identifier: Apache-2.0

import { getEnv } from "@appstrate/env";
import { createS3Storage } from "@appstrate/core/storage-s3";
import { createFileSystemStorage } from "@appstrate/core/storage-fs";
import type { Storage, CreateUploadUrlOptions, UploadUrlDescriptor } from "@appstrate/core/storage";

let store: Storage | null = null;

function getStore(): Storage {
  if (store) return store;
  const env = getEnv();

  if (env.S3_BUCKET) {
    store = createS3Storage({
      bucket: env.S3_BUCKET,
      region: env.S3_REGION!,
      endpoint: env.S3_ENDPOINT,
    });
  } else {
    store = createFileSystemStorage({
      basePath: env.FS_STORAGE_PATH,
      uploadBaseUrl: env.APP_URL,
      uploadSecret: env.UPLOAD_SIGNING_SECRET,
    });
  }

  return store;
}

export function uploadFile(
  bucket: string,
  path: string,
  data: Uint8Array | Buffer,
): Promise<string> {
  return getStore().uploadFile(bucket, path, data);
}

export function downloadFile(bucket: string, path: string): Promise<Uint8Array | null> {
  return getStore().downloadFile(bucket, path);
}

export function deleteFile(bucket: string, path: string): Promise<void> {
  return getStore().deleteFile(bucket, path);
}

export function fileExists(bucket: string, path: string): Promise<boolean> {
  return getStore().fileExists(bucket, path);
}

export function ensureBucket(): Promise<void> {
  return getStore().ensureBucket();
}

export function createUploadUrl(
  bucket: string,
  path: string,
  opts?: CreateUploadUrlOptions,
): Promise<UploadUrlDescriptor> {
  return getStore().createUploadUrl(bucket, path, opts);
}
