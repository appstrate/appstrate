// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * `McpProviderUploadResolver` — orchestrates chunked file uploads
 * over the existing `provider_call` MCP tool.
 *
 * Why not a new sidecar tool: the chunking logic is purely client-
 * side state. The sidecar's `provider_call` already does the right
 * thing per chunk (credential injection, `authorizedUris` check,
 * response-header propagation via `_meta`). Putting the
 * orchestration here keeps the sidecar dumb (no workspace mount, no
 * upload-protocol awareness, no new attack surface) and the
 * credential-isolation invariant unchanged.
 *
 * Lifecycle
 * ---------
 *   1. Validate the file exists, fits inside `MAX_STREAMED_BODY_SIZE`,
 *      and is reachable via `resolveSafeFile` (workspace root +
 *      symlink refusal — same path safety as `provider_call`).
 *   2. Resolve the adapter from the protocol enum.
 *   3. `adapter.initSession(ctx)` — one MCP call.
 *   4. Stream the file via `Bun.file().stream()`, slicing into
 *      `partSizeBytes`-sized chunks; for each chunk call
 *      `adapter.uploadChunk(state, chunk, ctx)`.
 *   5. `adapter.finalize(state, ctx)` — for protocols where the
 *      last chunk's response IS the final response this is a no-op
 *      that returns the captured response; for S3 it issues
 *      `CompleteMultipartUpload`.
 *   6. On any error or `ctx.signal` abort, `adapter.abort(state, ctx)`
 *      runs best-effort to free upstream resources.
 *
 * SHA-256 is computed incrementally over the bytes the adapter
 * commits to the wire (after `validatePartSize`'s clamp). The hash
 * is surfaced in the result so the agent (and post-upload audits)
 * can verify byte-equivalence.
 */

import {
  resolveSafeFile,
  MAX_STREAMED_BODY_SIZE,
  type ProviderCallContext,
} from "@appstrate/afps-runtime/resolvers";
import type { AppstrateMcpClient } from "@appstrate/mcp-transport";
import {
  ADAPTERS,
  type AdapterContext,
  type AdapterProviderCallRequest,
  type AdapterProviderResponse,
  type ChunkInfo,
  type UploadAdapter,
  type UploadProtocol,
  type UploadResult,
} from "./upload-adapters/index.ts";
import { readUpstreamMeta } from "./upstream-meta.ts";

const PROVIDER_CALL_TOOL_NAME = "provider_call";

/**
 * Agent-supplied request shape — mirrors the Pi tool input schema.
 * The resolver validates these inside `executeUpload` so the surface
 * is a single function, easy to unit-test.
 */
export interface ProviderUploadRequest {
  providerId: string;
  target: string;
  fromFile: string;
  uploadProtocol: UploadProtocol;
  metadata?: Record<string, unknown>;
  partSizeBytes?: number;
}

/**
 * Final result surfaced to the LLM. The resolver keeps this small
 * and uniform — the agent's mental model doesn't care which protocol
 * was used, only "did it succeed, what did the upstream say, what's
 * the hash for verification".
 */
export type ProviderUploadResult =
  | {
      ok: true;
      protocol: UploadProtocol;
      /** Final upstream HTTP status. */
      status: number;
      /** Allowlisted final upstream response headers. */
      headers: Record<string, string>;
      /** Final upstream response body — protocol-specific. */
      body: string;
      /** SHA-256 (hex, lowercase) of the bytes uploaded. */
      sha256: string;
      /** Total bytes uploaded. */
      size: number;
      /** Number of chunks dispatched (= 1 for files smaller than partSizeBytes). */
      chunks: number;
    }
  | {
      ok: false;
      protocol: UploadProtocol;
      /** Last upstream HTTP status (may be 0 for pre-flight failures). */
      status: number;
      /** Last upstream response headers. */
      headers: Record<string, string>;
      /** Human-readable error. */
      error: string;
      /** Upstream response body, if the failure was a protocol-level error. */
      body?: string;
      /** Bytes successfully transmitted before failure. */
      bytesSent: number;
    };

export class McpProviderUploadResolver {
  constructor(private readonly mcp: AppstrateMcpClient) {}

  /**
   * Execute one upload. The single entry point used by the Pi tool
   * extension and by tests — keeps the surface narrow.
   */
  async executeUpload(
    req: ProviderUploadRequest,
    ctx: ProviderCallContext,
  ): Promise<ProviderUploadResult> {
    const adapter = ADAPTERS[req.uploadProtocol];
    if (!adapter) {
      return {
        ok: false,
        protocol: req.uploadProtocol,
        status: 0,
        headers: {},
        error: `Unknown upload protocol '${req.uploadProtocol}'. Known: ${Object.keys(ADAPTERS).join(", ")}.`,
        bytesSent: 0,
      };
    }

    // Resolve the workspace-relative path with the same safety the
    // provider_call resolver applies — symlinks refused, escapes
    // refused. Throws on violation (caught and structured below).
    let absPath: string;
    let totalBytes: number;
    try {
      const resolved = await resolveSafeFile(ctx.workspace, req.fromFile);
      absPath = resolved.absPath;
      totalBytes = resolved.stat.size;
    } catch (err) {
      return {
        ok: false,
        protocol: req.uploadProtocol,
        status: 0,
        headers: {},
        error: `provider_upload: cannot read ${JSON.stringify(req.fromFile)}: ${err instanceof Error ? err.message : String(err)}`,
        bytesSent: 0,
      };
    }
    if (totalBytes === 0) {
      return {
        ok: false,
        protocol: req.uploadProtocol,
        status: 0,
        headers: {},
        error: `provider_upload: file ${JSON.stringify(req.fromFile)} is empty — chunked uploads require ≥1 byte`,
        bytesSent: 0,
      };
    }
    if (totalBytes > MAX_STREAMED_BODY_SIZE) {
      return {
        ok: false,
        protocol: req.uploadProtocol,
        status: 0,
        headers: {},
        error: `provider_upload: file ${totalBytes} bytes exceeds streaming ceiling ${MAX_STREAMED_BODY_SIZE} (${Math.round(MAX_STREAMED_BODY_SIZE / 1024 / 1024)} MB). Set MAX_STREAMED_BODY_SIZE on the runtime to raise it.`,
        bytesSent: 0,
      };
    }

    // Validate (and possibly clamp) the requested part size against
    // protocol-specific constraints.
    let partSizeBytes: number;
    try {
      partSizeBytes = adapter.validatePartSize(
        req.partSizeBytes ?? adapter.defaultPartSizeBytes,
        totalBytes,
      );
    } catch (err) {
      return {
        ok: false,
        protocol: req.uploadProtocol,
        status: 0,
        headers: {},
        error: err instanceof Error ? err.message : String(err),
        bytesSent: 0,
      };
    }

    const hasher = await createSha256Hasher();
    let bytesSent = 0;

    const adapterCtx: AdapterContext = {
      providerId: req.providerId,
      target: req.target,
      totalBytes,
      metadata: req.metadata ?? {},
      partSizeBytes,
      providerCall: this.makeProviderCall(ctx),
      signal: ctx.signal,
      hashUpdate: (bytes) => {
        hasher.update(bytes);
        bytesSent += bytes.byteLength;
      },
    };

    // Phase 1: init session.
    let state;
    try {
      throwIfAborted(ctx.signal);
      state = await adapter.initSession(adapterCtx);
    } catch (err) {
      return failure(adapter, err, 0);
    }

    // Phase 2: chunked upload. We use a single try/finally so an
    // abort or thrown error inside the loop still triggers the
    // adapter's best-effort `abort(state)`.
    let chunkIndex = 0;
    try {
      const stream = openFileStream(absPath);
      const reader = stream.getReader();
      try {
        const iter = chunkBytes(reader, partSizeBytes, totalBytes);
        for await (const chunk of iter) {
          throwIfAborted(ctx.signal);
          state = await adapter.uploadChunk(state, chunk, adapterCtx);
          chunkIndex = chunk.index + 1;
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      // Best-effort cleanup before reporting.
      void adapter.abort(state, adapterCtx).catch(() => {});
      return failure(adapter, err, bytesSent);
    }

    // Phase 3: finalise.
    let finalResult: UploadResult;
    try {
      throwIfAborted(ctx.signal);
      finalResult = await adapter.finalize(state, adapterCtx);
    } catch (err) {
      void adapter.abort(state, adapterCtx).catch(() => {});
      return failure(adapter, err, bytesSent);
    }

    if (!finalResult.ok) {
      return {
        ok: false,
        protocol: adapter.protocol,
        status: finalResult.status,
        headers: finalResult.headers,
        error: finalResult.message,
        ...(finalResult.body !== undefined ? { body: finalResult.body } : {}),
        bytesSent,
      };
    }

    return {
      ok: true,
      protocol: adapter.protocol,
      status: finalResult.status,
      headers: finalResult.headers,
      body: finalResult.body,
      sha256: hasher.digestHex(),
      size: bytesSent,
      chunks: chunkIndex,
    };
  }

  /**
   * Build the per-call adapter dispatch helper. Wraps `mcp.callTool`
   * with body encoding (string or Uint8Array → MCP `body` shape) and
   * upstream-meta unwrapping.
   *
   * Tool-level errors (`isError: true`) are NOT surfaced as throws
   * here — the adapter receives the upstream status/headers and
   * decides for itself whether to fail the upload. Some protocols
   * deliberately use 4xx status as control flow (S3's
   * `<Error>`-in-200 quirk is the converse — adapter decides).
   */
  private makeProviderCall(callerCtx: ProviderCallContext) {
    return async (req: AdapterProviderCallRequest): Promise<AdapterProviderResponse> => {
      const args: Record<string, unknown> = {
        providerId: req.providerId,
        target: req.target,
        method: req.method,
      };
      if (req.headers && Object.keys(req.headers).length > 0) args.headers = req.headers;
      if (req.body !== undefined) {
        if (typeof req.body === "string") {
          args.body = req.body;
        } else {
          args.body = {
            fromBytes: encodeBase64(req.body),
            encoding: "base64",
          };
        }
      }
      const result = await this.mcp.callTool(
        { name: PROVIDER_CALL_TOOL_NAME, arguments: args },
        { signal: callerCtx.signal },
      );
      const meta = readUpstreamMeta(result);
      // Upload-protocol responses are small (Drive: ~1KB JSON; S3:
      // ~500B XML; tus: empty 204; MS: ~1KB JSON). They sit well
      // under the sidecar's INLINE_RESPONSE_THRESHOLD (32 KB), so
      // every response arrives as inline text blocks — concatenate
      // them and we're done.
      const body = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      // When sidecar shipped meta, use it; else fall back to a
      // synthetic 200 / no headers (matches legacy `provider_call`
      // behaviour and lets adapters running against a stub server
      // that never set meta still work).
      return {
        status: meta?.status ?? (result.isError ? 502 : 200),
        headers: meta?.headers ?? {},
        body,
      };
    };
  }
}

/**
 * Open a workspace file as a chunked `ReadableStream<Uint8Array>`.
 * Uses Bun's native `Bun.file(path).stream()` when available, with
 * a Node fallback so the resolver works in both runtimes (Bun in
 * production; Node only in mixed-runtime tests, none today).
 */
function openFileStream(absPath: string): ReadableStream<Uint8Array> {
  const bunGlobal = (
    globalThis as { Bun?: { file: (p: string) => { stream: () => ReadableStream<Uint8Array> } } }
  ).Bun;
  if (bunGlobal && typeof bunGlobal.file === "function") {
    return bunGlobal.file(absPath).stream();
  }
  // Lazy load to avoid pulling node:fs into pure-Bun runtimes.
  const mod = require("node:fs") as typeof import("node:fs");
  const stream = mod.createReadStream(absPath);
  // node:stream Readable.toWeb gives a ReadableStream<Buffer | string>;
  // we know the source is binary so the cast is safe.
  const { Readable } = require("node:stream") as typeof import("node:stream");
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

/**
 * Async iterator over fixed-size byte chunks read from a
 * `ReadableStreamDefaultReader<Uint8Array>`. Buffers across reader
 * boundaries so a 4 MiB chunk gets emitted regardless of how the
 * source paginates the bytes (Bun emits 64 KiB blocks; Node's fs
 * stream uses 64 KiB by default).
 *
 * The final chunk may be shorter than `partSizeBytes` and carries
 * `final: true`. The total bytes emitted MUST equal `totalBytes`
 * — a mismatch (rare: file truncated mid-upload) throws so the
 * adapter doesn't see a malformed stream.
 */
async function* chunkBytes(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  partSizeBytes: number,
  totalBytes: number,
): AsyncIterable<ChunkInfo> {
  let buffer = new Uint8Array(0);
  let offset = 0;
  let chunkIndex = 0;
  let done = false;
  while (!done) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) {
      done = true;
    } else if (value) {
      const merged = new Uint8Array(buffer.byteLength + value.byteLength);
      merged.set(buffer, 0);
      merged.set(value, buffer.byteLength);
      buffer = merged;
    }
    while (buffer.byteLength >= partSizeBytes) {
      const slice = buffer.subarray(0, partSizeBytes);
      const remaining = buffer.subarray(partSizeBytes);
      // `final` is determined purely by byte arithmetic against the
      // pre-known totalBytes — we don't need to wait for `done`. This
      // matters because the source stream's read-block size (typically
      // 64 KiB) is much smaller than partSizeBytes, so a `done=true`
      // tick frequently arrives in a SUBSEQUENT iteration after the
      // last full slice is already in the buffer.
      const isFinal = offset + slice.byteLength === totalBytes;
      yield {
        index: chunkIndex,
        start: offset,
        end: offset + slice.byteLength - 1,
        bytes: slice,
        final: isFinal,
      };
      chunkIndex += 1;
      offset += slice.byteLength;
      // Re-anchor `buffer` so we don't keep large slices alive when
      // the source emits big blocks.
      buffer = new Uint8Array(remaining);
    }
  }
  if (buffer.byteLength > 0) {
    yield {
      index: chunkIndex,
      start: offset,
      end: offset + buffer.byteLength - 1,
      bytes: buffer,
      final: true,
    };
    offset += buffer.byteLength;
  }
  if (offset !== totalBytes) {
    throw new Error(
      `provider_upload: stream ended at byte ${offset}, expected ${totalBytes}. File may have been truncated mid-upload.`,
    );
  }
}

/**
 * Streaming SHA-256 hasher. Uses `Bun.CryptoHasher` when available
 * (built-in, single-pass) and falls back to `node:crypto` otherwise.
 */
async function createSha256Hasher(): Promise<{
  update: (bytes: Uint8Array) => void;
  digestHex: () => string;
}> {
  const bunGlobal = (globalThis as { Bun?: { CryptoHasher: new (alg: string) => BunCryptoHasher } })
    .Bun;
  if (bunGlobal && typeof bunGlobal.CryptoHasher === "function") {
    const h = new bunGlobal.CryptoHasher("sha256");
    return {
      update: (bytes) => {
        h.update(bytes);
      },
      digestHex: () => h.digest("hex"),
    };
  }
  const crypto = await import("node:crypto");
  const h = crypto.createHash("sha256");
  return {
    update: (bytes) => {
      h.update(bytes);
    },
    digestHex: () => h.digest("hex"),
  };
}

interface BunCryptoHasher {
  update(bytes: Uint8Array): void;
  digest(encoding: "hex"): string;
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
  }
}

function failure(adapter: UploadAdapter, err: unknown, bytesSent: number): ProviderUploadResult {
  // Adapter errors carry structured upstream context when they
  // came from a non-2xx upstream — surface that to the agent.
  const e = err as {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    message?: string;
  };
  const status = typeof e.status === "number" ? e.status : 0;
  const headers = e.headers && typeof e.headers === "object" ? e.headers : {};
  const message = e.message ?? (err instanceof Error ? err.message : String(err));
  return {
    ok: false,
    protocol: adapter.protocol,
    status,
    headers,
    error: message,
    ...(e.body !== undefined ? { body: e.body } : {}),
    bytesSent,
  };
}
