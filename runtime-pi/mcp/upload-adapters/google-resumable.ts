// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Google resumable upload adapter — covers Drive, Cloud Storage
 * (XML/JSON resumable), YouTube Data API uploads, and Photos.
 *
 * Wire reference: https://developers.google.com/workspace/drive/api/guides/manage-uploads#resumable
 *
 * Flow
 * ----
 *   1. POST `<target>?uploadType=resumable` with metadata as body
 *      and `X-Upload-Content-{Type,Length}` headers. Upstream replies
 *      `200 OK` with `Location: <session-url>` — that URL is the
 *      destination for every subsequent PUT. Sessions are valid for
 *      7 days.
 *   2. For each chunk: PUT `<session-url>` with
 *      `Content-Range: bytes <start>-<end>/<total>`. Mid-upload
 *      replies are `308 Resume Incomplete`; the FINAL chunk replies
 *      `200`/`201` with the file metadata (Drive: `File` resource).
 *   3. To cancel: DELETE `<session-url>`.
 *
 * Constraints
 * -----------
 *   - Chunk size MUST be a multiple of 256 KiB except the last chunk.
 *     We enforce this in `validatePartSize` (rounded up to the next
 *     256-KiB boundary).
 *   - The metadata body is JSON when `Content-Type` is
 *     `application/json` (Drive); GCS XML resumable also uses this
 *     adapter with metadata as raw bytes — adapters expose a
 *     `metadata` map that the agent may pass through verbatim.
 */

import type {
  AdapterContext,
  ChunkInfo,
  SessionState,
  UploadAdapter,
  UploadResult,
} from "./types.ts";

const GRID_BYTES = 256 * 1024; // 256 KiB
const DEFAULT_PART_SIZE = 8 * 1024 * 1024; // 8 MiB — divisible by 256 KiB

interface GoogleSessionState {
  /** Session URL returned by the init `Location:` header. */
  sessionUrl: string;
  /** Last response we got back from upstream (the FINAL one is the agent-visible result). */
  lastStatus: number;
  lastHeaders: Record<string, string>;
  lastBody: string;
}

export const googleResumableAdapter: UploadAdapter = {
  protocol: "google-resumable",
  defaultPartSizeBytes: DEFAULT_PART_SIZE,

  validatePartSize(partSizeBytes: number, totalBytes: number): number {
    if (!Number.isFinite(partSizeBytes) || partSizeBytes <= 0) {
      throw new Error(
        `google-resumable: partSizeBytes must be a positive integer, got ${partSizeBytes}`,
      );
    }
    // For files smaller than the chosen part size, just upload the
    // whole file in one PUT — the 256 KiB grid only matters when
    // there are multiple parts. Returning `totalBytes` collapses the
    // adapter to a single-chunk upload, which is still on the
    // resumable path (so a `Location:` is still issued, leaving room
    // for the agent to resume on retry).
    if (totalBytes <= partSizeBytes) return Math.max(totalBytes, 1);
    if (partSizeBytes % GRID_BYTES !== 0) {
      throw new Error(
        `google-resumable: partSizeBytes must be a multiple of ${GRID_BYTES} (256 KiB) ` +
          `for files larger than the chunk size; got ${partSizeBytes}`,
      );
    }
    return partSizeBytes;
  },

  async initSession(ctx: AdapterContext): Promise<SessionState> {
    // Metadata payload — the agent supplies it verbatim. Default to
    // `{}` so a metadata-less upload still works (some Drive endpoints
    // accept that).
    const metadataJson = JSON.stringify(ctx.metadata ?? {});
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(ctx.totalBytes),
    };
    // Optional declared upstream MIME — Drive ranks this above the
    // metadata-derived MIME for sniffing.
    const upstreamMime = ctx.metadata?.["mimeType"];
    if (typeof upstreamMime === "string" && upstreamMime.length > 0) {
      headers["X-Upload-Content-Type"] = upstreamMime;
    }
    const res = await ctx.providerCall({
      providerId: ctx.providerId,
      target: ctx.target,
      method: "POST",
      headers,
      body: metadataJson,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new InitFailureError(res.status, res.headers, res.body);
    }
    const sessionUrl = res.headers["location"];
    if (!sessionUrl) {
      throw new Error(
        `google-resumable: init response missing 'Location' header (got status ${res.status}). ` +
          `The provider's authorizedUris must allow the upload session URL — verify the manifest.`,
      );
    }
    return {
      sessionUrl,
      lastStatus: res.status,
      lastHeaders: res.headers,
      lastBody: res.body,
    } satisfies GoogleSessionState;
  },

  async uploadChunk(
    state: SessionState,
    chunk: ChunkInfo,
    ctx: AdapterContext,
  ): Promise<SessionState> {
    const s = state as GoogleSessionState;
    ctx.hashUpdate(chunk.bytes);
    const res = await ctx.providerCall({
      providerId: ctx.providerId,
      target: s.sessionUrl,
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.bytes.byteLength),
        "Content-Range": `bytes ${chunk.start}-${chunk.end}/${ctx.totalBytes}`,
      },
      body: chunk.bytes,
    });
    // 308 `Resume Incomplete` mid-upload, 200/201 on final chunk,
    // 4xx/5xx is fatal. We don't auto-retry on transient failures —
    // the agent surfaces the failure and decides whether to start a
    // new session (Drive sessions can be resumed via HEAD <session>
    // + Range, but cross-call resume drifts toward stateful behaviour
    // explicitly out of scope per ISSUE-283 §"Out of scope").
    if (chunk.final) {
      if (res.status !== 200 && res.status !== 201) {
        throw new ChunkFailureError(chunk.index, res.status, res.headers, res.body);
      }
    } else {
      if (res.status !== 308) {
        throw new ChunkFailureError(chunk.index, res.status, res.headers, res.body);
      }
    }
    return {
      ...s,
      lastStatus: res.status,
      lastHeaders: res.headers,
      lastBody: res.body,
    } satisfies GoogleSessionState;
  },

  async finalize(state: SessionState, _ctx: AdapterContext): Promise<UploadResult> {
    const s = state as GoogleSessionState;
    return {
      ok: true,
      status: s.lastStatus,
      headers: s.lastHeaders,
      body: s.lastBody,
      // Filled in by the resolver — adapter doesn't carry the SHA.
      sha256: "",
      size: 0,
    };
  },

  async abort(state: SessionState, ctx: AdapterContext): Promise<void> {
    const s = state as GoogleSessionState;
    if (!s.sessionUrl) return;
    try {
      await ctx.providerCall({
        providerId: ctx.providerId,
        target: s.sessionUrl,
        method: "DELETE",
      });
    } catch {
      // Best-effort — Drive logs the orphan; it expires after 7 days.
    }
  },
};

/**
 * Errors thrown by the adapter — captured by the resolver and
 * converted into structured `UploadFailure` results so the agent
 * sees a uniform shape regardless of which step failed.
 */
export class InitFailureError extends Error {
  constructor(
    public readonly status: number,
    public readonly headers: Record<string, string>,
    public readonly body: string,
  ) {
    super(`google-resumable: init failed (status ${status})`);
    this.name = "InitFailureError";
  }
}

export class ChunkFailureError extends Error {
  constructor(
    public readonly chunkIndex: number,
    public readonly status: number,
    public readonly headers: Record<string, string>,
    public readonly body: string,
  ) {
    super(`google-resumable: chunk ${chunkIndex} failed (status ${status})`);
    this.name = "ChunkFailureError";
  }
}
