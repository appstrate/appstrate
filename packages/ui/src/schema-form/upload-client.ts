// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

// Tiny direct-upload client used by the FileWidget. The endpoint path is
// configurable so the same widget works against Appstrate's `/api/uploads`
// and Portal's `/share/:token/uploads` proxy.

interface UploadDescriptor {
  id: string;
  uri: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
}

export interface UploadFn {
  (file: File, signal?: AbortSignal): Promise<string>;
}

/**
 * Build an upload function bound to a specific POST endpoint. Returns the
 * opaque `upload://upl_xxx` URI on success.
 *
 * Errors propagate the server-side RFC 9457 detail message so the caller
 * can surface it to the user.
 *
 * `signal` lets callers cancel an in-flight upload.
 */
export function createUploader(uploadPath: string): UploadFn {
  return async (file, signal) => {
    const descRes = await fetch(uploadPath, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
      }),
      signal,
    });
    if (!descRes.ok) {
      const body = (await descRes.json().catch(() => ({ detail: descRes.statusText }))) as {
        detail?: string;
      };
      throw new Error(body.detail ?? `upload init failed: ${descRes.status}`);
    }
    const desc = (await descRes.json()) as UploadDescriptor;

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
}

export function isUploadUri(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("upload://");
}
