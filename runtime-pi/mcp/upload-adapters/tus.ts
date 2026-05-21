// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * tus 1.0.x resumable upload adapter — covers Cloudflare Stream,
 * Vimeo, self-hosted tusd, and the IETF "Resumable Uploads" draft
 * (which is wire-compatible with tus 1.0).
 *
 * Wire reference:
 *   https://tus.io/protocols/resumable-upload
 *
 * Flow
 * ----
 *   1. POST `<target>` with `Upload-Length: <total>`,
 *      `Tus-Resumable: 1.0.0`, optional `Upload-Metadata: ...`.
 *      Reply: `201 Created` with `Location: <session>`.
 *   2. PATCH `<session>` with `Content-Type: application/offset+octet-stream`,
 *      `Upload-Offset: <byte>`, `Tus-Resumable: 1.0.0`. Body is the chunk.
 *      Reply: `204 No Content` carrying the new `Upload-Offset:`.
 *   3. To cancel: DELETE `<session>` (Termination extension; not all
 *      servers support it — best-effort).
 *
 * Constraints: no part-size minimum or alignment. We pick a 4 MiB
 * default to stay well within the sidecar envelope.
 */

import {
  UploadError,
  type AdapterContext,
  type ChunkInfo,
  type SessionState,
  type UploadAdapter,
  type UploadResult,
} from "./types.ts";

const DEFAULT_PART_SIZE = 4 * 1024 * 1024;
const TUS_VERSION = "1.0.0";

interface TusSessionState {
  sessionUrl: string;
  /** Offset reported by the server after the most recent PATCH. */
  serverOffset: number;
  lastStatus: number;
  lastHeaders: Record<string, string>;
  lastBody: string;
}

export const tusAdapter: UploadAdapter = {
  protocol: "tus",
  defaultPartSizeBytes: DEFAULT_PART_SIZE,

  validatePartSize(partSizeBytes: number, totalBytes: number): number {
    if (!Number.isFinite(partSizeBytes) || partSizeBytes <= 0) {
      throw new Error(`tus: partSizeBytes must be a positive integer, got ${partSizeBytes}`);
    }
    return Math.min(partSizeBytes, Math.max(totalBytes, 1));
  },

  async initSession(ctx: AdapterContext): Promise<SessionState> {
    const headers: Record<string, string> = {
      "Tus-Resumable": TUS_VERSION,
      "Upload-Length": String(ctx.totalBytes),
      "Content-Length": "0",
    };
    // tus encodes metadata as a comma-separated list of `key
    // <base64-of-value>` pairs (note the literal space). The agent
    // supplies the unencoded map and we encode it here.
    const meta = encodeTusMetadata(ctx.metadata);
    if (meta) headers["Upload-Metadata"] = meta;

    const res = await ctx.providerCall({
      providerId: ctx.providerId,
      target: ctx.target,
      method: "POST",
      headers,
    });
    if (res.status !== 201) {
      throw new UploadError(
        `tus: Create failed (status ${res.status}; expected 201): ${res.body.slice(0, 256)}`,
        res.status,
        res.headers,
        res.body,
      );
    }
    const sessionUrl = res.headers["location"];
    if (!sessionUrl) {
      throw new UploadError(
        `tus: Create response missing Location header`,
        res.status,
        res.headers,
        res.body,
      );
    }
    return {
      sessionUrl: resolveLocation(ctx.target, sessionUrl),
      serverOffset: 0,
      lastStatus: res.status,
      lastHeaders: res.headers,
      lastBody: res.body,
    } satisfies TusSessionState;
  },

  async uploadChunk(
    state: SessionState,
    chunk: ChunkInfo,
    ctx: AdapterContext,
  ): Promise<SessionState> {
    const s = state as TusSessionState;
    if (chunk.start !== s.serverOffset) {
      throw new Error(
        `tus: client/server offset mismatch — chunk.start=${chunk.start}, server=${s.serverOffset}. ` +
          `This indicates a partial upload not detected by the sequential chunker.`,
      );
    }
    ctx.hashUpdate(chunk.bytes);
    const res = await ctx.providerCall({
      providerId: ctx.providerId,
      target: s.sessionUrl,
      method: "PATCH",
      headers: {
        "Tus-Resumable": TUS_VERSION,
        "Upload-Offset": String(s.serverOffset),
        "Content-Type": "application/offset+octet-stream",
        "Content-Length": String(chunk.bytes.byteLength),
      },
      body: chunk.bytes,
    });
    if (res.status !== 204 && res.status !== 200) {
      throw new UploadError(
        `tus: PATCH failed (status ${res.status}; expected 204): ${res.body.slice(0, 256)}`,
        res.status,
        res.headers,
        res.body,
      );
    }
    const newOffsetStr = res.headers["upload-offset"];
    const newOffset = newOffsetStr !== undefined ? parseInt(newOffsetStr, 10) : NaN;
    if (!Number.isFinite(newOffset)) {
      throw new UploadError(
        `tus: PATCH response missing/invalid Upload-Offset (got ${newOffsetStr})`,
        res.status,
        res.headers,
        res.body,
      );
    }
    if (newOffset !== chunk.end + 1) {
      throw new UploadError(
        `tus: server advanced to offset ${newOffset}, expected ${chunk.end + 1}. ` +
          `Refusing to continue with desynced state.`,
        res.status,
        res.headers,
        res.body,
      );
    }
    return {
      ...s,
      serverOffset: newOffset,
      lastStatus: res.status,
      lastHeaders: res.headers,
      lastBody: res.body,
    } satisfies TusSessionState;
  },

  async finalize(state: SessionState, ctx: AdapterContext): Promise<UploadResult> {
    const s = state as TusSessionState;
    if (s.serverOffset !== ctx.totalBytes) {
      return {
        ok: false,
        status: s.lastStatus,
        headers: s.lastHeaders,
        message: `tus: upload incomplete (server offset ${s.serverOffset}, expected ${ctx.totalBytes})`,
        body: s.lastBody,
      };
    }
    return { ok: true, status: s.lastStatus, headers: s.lastHeaders, body: s.lastBody };
  },

  async abort(state: SessionState, ctx: AdapterContext): Promise<void> {
    const s = state as TusSessionState;
    if (!s.sessionUrl) return;
    try {
      await ctx.providerCall({
        providerId: ctx.providerId,
        target: s.sessionUrl,
        method: "DELETE",
        headers: { "Tus-Resumable": TUS_VERSION },
      });
    } catch {
      // Best-effort — Termination extension is optional; servers that
      // don't implement it return 405. Either way, the session
      // expires per server policy.
    }
  },
};

/**
 * Encode metadata into the tus `Upload-Metadata` header value: a
 * comma-separated list of `key <base64>` pairs. Keys must contain
 * only ASCII printable characters and may not include space or
 * comma; we filter such keys out rather than producing an invalid
 * header value.
 */
function encodeTusMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(metadata)) {
    if (typeof v !== "string") continue;
    if (!/^[\x21-\x7E]+$/.test(k)) continue; // ASCII printable
    if (k.includes(",") || k.includes(" ")) continue;
    const b64 = Buffer.from(v, "utf-8").toString("base64");
    parts.push(`${k} ${b64}`);
  }
  return parts.length > 0 ? parts.join(",") : undefined;
}

/**
 * tus servers may return a relative `Location:` (e.g. `/files/abc`).
 * Resolve it against the request target. Absolute URLs pass through
 * unchanged.
 */
function resolveLocation(base: string, location: string): string {
  try {
    return new URL(location, base).toString();
  } catch {
    return location;
  }
}
