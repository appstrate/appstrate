// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * `UploadAdapter` interface — the contract every chunked-upload
 * protocol implementation conforms to.
 *
 * Adapters never touch the wire directly. They orchestrate state
 * (session URLs, ETag accumulation, offset tracking) and call
 * back into `ctx.providerCall(...)` which dispatches a single MCP
 * `provider_call` for each chunk. The credential isolation
 * invariant is therefore preserved: every byte still flows through
 * the sidecar's authenticated proxy.
 *
 * Why one interface for four protocols
 * ------------------------------------
 * Google resumable, AWS S3 multipart, tus, and Microsoft Graph
 * resumable each use a different wire envelope (XML vs JSON,
 * different headers, different finalize step), but the orchestration
 * shape is identical: init → loop(chunks) → finalize, with cancel
 * always best-effort. The interface lifts that shape so the resolver
 * (`provider-upload-resolver.ts`) is protocol-agnostic and the
 * delta to add a fifth protocol is one new file in this directory.
 */

/**
 * Stable protocol identifier surfaced through the MCP tool's
 * `uploadProtocol` enum and through provider manifests'
 * `definition.uploadProtocols[]`.
 *
 * Add a new entry here ONLY together with a registered adapter in
 * `./index.ts` — the resolver's `ADAPTERS[protocol]` lookup yields
 * `undefined` for any value not present in the registry, which the
 * resolver surfaces to the agent as a structured failure.
 */
export type UploadProtocol = "google-resumable" | "s3-multipart" | "tus" | "ms-resumable";

/**
 * Outcome of a single `providerCall` issued by an adapter.
 *
 * Mirrors the sidecar's `_meta.appstrate/upstream` payload after
 * resolver-side parsing — adapters consume `status` and `headers`
 * for protocol semantics, and `body` for the few protocols that need
 * to read the response payload (S3's `CreateMultipartUpload` returns
 * `UploadId` in XML; Microsoft's `createUploadSession` returns the
 * resumable URL in JSON).
 */
export interface AdapterProviderResponse {
  status: number;
  headers: Record<string, string>;
  /** Response body as a string. UTF-8 decoded for non-binary upstreams. */
  body: string;
}

/**
 * Abstract `provider_call` dispatcher exposed to adapters. Wraps
 * `mcp.callTool({ name: "provider_call", arguments: ... })` and
 * surfaces the upstream meta in a single object.
 *
 * `bytes` carries the chunk to upload — the wrapper base64-encodes
 * once before MCP dispatch. `target` is the URL the chunk is sent
 * to (for adapters that follow `Location:` between calls, this may
 * differ from the original `target` the agent passed).
 */
export type AdapterProviderCall = (
  req: AdapterProviderCallRequest,
) => Promise<AdapterProviderResponse>;

export interface AdapterProviderCallRequest {
  /** `provider_call.providerId` — pinned for the whole upload. */
  providerId: string;
  target: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  headers?: Record<string, string>;
  /** Either a string body (init metadata) or raw bytes (a chunk). */
  body?: string | Uint8Array;
}

/**
 * Per-call context provided to adapters. Carries the abort signal
 * (must be honoured between chunks), incremental SHA-256 hashing
 * over the file bytes (so the adapter doesn't have to track it),
 * and adapter-supplied metadata.
 */
export interface AdapterContext {
  providerId: string;
  /** Original target URL from the agent. The adapter MAY substitute
   *  per-protocol session URLs after init. */
  target: string;
  /** Total file size in bytes. */
  totalBytes: number;
  /** Caller-supplied metadata (Drive file name, MIME type, …). */
  metadata: Record<string, unknown>;
  /** Suggested chunk size; the adapter may clamp to its own protocol-
   *  level minimum/alignment requirements. */
  partSizeBytes: number;
  /** Wraps `mcp.callTool({ name: "provider_call", … })`. */
  providerCall: AdapterProviderCall;
  /** Abort signal — adapters check between chunks AND propagate to
   *  the underlying providerCall. */
  signal: AbortSignal;
  /** Update the running SHA-256 with the chunk bytes about to be sent.
   *  Adapters call this exactly once per uploaded chunk so the digest
   *  reflects the bytes actually transmitted (not the bytes read from
   *  disk, which may be retried before write success). */
  hashUpdate: (bytes: Uint8Array) => void;
}

/**
 * Slice of the file ready for transmission.
 *
 * `final` is set on the LAST chunk so adapters can finalise the upload
 * inline (Google's last PUT returns `200`, S3 needs a separate
 * `CompleteMultipartUpload`, tus accepts a final PATCH, MS Graph
 * returns the file metadata in the last response).
 */
export interface ChunkInfo {
  /** Zero-indexed chunk number. */
  index: number;
  /** Byte offset (inclusive) where this chunk starts in the file. */
  start: number;
  /** Byte offset (inclusive) where this chunk ends in the file. */
  end: number;
  /** Chunk bytes (may be shorter than `partSizeBytes` for the last chunk). */
  bytes: Uint8Array;
  /** True when this is the last chunk of the file. */
  final: boolean;
}

/**
 * Adapter-private session state. Opaque to the resolver — passed
 * back into every `uploadChunk` and the `finalize` / `abort` calls.
 */
export type SessionState = unknown;

/**
 * Successful upload outcome surfaced by `adapter.finalize`. The `body`
 * is the upstream's final response body (Drive: file metadata JSON;
 * S3: `CompleteMultipartUploadResult` XML; tus: 204 empty; MS Graph:
 * DriveItem JSON). The resolver returns it verbatim to the agent so
 * the LLM can extract whatever it needs (file ID, ETag, web URL).
 *
 * `sha256` and `size` are derived by the resolver from the bytes
 * committed to the wire — the adapter itself never sees the running
 * digest, so they are NOT part of this contract.
 */
export interface UploadSuccess {
  ok: true;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface UploadFailure {
  ok: false;
  /** Upstream HTTP status when the failure was a protocol-level error. */
  status: number;
  /** Allowlisted upstream headers from the failing call. */
  headers: Record<string, string>;
  /** Human-readable error message. */
  message: string;
  /** Upstream response body, if the failure was a protocol-level error. */
  body?: string;
}

export type UploadResult = UploadSuccess | UploadFailure;

/**
 * Shared error class thrown by every adapter on init / chunk failures.
 *
 * The resolver's `failure()` helper reads `status`, `headers`, and
 * `body` off the thrown thing to surface upstream context to the
 * agent. Without a structured carrier the agent gets only the message
 * string and `status: 0 / headers: {}`. All four adapters use this so
 * the agent UX is identical regardless of which protocol failed.
 */
export class UploadError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly headers: Record<string, string>,
    public readonly body: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

export interface UploadAdapter {
  /** Stable protocol identifier — matches the Pi tool's enum. */
  readonly protocol: UploadProtocol;

  /**
   * Default suggested part size in bytes. The resolver uses this when
   * the agent does not supply `partSizeBytes`. Each adapter tunes the
   * default to its protocol's preferences (Google: 8 MiB; S3: 5 MiB
   * minimum; tus: 4 MiB; MS: 5 MiB recommended).
   */
  readonly defaultPartSizeBytes: number;

  /**
   * Validate (and optionally clamp) a part size against protocol
   * constraints. Throws `Error` with a clear message when the value
   * cannot satisfy the protocol (e.g. S3 < 5 MiB, Google not 256-KiB
   * aligned). Returns the effective part size — adapters may round up
   * silently when the protocol allows it (Google rounds 1 MB → 1 MiB
   * to match the 256 KiB grid).
   */
  validatePartSize(partSizeBytes: number, totalBytes: number): number;

  /**
   * Initiate the upload session. Returns adapter-private state.
   *
   * Implementations issue ONE `providerCall` typically — a metadata
   * POST. May issue zero (tus, where session creation is implicit on
   * first PATCH) or several (rare). Must respect `ctx.signal`.
   */
  initSession(ctx: AdapterContext): Promise<SessionState>;

  /**
   * Upload a single chunk. Called sequentially — chunks are NEVER
   * uploaded in parallel because the orchestration is per-protocol
   * sequential (Google, MS, tus require it; S3 allows parallel but we
   * keep it sequential for memory bound). Returns updated session state.
   */
  uploadChunk(state: SessionState, chunk: ChunkInfo, ctx: AdapterContext): Promise<SessionState>;

  /**
   * Finalise the upload. For protocols where the last chunk's response
   * is the final response (Google, MS, tus), this returns it from the
   * accumulated state. For S3, it issues a `CompleteMultipartUpload`.
   */
  finalize(state: SessionState, ctx: AdapterContext): Promise<UploadResult>;

  /**
   * Best-effort abort. Called when `ctx.signal` fires after init but
   * before finalize. MUST swallow its own errors — the run is already
   * being torn down, the abort is just hygiene to free upstream
   * resources (Drive sessions live 7 days and count against quota).
   */
  abort(state: SessionState, ctx: AdapterContext): Promise<void>;
}

/**
 * Set of all valid `uploadProtocol` values. Useful for schema
 * validation in the Pi tool surface.
 */
export const UPLOAD_PROTOCOLS: readonly UploadProtocol[] = [
  "google-resumable",
  "s3-multipart",
  "tus",
  "ms-resumable",
];
