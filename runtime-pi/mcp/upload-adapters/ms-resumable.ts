// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Microsoft Graph resumable upload adapter — covers OneDrive,
 * SharePoint, and any Graph endpoint exposing `createUploadSession`.
 *
 * Wire reference:
 *   https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession
 *
 * Flow
 * ----
 *   1. POST `<target>` (the agent passes the `:/createUploadSession`
 *      endpoint) with metadata as JSON body. Reply: `200 OK` with
 *      JSON body `{ uploadUrl, expirationDateTime }`.
 *   2. PUT `<uploadUrl>` per chunk, with
 *      `Content-Range: bytes <start>-<end>/<total>`.
 *      Reply: `202 Accepted` mid-upload, `200`/`201` final + DriveItem JSON.
 *   3. To cancel: DELETE `<uploadUrl>`.
 *
 * Constraints
 * -----------
 *   - Microsoft requires part sizes that are multiples of 320 KiB
 *     (Graph documentation §"File size restrictions"). 5 MiB is
 *     recommended as a default; 60 MiB is the maximum per chunk.
 */

import {
  UploadError,
  type AdapterContext,
  type ChunkInfo,
  type SessionState,
  type UploadAdapter,
  type UploadResult,
} from "./types.ts";

const GRID_BYTES = 320 * 1024; // 320 KiB
const DEFAULT_PART_SIZE = 5 * 1024 * 1024; // 5 MiB — divisible by 320 KiB? No — but the protocol's grid only applies to non-final chunks
const MAX_PART_SIZE = 60 * 1024 * 1024; // 60 MiB upper bound per Graph

interface MsSessionState {
  uploadUrl: string;
  lastStatus: number;
  lastHeaders: Record<string, string>;
  lastBody: string;
}

export const msResumableAdapter: UploadAdapter = {
  protocol: "ms-resumable",
  defaultPartSizeBytes: DEFAULT_PART_SIZE,

  validatePartSize(partSizeBytes: number, totalBytes: number): number {
    if (!Number.isFinite(partSizeBytes) || partSizeBytes <= 0) {
      throw new Error(
        `ms-resumable: partSizeBytes must be a positive integer, got ${partSizeBytes}`,
      );
    }
    if (totalBytes <= partSizeBytes) return Math.max(totalBytes, 1);
    if (partSizeBytes > MAX_PART_SIZE) {
      throw new Error(
        `ms-resumable: partSizeBytes ${partSizeBytes} exceeds Graph's per-chunk maximum ${MAX_PART_SIZE} (60 MiB)`,
      );
    }
    if (partSizeBytes % GRID_BYTES !== 0) {
      throw new Error(
        `ms-resumable: partSizeBytes must be a multiple of ${GRID_BYTES} (320 KiB) for multi-part uploads, got ${partSizeBytes}`,
      );
    }
    return partSizeBytes;
  },

  async initSession(ctx: AdapterContext): Promise<SessionState> {
    // Graph expects the metadata wrapped in a JSON envelope —
    // `{ "item": { "@microsoft.graph.conflictBehavior": "replace", "name": "x" } }`.
    // Pass through whatever the agent supplied verbatim; if it's
    // empty, fall back to an empty `item` payload (Graph accepts
    // this and uses the URL's filename).
    const body = JSON.stringify(
      Object.keys(ctx.metadata ?? {}).length > 0 ? ctx.metadata : { item: {} },
    );
    const res = await ctx.providerCall({
      providerId: ctx.providerId,
      target: ctx.target,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new UploadError(
        `ms-resumable: createUploadSession failed (status ${res.status}): ${res.body.slice(0, 256)}`,
        res.status,
        res.headers,
        res.body,
      );
    }
    let parsed: { uploadUrl?: string };
    try {
      parsed = JSON.parse(res.body);
    } catch (err) {
      throw new UploadError(
        `ms-resumable: createUploadSession returned non-JSON body: ${err instanceof Error ? err.message : String(err)}`,
        res.status,
        res.headers,
        res.body,
      );
    }
    const uploadUrl = parsed.uploadUrl;
    if (!uploadUrl || typeof uploadUrl !== "string") {
      throw new UploadError(
        `ms-resumable: createUploadSession response missing uploadUrl`,
        res.status,
        res.headers,
        res.body,
      );
    }
    return {
      uploadUrl,
      lastStatus: res.status,
      lastHeaders: res.headers,
      lastBody: res.body,
    } satisfies MsSessionState;
  },

  async uploadChunk(
    state: SessionState,
    chunk: ChunkInfo,
    ctx: AdapterContext,
  ): Promise<SessionState> {
    const s = state as MsSessionState;
    ctx.hashUpdate(chunk.bytes);
    const res = await ctx.providerCall({
      providerId: ctx.providerId,
      target: s.uploadUrl,
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.bytes.byteLength),
        "Content-Range": `bytes ${chunk.start}-${chunk.end}/${ctx.totalBytes}`,
      },
      body: chunk.bytes,
    });
    if (chunk.final) {
      if (res.status !== 200 && res.status !== 201) {
        throw new UploadError(
          `ms-resumable: final chunk failed (status ${res.status}; expected 200/201): ${res.body.slice(0, 256)}`,
          res.status,
          res.headers,
          res.body,
        );
      }
    } else {
      // Mid-upload: Graph returns `202 Accepted` with `{ nextExpectedRanges }`.
      // We don't read `nextExpectedRanges` because our chunker is
      // sequential and never gets out of sync — but we do require
      // 202 so a non-202 mid-chunk fails fast.
      if (res.status !== 202) {
        throw new UploadError(
          `ms-resumable: mid-chunk PUT failed (status ${res.status}; expected 202): ${res.body.slice(0, 256)}`,
          res.status,
          res.headers,
          res.body,
        );
      }
    }
    return {
      ...s,
      lastStatus: res.status,
      lastHeaders: res.headers,
      lastBody: res.body,
    } satisfies MsSessionState;
  },

  async finalize(state: SessionState, _ctx: AdapterContext): Promise<UploadResult> {
    const s = state as MsSessionState;
    return { ok: true, status: s.lastStatus, headers: s.lastHeaders, body: s.lastBody };
  },

  async abort(state: SessionState, ctx: AdapterContext): Promise<void> {
    const s = state as MsSessionState;
    if (!s.uploadUrl) return;
    try {
      await ctx.providerCall({
        providerId: ctx.providerId,
        target: s.uploadUrl,
        method: "DELETE",
      });
    } catch {
      // Best-effort.
    }
  },
};
