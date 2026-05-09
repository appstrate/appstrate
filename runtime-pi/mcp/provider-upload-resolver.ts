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
import { getErrorMessage } from "@appstrate/core/errors";
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
 * Time budget for best-effort `adapter.abort()` cleanup calls. The
 * abort fires AFTER the user's `ctx.signal` has been aborted (or after
 * a thrown error tears down the run), so it cannot reuse `ctx.signal`
 * — that would alias an already-aborted signal and the underlying
 * `mcp.callTool` would reject the cleanup request synchronously,
 * leaving the upstream session pending. We give the cleanup its own
 * fresh signal with a bounded timeout so it actually gets a chance to
 * reach upstream without ever hanging the run teardown.
 */
const ABORT_CLEANUP_TIMEOUT_MS = 5_000;

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
        error: `provider_upload: cannot read ${JSON.stringify(req.fromFile)}: ${getErrorMessage(err)}`,
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
        error: getErrorMessage(err),
        bytesSent: 0,
      };
    }

    const hasher = await createSha256Hasher();
    // Bytes acknowledged by upstream — incremented only after a chunk
    // call returns successfully. The hash is updated on the same chunk
    // bytes via `hashUpdate`, so on success `bytesAcked === totalBytes`
    // and the digest reflects exactly those bytes. On a mid-flight
    // failure, `bytesAcked` reports what upstream confirmed receiving,
    // not what we attempted to send (which would be one chunk too high
    // — the failing chunk hashed before its provider_call rejected).
    let bytesAcked = 0;

    const adapterCtx: AdapterContext = {
      providerId: req.providerId,
      target: req.target,
      totalBytes,
      metadata: req.metadata ?? {},
      partSizeBytes,
      providerCall: this.makeProviderCall(ctx.signal),
      signal: ctx.signal,
      hashUpdate: (bytes) => {
        hasher.update(bytes);
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
          bytesAcked += chunk.bytes.byteLength;
        }
      } finally {
        // `cancel()` closes the underlying source AND releases the
        // reader's lock — strictly better than `releaseLock()` on the
        // error path, which would leave the file descriptor held until
        // GC. On the success path the stream has already returned
        // `done: true` and `cancel()` is a no-op.
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      // Best-effort cleanup before reporting. MUST use a fresh signal:
      // ctx.signal is typically already aborted on this path, so
      // aliasing it would short-circuit the DELETE inside mcp.callTool
      // and leak the upstream session.
      this.fireAbort(adapter, state, adapterCtx);
      return failure(adapter, err, bytesAcked);
    }

    // Phase 3: finalise.
    let finalResult: UploadResult;
    try {
      throwIfAborted(ctx.signal);
      finalResult = await adapter.finalize(state, adapterCtx);
    } catch (err) {
      this.fireAbort(adapter, state, adapterCtx);
      return failure(adapter, err, bytesAcked);
    }

    if (!finalResult.ok) {
      return {
        ok: false,
        protocol: adapter.protocol,
        status: finalResult.status,
        headers: finalResult.headers,
        error: finalResult.message,
        ...(finalResult.body !== undefined ? { body: finalResult.body } : {}),
        bytesSent: bytesAcked,
      };
    }

    return {
      ok: true,
      protocol: adapter.protocol,
      status: finalResult.status,
      headers: finalResult.headers,
      body: finalResult.body,
      sha256: hasher.digestHex(),
      size: bytesAcked,
      chunks: chunkIndex,
    };
  }

  /**
   * Fire `adapter.abort` against a fresh, time-bounded signal so the
   * cleanup DELETE actually has a chance to reach upstream.
   *
   * Why a separate signal: `adapterCtx.providerCall` was built with
   * the user's `ctx.signal`. By the time we get here that signal is
   * usually aborted (cancellation path) — reusing it would make
   * `mcp.callTool` throw before issuing the cleanup request, leaving
   * the upstream session pending until its server-side TTL kicks in
   * (Drive: 7d, S3: lifecycle policy, MS: ~1d, tus: server-defined).
   *
   * The cleanup is fire-and-forget by design — blocking the failure
   * path on a network round-trip would tax every error case. The
   * timeout caps the worst-case orphaned-promise lifetime so a slow
   * upstream cannot hold a reference to the run forever.
   */
  private fireAbort(adapter: UploadAdapter, state: unknown, ctx: AdapterContext): void {
    if (state === undefined) return;
    const cleanupSignal = AbortSignal.timeout(ABORT_CLEANUP_TIMEOUT_MS);
    const cleanupCtx: AdapterContext = {
      ...ctx,
      providerCall: this.makeProviderCall(cleanupSignal),
      signal: cleanupSignal,
    };
    void adapter.abort(state, cleanupCtx).catch(() => {});
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
   *
   * Signal is taken explicitly (not from a captured ctx) so the
   * resolver can swap signals between normal flow and cleanup —
   * `adapter.abort` runs on a fresh, time-bounded signal so it doesn't
   * inherit the user's already-aborted cancellation signal.
   */
  private makeProviderCall(signal: AbortSignal) {
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
        { signal },
      );
      // The sidecar attaches `_meta` on every CallToolResult, including
      // pre-flight errors (which carry `status: 0` to signal "no
      // upstream contact"). A missing `_meta` is a protocol violation
      // — `readUpstreamMeta` throws.
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
      return {
        status: meta.status,
        headers: meta.headers,
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
  // Pre-allocate one chunk buffer and refill it sequentially from
  // reader bytes. Each source read is copied in once; we never grow
  // or re-merge a working buffer — that's the difference vs the
  // previous concat-on-each-read strategy, which was O(n²) over the
  // chunk-fill window (a 64 KiB read into a buffer growing to 8 MiB
  // = ~512 MB of copies per chunk). After yielding a full chunk we
  // hand the buffer to the adapter and allocate a fresh one, since
  // the adapter may retain the bytes (base64 encoder, parts list,
  // SHA hasher) past the next loop iteration.
  let work = new Uint8Array(partSizeBytes);
  let workLen = 0;
  let offset = 0;
  let chunkIndex = 0;
  let done = false;
  while (!done) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) {
      done = true;
      continue;
    }
    if (!value || value.byteLength === 0) continue;
    let pos = 0;
    while (pos < value.byteLength) {
      const remainingInRead = value.byteLength - pos;
      const remainingInWork = partSizeBytes - workLen;
      const take = Math.min(remainingInRead, remainingInWork);
      work.set(value.subarray(pos, pos + take), workLen);
      workLen += take;
      pos += take;
      if (workLen === partSizeBytes) {
        // `final` is determined purely by byte arithmetic against the
        // pre-known totalBytes — we don't need to wait for `done`. The
        // source stream's read-block size (~64 KiB) is much smaller
        // than partSizeBytes, so `done=true` typically arrives in a
        // later iteration after the last full slice is already out.
        const isFinal = offset + partSizeBytes === totalBytes;
        yield {
          index: chunkIndex,
          start: offset,
          end: offset + partSizeBytes - 1,
          bytes: work,
          final: isFinal,
        };
        chunkIndex += 1;
        offset += partSizeBytes;
        work = new Uint8Array(partSizeBytes);
        workLen = 0;
      }
    }
  }
  if (workLen > 0) {
    // Partial last chunk: slice down to the actual length. `work`
    // goes out of scope when the generator returns, so the subarray
    // alias is safe to hand off.
    yield {
      index: chunkIndex,
      start: offset,
      end: offset + workLen - 1,
      bytes: work.subarray(0, workLen),
      final: true,
    };
    offset += workLen;
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
  const message = e.message ?? getErrorMessage(err);
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
