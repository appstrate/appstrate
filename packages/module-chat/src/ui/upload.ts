// SPDX-License-Identifier: Apache-2.0

/**
 * Composer upload helper — the 2-step staged upload the chat attachment adapter
 * drives, self-contained in the module (it cannot import apps/web's client).
 *
 * Step 1 POSTs an upload descriptor to `/api/uploads` with the SAME org/app/auth
 * headers the chat transport injects (`getHeaders`) plus the session cookie
 * (`credentials: "include"`), so it is authorized exactly like every other chat
 * call. Step 2 PUTs the raw bytes to the returned sink URL (S3/MinIO/FS — raw
 * fetch by design, only the descriptor's own headers). Returns the
 * `upload://upl_x` URI the server later materializes into a durable document.
 */

import type { GetHeaders } from "./runtime-context.ts";

/**
 * Client-side attachment size cap, aligned with the platform's per-upload limit
 * (`POST /api/uploads` rejects above 100 MB). This is a UX fast-path only — the
 * server is the authoritative gate and returns a 413 regardless; guarding here
 * just avoids starting an upload that is certain to be rejected.
 */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/**
 * Localized over-cap message surfaced by the composer (size guard in both the
 * upload staging and the attachment adapter). Derived from
 * {@link MAX_ATTACHMENT_BYTES} so the number never drifts from the constant.
 */
export const ATTACHMENT_TOO_LARGE_MESSAGE = `Fichier trop volumineux (${Math.round(
  MAX_ATTACHMENT_BYTES / 1024 / 1024,
)} Mo maximum).`;

/** Upload descriptor returned by `POST /api/uploads`. */
interface UploadDescriptor {
  uri: string;
  url: string;
  method: string;
  headers: Record<string, string>;
}

/**
 * Stage `file` and return its `upload://` URI. Throws on an over-cap file (a
 * localized message the adapter surfaces) or any transport failure.
 */
export async function uploadComposerFile(
  file: File,
  getHeaders: GetHeaders | null | undefined,
  signal?: AbortSignal,
): Promise<string> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(ATTACHMENT_TOO_LARGE_MESSAGE);
  }

  const descRes = await fetch("/api/uploads", {
    method: "POST",
    credentials: "include",
    headers: {
      ...getHeaders?.(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
    }),
    signal,
  });
  if (!descRes.ok) {
    throw new Error(`Échec de l'envoi du fichier (${descRes.status}).`);
  }
  const desc = (await descRes.json()) as UploadDescriptor;

  const putRes = await fetch(desc.url, {
    method: desc.method,
    headers: desc.headers,
    body: file,
    signal,
  });
  if (!putRes.ok) {
    throw new Error(`Échec de l'envoi du fichier (${putRes.status}).`);
  }
  return desc.uri;
}
