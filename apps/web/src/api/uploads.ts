// SPDX-License-Identifier: Apache-2.0

/**
 * Authed uploader for `<SchemaForm upload={...} />`, typed against the spec.
 * Step 1 (descriptor) goes through the typed client so `/api/uploads` gets the
 * same org/app headers and ApiError semantics as every other call; step 2 PUTs
 * the raw bytes to the returned pre-signed URL (S3/MinIO/FS sink — raw fetch
 * by design, no platform headers).
 */
import type { UploadFn } from "@appstrate/ui/schema-form";
import { client } from "./client";

export const uploadClient: UploadFn = async (file, signal) => {
  const { data: desc } = await client.POST("/api/uploads", {
    body: {
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
    },
    signal,
  });
  if (!desc) throw new Error("upload failed: empty descriptor response");

  const putRes = await fetch(desc.url, {
    method: desc.method,
    headers: desc.headers,
    body: file,
    signal,
  });
  if (!putRes.ok) {
    throw new Error(`upload failed: ${putRes.status} ${putRes.statusText}`);
  }
  return desc.uri;
};
