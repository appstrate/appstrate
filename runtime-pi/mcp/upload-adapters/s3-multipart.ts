// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AWS S3 multipart upload adapter — also covers S3-compatible
 * services (R2, MinIO, Backblaze B2, Wasabi, GCS XML interop).
 *
 * Wire reference:
 *   https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html
 *
 * Three-step protocol:
 *   1. CreateMultipartUpload — POST `<target>?uploads`
 *      Response body is XML carrying `<UploadId>...</UploadId>`.
 *   2. UploadPart × N        — PUT `<target>?partNumber=<n>&uploadId=<id>`
 *      Response carries `ETag:` per part. We accumulate `(n, etag)`.
 *   3. CompleteMultipartUpload — POST `<target>?uploadId=<id>` with
 *      an XML body listing the part numbers and ETags. Response is
 *      either 200 + final XML or 200 + an XML error body (S3 quirk —
 *      a 200 with `<Error>` is a failure).
 *
 * Constraints
 * -----------
 *   - Each part EXCEPT the last must be ≥5 MiB (5 × 1024 × 1024 =
 *     5,242,880 bytes). Part numbers run 1..10000.
 *   - Total upload max: 5 TiB. Far above our `MAX_STREAMED_BODY_SIZE`
 *     (100 MB), so we never hit it.
 */

import type {
  AdapterContext,
  ChunkInfo,
  SessionState,
  UploadAdapter,
  UploadResult,
} from "./types.ts";

const MIN_PART_SIZE = 5 * 1024 * 1024; // 5 MiB — S3 protocol minimum
const DEFAULT_PART_SIZE = MIN_PART_SIZE; // Default to the minimum to keep memory bounded

interface S3SessionState {
  uploadId: string;
  parts: Array<{ partNumber: number; etag: string }>;
}

export const s3MultipartAdapter: UploadAdapter = {
  protocol: "s3-multipart",
  defaultPartSizeBytes: DEFAULT_PART_SIZE,

  validatePartSize(partSizeBytes: number, totalBytes: number): number {
    if (!Number.isFinite(partSizeBytes) || partSizeBytes <= 0) {
      throw new Error(
        `s3-multipart: partSizeBytes must be a positive integer, got ${partSizeBytes}`,
      );
    }
    // Single-chunk uploads bypass the minimum: when the file fits in
    // one part, we still issue init + 1 PUT + complete. The "5 MiB
    // minimum" rule only applies to non-final parts, so a 3 MB file
    // uploaded in one chunk is legal.
    if (totalBytes <= partSizeBytes) return Math.max(totalBytes, 1);
    if (partSizeBytes < MIN_PART_SIZE) {
      throw new Error(
        `s3-multipart: partSizeBytes ${partSizeBytes} below S3 minimum ${MIN_PART_SIZE} (5 MiB) ` +
          `for multi-part uploads. Use ≥5 MiB or upload the whole file in a single PUT (responseMode.* paths).`,
      );
    }
    return partSizeBytes;
  },

  async initSession(ctx: AdapterContext): Promise<SessionState> {
    const url = appendQuery(ctx.target, "uploads");
    // S3 carries metadata via headers (Cache-Control,
    // Content-Disposition, Content-Encoding, Content-Type, x-amz-meta-*).
    // Pass them through verbatim from `metadata` so the agent can set
    // whatever it needs.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(ctx.metadata ?? {})) {
      if (typeof v === "string") headers[k] = v;
    }
    const res = await ctx.providerCall({
      providerId: ctx.providerId,
      target: url,
      method: "POST",
      headers,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `s3-multipart: CreateMultipartUpload failed (status ${res.status}): ${truncateForError(res.body)}`,
      );
    }
    const uploadId = parseUploadId(res.body);
    if (!uploadId) {
      throw new Error(
        `s3-multipart: CreateMultipartUpload response missing <UploadId>: ${truncateForError(res.body)}`,
      );
    }
    return { uploadId, parts: [] } satisfies S3SessionState;
  },

  async uploadChunk(
    state: SessionState,
    chunk: ChunkInfo,
    ctx: AdapterContext,
  ): Promise<SessionState> {
    const s = state as S3SessionState;
    const partNumber = chunk.index + 1; // S3 part numbers are 1-indexed
    if (partNumber > 10000) {
      throw new Error(
        `s3-multipart: exceeded 10000-part limit at part ${partNumber}. Reduce partSizeBytes or split the upload.`,
      );
    }
    ctx.hashUpdate(chunk.bytes);
    const url = appendQuery(
      ctx.target,
      `partNumber=${partNumber}&uploadId=${encodeURIComponent(s.uploadId)}`,
    );
    const res = await ctx.providerCall({
      providerId: ctx.providerId,
      target: url,
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.bytes.byteLength),
      },
      body: chunk.bytes,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `s3-multipart: UploadPart ${partNumber} failed (status ${res.status}): ${truncateForError(res.body)}`,
      );
    }
    const etag = res.headers["etag"];
    if (!etag) {
      throw new Error(
        `s3-multipart: UploadPart ${partNumber} response missing ETag header (status ${res.status})`,
      );
    }
    return {
      uploadId: s.uploadId,
      parts: [...s.parts, { partNumber, etag }],
    } satisfies S3SessionState;
  },

  async finalize(state: SessionState, ctx: AdapterContext): Promise<UploadResult> {
    const s = state as S3SessionState;
    const url = appendQuery(ctx.target, `uploadId=${encodeURIComponent(s.uploadId)}`);
    const xml = buildCompleteMultipartUploadXml(s.parts);
    const res = await ctx.providerCall({
      providerId: ctx.providerId,
      target: url,
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: xml,
    });
    // S3 quirk: a 200 with an `<Error>` body in the XML is a failure.
    // Detect the error envelope by tag-name presence rather than full
    // parse — the response is short and well-formed.
    const bodyHasError = /<Error>/i.test(res.body);
    if (res.status < 200 || res.status >= 300 || bodyHasError) {
      return {
        ok: false,
        status: res.status,
        headers: res.headers,
        message: `s3-multipart: CompleteMultipartUpload returned ${res.status} ${bodyHasError ? "with <Error> body" : ""}`,
        body: res.body,
      };
    }
    return {
      ok: true,
      status: res.status,
      headers: res.headers,
      body: res.body,
      sha256: "",
      size: 0,
    };
  },

  async abort(state: SessionState, ctx: AdapterContext): Promise<void> {
    const s = state as S3SessionState;
    if (!s.uploadId) return;
    const url = appendQuery(ctx.target, `uploadId=${encodeURIComponent(s.uploadId)}`);
    try {
      await ctx.providerCall({
        providerId: ctx.providerId,
        target: url,
        method: "DELETE",
      });
    } catch {
      // Best-effort.
    }
  },
};

function appendQuery(url: string, query: string): string {
  return url.includes("?") ? `${url}&${query}` : `${url}?${query}`;
}

/**
 * Extract `<UploadId>...</UploadId>` from a CreateMultipartUpload
 * response. We avoid pulling in an XML parser (Bun has no built-in
 * `DOMParser` on the server side) — the regex is bounded to the
 * tag we expect, and S3's response is a fixed schema.
 */
function parseUploadId(xml: string): string | undefined {
  const m = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
  return m ? m[1] : undefined;
}

/**
 * Build the body for `CompleteMultipartUpload`. Order matters: parts
 * MUST be sorted by ascending `PartNumber`. We accumulate in upload
 * order which is already ascending, so a defensive sort is just
 * insurance.
 *
 * ETags are XML-escaped — they may contain `"` characters in the
 * AWS response (the leading/trailing quotes are part of the value).
 */
function buildCompleteMultipartUploadXml(
  parts: ReadonlyArray<{ partNumber: number; etag: string }>,
): string {
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const parts_xml = sorted
    .map(
      (p) =>
        `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${parts_xml}</CompleteMultipartUpload>`;
}

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function truncateForError(s: string): string {
  return s.length > 512 ? `${s.slice(0, 512)}…` : s;
}
