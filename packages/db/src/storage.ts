import { getEnv } from "@appstrate/env";
import { createS3Storage } from "@appstrate/core/storage-s3";
import type { Storage } from "@appstrate/core/storage";

let store: Storage | null = null;

function getStore(): Storage {
  if (store) return store;
  const env = getEnv();
  const s = createS3Storage({
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
  });
  store = s;
  return s;
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

export function ensureBucket(): Promise<void> {
  return getStore().ensureBucket();
}

export function safePath(bucket: string, filePath: string): string {
  return getStore().safePath(bucket, filePath);
}
