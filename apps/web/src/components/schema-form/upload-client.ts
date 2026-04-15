// SPDX-License-Identifier: Apache-2.0

import { api } from "../../api";

interface UploadDescriptor {
  id: string;
  uri: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
}

/**
 * Upload a single `File` through the direct-upload protocol.
 *
 *   1. POST /api/uploads           → descriptor (signed URL)
 *   2. PUT  <descriptor.url>       → raw binary (either S3 or the FS sink)
 *
 * Returns the opaque `upload://upl_xxx` URI to embed inside form data.
 *
 * Errors propagate the server-side RFC 9457 detail message so the caller
 * can surface it to the user.
 *
 * `signal` lets callers cancel an in-flight upload (tab close, modal dismiss).
 * Progress reporting is intentionally not implemented here — `fetch()` offers
 * no upload-progress hook; wiring an XHR-based fallback is tracked separately.
 */
export async function uploadFile(file: File, signal?: AbortSignal): Promise<string> {
  const desc = await api<UploadDescriptor>("/uploads", {
    method: "POST",
    body: JSON.stringify({
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
    }),
    signal,
  });

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
}

export function isUploadUri(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("upload://");
}
