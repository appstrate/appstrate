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

/**
 * Test seam, last and defaulted.
 * The spec paths are relative (`/api/uploads`) because the SPA is served
 * same-origin, and a relative URL only resolves against a document — outside a
 * browser the typed client cannot even construct its Request, so the descriptor
 * call is injected rather than stubbed on `globalThis.fetch`. Injecting the PUT
 * as well keeps the two legs independently observable.
 */
interface UploadDeps {
  client: Pick<typeof client, "POST">;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

const defaultDeps: UploadDeps = {
  client,
  // Bound at call time rather than captured, so the live global always wins.
  fetch: (input, init) => globalThis.fetch(input, init),
};

/**
 * Stages `file` and returns its `upload://` URI. `spaceId` names the space the upload lands in
 * (the chat, which attaches in a space it chose); absent, the working space, as the client's
 * middleware fills it.
 */
export async function uploadInSpace(
  file: File,
  spaceId: string | undefined,
  signal?: AbortSignal,
  deps: UploadDeps = defaultDeps,
): Promise<string> {
  const { data: desc } = await deps.client.POST("/api/uploads", {
    body: {
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
    },
    ...(spaceId ? { params: { header: { "X-Space-Id": spaceId } } } : {}),
    signal,
  });
  if (!desc) throw new Error("upload failed: empty descriptor response");

  const putRes = await deps.fetch(desc.url, {
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

export const uploadClient = ((file, signal) =>
  uploadInSpace(file, undefined, signal)) satisfies UploadFn;
