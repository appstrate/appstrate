// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Reusable credential-injecting HTTP-call core. {@link makeApiCallTool}
 * builds the `Tool` an integration's `{ns}__api_call` surface exposes to
 * the LLM (method, target URL, optional headers/body, responseMode). The
 * core is credential-source-agnostic: the caller closes over whatever
 * credential / transport state it needs and hands a {@link ApiCallFn}
 * to {@link makeApiCallTool}. The local + remote integration resolvers in
 * `integration-api-call.ts` reuse this module verbatim.
 *
 * Scope of THIS module: request-body materialisation (string / `{ fromBytes }`
 * / `{ fromFile }` / `{ multipart }`, with streaming + size caps), the
 * workspace-rooted path-safety pipeline, the JSON-schema surfaced to the
 * LLM, the static `authorized_uris` allowlist matcher
 * ({@link matchesAuthorizedUriSpec}) + tool-layer enforcement
 * ({@link makeApiCallTool} calls `enforceAuthorizedUris` before dispatch),
 * and response serialisation ({@link serializeFetchResponse}).
 *
 * The credential-source-agnostic OUTBOUND request pipeline — SSRF
 * blocklist preflight + the manual redirect-follower (per-hop SSRF,
 * per-hop `authorized_uris` re-check, hybrid credential-strip,
 * cookie-jar capture, userinfo/fragment stripping) — lives in the
 * sibling `./api-call-engine.ts`, shared verbatim with the platform
 * sidecar's `executeApiCall`. `integration-api-call.ts`'s local resolver
 * dispatches through that engine's `guardedFetch`.
 *
 * Specification: `afps-spec/spec.md` §8.2, §8.4 — file-reference IO.
 */

import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";

import { z } from "zod";
import type { JSONSchema, Tool, ToolContext, ToolResult } from "./types.ts";
import { AuthorizedUrisError, ResolverError } from "../errors.ts";

/**
 * Default inline cap for response bodies that come back without an
 * explicit `responseMode.maxInlineBytes`. Mirrors `MAX_RESPONSE_SIZE`
 * in `runtime-pi/sidecar/helpers.ts` (256 KB) so the two layers stay
 * in sync — both truncate at the same boundary.
 */
export const defaultInlineLimit = 256 * 1024;

/**
 * Hard upper bound on `responseMode.maxInlineBytes` — the agent-supplied
 * inline-bytes budget that controls how much of an upstream response is
 * returned inline (vs. spilled to a file or blob). 1 MB is deliberately
 * smaller than the sidecar's `ABSOLUTE_MAX_RESPONSE_SIZE` (32 MB, used as
 * the upstream-buffer ceiling before spillover): inlining a 32 MB blob into
 * the agent's tool result would poison its context regardless of whether
 * the sidecar can buffer it. The two constants thus serve distinct roles
 * — schema cap for inline payloads vs. transport buffer ceiling — and
 * intentionally differ. Any agent-supplied value above this is silently
 * capped.
 */
export const ABSOLUTE_MAX_RESPONSE_SIZE = 1_000_000;

/**
 * Hard upper bound on `{ fromFile }` and `{ fromBytes }` request bodies.
 * Mirrors `MAX_REQUEST_BODY_SIZE` on the sidecar — checked client-side so
 * over-sized uploads fail with a typed error instead of a 413.
 *
 * Default 10 MB. Configurable via the `SIDECAR_MAX_REQUEST_BODY_BYTES`
 * env var, which is read by both the sidecar and the runtime so the two
 * layers stay aligned. Override is rejected if non-positive or above
 * 100 MB (the absolute ceiling).
 */
export const MAX_REQUEST_BODY_SIZE = (() => {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.SIDECAR_MAX_REQUEST_BODY_BYTES;
  const fallback = 10 * 1024 * 1024;
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return fallback;
  if (parsed > 100 * 1024 * 1024) return fallback;
  return parsed;
})();

/**
 * Above this size, `{ fromFile }` uploads are streamed from disk to
 * the sidecar instead of being read into memory first. Mirrors the
 * sidecar's own `STREAMING_THRESHOLD` so the two layers transition
 * together.
 */
export const STREAMING_THRESHOLD = 1 * 1024 * 1024;

/**
 * Hard upper bound on streamed request/response bodies. Mirrors
 * `MAX_STREAMED_BODY_SIZE` on the sidecar — `{ fromFile }` uploads
 * larger than this fail client-side with a typed error before any
 * bytes hit the wire.
 */
export const MAX_STREAMED_BODY_SIZE = 100 * 1024 * 1024;

// ─── Zod schemas for api_call arguments ──────────────────────────────────────
// Single source of truth: derive the JSON schema surfaced to the LLM and the
// runtime validation in execute() from these definitions. Aligned with CLAUDE.md:
// "All route request bodies validated with Zod .safeParse()."

const fromFileBodySchema = z.object({
  fromFile: z.string().describe("Workspace-relative path to a file to send as the request body"),
});

/**
 * Format a byte count for human-readable Zod descriptions. Picks the
 * largest unit at which the value renders as a positive integer, so a
 * 10 MB cap shows as "10 MB" rather than "10485760 bytes" and a sub-MB
 * cap shows as e.g. "512 KB" rather than "0 MB".
 */
function formatByteCap(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) {
    return `${bytes / (1024 * 1024)} MB`;
  }
  if (bytes >= 1024 && bytes % 1024 === 0) {
    return `${bytes / 1024} KB`;
  }
  return `${bytes} bytes`;
}

const MAX_REQUEST_BODY_DISPLAY = formatByteCap(MAX_REQUEST_BODY_SIZE);

const fromBytesBodySchema = z.object({
  fromBytes: z
    .string()
    .describe(
      `Base64-encoded body bytes (for inline binary uploads up to ${MAX_REQUEST_BODY_DISPLAY}). ` +
        "Standard base64 (RFC 4648 §4, alphabet `+/`) only. " +
        "URL-safe base64 (`-_`) and MIME-folded base64 (with whitespace/newlines) are not accepted.",
    ),
  encoding: z.literal("base64"),
});

// Multipart part header fields (`name`, `filename`, `contentType`) are
// emitted verbatim into the part headers (`Content-Disposition`,
// `Content-Type`). A CR, LF, or NUL byte in any of them would let a
// caller inject arbitrary headers — or split the multipart envelope —
// from purely text input. Reject these eagerly at the schema layer so
// the transport never has to think about it.
const headerSafeString = z.string().refine((s) => !/[\r\n\0]/.test(s), {
  message: "Must not contain CR, LF, or NUL characters",
});

const multipartTextPartSchema = z
  .object({
    name: headerSafeString.describe("Form field name"),
    value: z.string().describe("UTF-8 string value for this field"),
    contentType: headerSafeString
      .optional()
      .describe(
        "Optional `Content-Type` header for this part (e.g. `application/json; charset=UTF-8`). " +
          "When omitted, FormData defaults to `text/plain` with no explicit part header. " +
          "Required for upload patterns where the server inspects per-part Content-Type, " +
          "such as Google Drive's multipart resumable upload metadata part.",
      ),
  })
  .strict();

const multipartFilePartSchema = z
  .object({
    name: headerSafeString.describe("Form field name"),
    fromFile: z.string().describe("Workspace-relative path to a file"),
    filename: headerSafeString
      .optional()
      .describe(
        "Optional override for the `filename` attribute in `Content-Disposition`. " +
          "Defaults to the basename of `fromFile`.",
      ),
    contentType: headerSafeString
      .optional()
      .describe(
        "Optional `Content-Type` header for this part. Defaults to `application/octet-stream`.",
      ),
  })
  .strict();

const multipartBytesPartSchema = z
  .object({
    name: headerSafeString.describe("Form field name"),
    fromBytes: z.string().describe("Base64-encoded part bytes (standard RFC 4648 §4 only)"),
    encoding: z.literal("base64"),
    filename: headerSafeString
      .optional()
      .describe("Optional `filename` attribute for `Content-Disposition`."),
    contentType: headerSafeString
      .optional()
      .describe(
        "Optional `Content-Type` header for this part. Defaults to `application/octet-stream`.",
      ),
  })
  .strict();

const multipartPartSchema = z.union([
  multipartTextPartSchema,
  multipartFilePartSchema,
  multipartBytesPartSchema,
]);

const multipartBodySchema = z.object({
  multipart: z
    .array(multipartPartSchema)
    .min(1)
    .describe(
      "Compose a multipart/form-data body mixing text fields and workspace files or inline bytes",
    ),
});

const requestBodySchema = z.union([
  z.string(),
  fromFileBodySchema,
  fromBytesBodySchema,
  multipartBodySchema,
  z.null(),
]);

const responseModeSchema = z
  .object({
    toFile: z
      .string()
      .optional()
      .describe(
        "Workspace-relative path to stream the response body into (use for binary downloads)",
      ),
    maxInlineBytes: z
      .number()
      .int()
      .min(0)
      .max(ABSOLUTE_MAX_RESPONSE_SIZE)
      .optional()
      .describe(
        `Inline size cap; defaults to ${defaultInlineLimit} bytes when absent. Larger responses auto-spill to a file.`,
      ),
  })
  .optional();

/** Zod schema for `api_call` arguments — validated at runtime in execute(). */
export const apiCallRequestSchema = z.object({
  method: z
    .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
    .describe("HTTP method for the upstream request"),
  target: z
    .url({ protocol: /^https?$/, error: "target must be an absolute http(s) URL" })
    .describe("Absolute URL of the upstream endpoint"),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("Headers forwarded to the upstream (credential headers are injected server-side)"),
  body: requestBodySchema
    .optional()
    .describe(
      "Request body. Use { fromFile: 'path' } (workspace-relative) for binary file uploads, " +
        `{ fromBytes, encoding: 'base64' } for inline binary payloads up to ${MAX_REQUEST_BODY_DISPLAY} (standard base64 RFC 4648 §4 only — alphabet \`+/\`, no URL-safe \`-_\` or MIME line-folding), ` +
        "or { multipart: [...] } to compose a multipart/form-data body mixing text fields and workspace files.",
    ),
  substituteBody: z
    .boolean()
    .optional()
    .describe(
      "When true, the sidecar substitutes `{{credential}}` placeholders inside the request body before forwarding upstream. Off by default to avoid accidental token leaks into payloads. Requires a text body (string) — incompatible with { fromBytes } / { fromFile } / { multipart }.",
    ),
  responseMode: responseModeSchema,
});

/**
 * JSON schema for `api_call` arguments — derived once from
 * `apiCallRequestSchema`. Exported so non-Zod consumers (notably
 * `@appstrate/runner-pi`'s container-mode dispatcher, which composes its
 * own parameters object per `{ns}__api_call` tool) can paste in the
 * canonical discriminated body / responseMode shapes without re-deriving
 * them. Without this, the LLM-facing schema for `body` is `{}` (any) and
 * models routinely JSON-stringify object bodies — `{ fromFile: "x" }`
 * arrives as a string, resolveBodyForFetch's file-reading branch never
 * runs, and the literal `{"fromFile":"x"}` is forwarded upstream as the
 * request body.
 */
export const apiCallRequestJsonSchema: JSONSchema = z.toJSONSchema(apiCallRequestSchema, {
  target: "draft-7",
}) as JSONSchema;

/**
 * Flat view over the subset of fields {@link makeApiCallTool} consumes
 * for URL-allowlist enforcement. Callers project their credential source
 * (integration manifest auth, local creds file, …) onto this shape.
 *
 * Credential header metadata (name / prefix / field name) is
 * deliberately NOT part of this type. Every shipped transport —
 * sidecar, credential-proxy, local/remote integration resolver — owns
 * credential injection itself:
 *
 *   - Sidecar + credential-proxy: read the metadata from the platform's
 *     internal credentials endpoint and write the header server-side.
 *     The runtime never sees the credential field at all.
 *   - Local integration resolver: reads the injection plan from the
 *     integration manifest's `delivery.http` (or the local creds file
 *     override), not surfaced on this meta.
 *
 * Consequence: the tool schema surfaced to the LLM is identical across
 * auth modes and carries no hint of how the credential is transported.
 */
export interface ApiCallMeta {
  /** Scoped package name (e.g. `@appstrate/gmail`). */
  name: string;
  /**
   * URL allowlist enforced by the tool before dispatch. Patterns follow
   * {@link matchesAuthorizedUriSpec} semantics (`*` = single path
   * segment, `**` = any substring).
   */
  authorizedUris?: string[];
  /**
   * When true, the tool does not enforce the URL allowlist — the
   * transport is expected to enforce it instead (e.g. Appstrate's
   * sidecar gates this server-side). Defaults to false.
   */
  allowAllUris?: boolean;
}

/**
 * Public type for api_call arguments. Structurally compatible with
 * `z.infer<typeof apiCallRequestSchema>` plus a `Uint8Array` variant
 * on `body` (for programmatic callers who already have bytes in memory —
 * this variant cannot be expressed in JSON Schema and is not surfaced to
 * the LLM).
 */
export type ApiCallRequest = Omit<z.infer<typeof apiCallRequestSchema>, "body"> & {
  /**
   * Request body. Either raw bytes / string (forwarded verbatim), a
   * file reference that the transport resolves before dispatch, or a
   * base64-encoded inline binary payload (for computed/in-memory bytes
   * up to {@link MAX_REQUEST_BODY_SIZE}).
   */
  body?: z.infer<typeof requestBodySchema> | Uint8Array;
};

/**
 * Discriminated union for response bodies surfaced to the LLM:
 *   - `text`   — UTF-8 text payloads (JSON, XML, plain text…)
 *   - `inline` — small binary payloads, base64-encoded
 *   - `file`   — large or `responseMode.toFile`-routed bodies materialized on disk
 *
 * The encoding is explicit on `inline` (always `base64`) so consumers
 * never have to guess. The legacy `{ inline; inlineEncoding } | { file }`
 * shape was lossy for binary data — see issues #149 / #151.
 *
 * `truncated` signals that the sidecar capped the upstream response at
 * `MAX_RESPONSE_SIZE` (or the agent-requested `maxInlineBytes`). When
 * `truncated` is `true`, `truncatedSize` carries the byte length of the
 * truncated payload so the LLM can report partial data faithfully. The
 * `file` variant is never truncated — bytes are always streamed in full.
 */
export type ApiCallResponseBody =
  | {
      kind: "text";
      text: string;
      /** When `true`, the sidecar capped the upstream response. Absent means `false`. */
      truncated?: true;
      truncatedSize?: number;
    }
  | {
      kind: "inline";
      data: string;
      encoding: "base64";
      mimeType: string;
      /**
       * When `true`, the `mimeType` was determined by file-type content
       * sniffing rather than the upstream Content-Type header. Only set
       * when the declared type was absent or `application/octet-stream`.
       */
      mimeTypeSniffed?: true;
      size: number;
      /** When `true`, the sidecar capped the upstream response. Absent means `false`. */
      truncated?: true;
      truncatedSize?: number;
    }
  | {
      kind: "file";
      path: string;
      size: number;
      mimeType: string;
      /**
       * When `true`, the `mimeType` was determined by file-type content
       * sniffing rather than the upstream Content-Type header.
       */
      mimeTypeSniffed?: true;
      sha256: string;
    };

export interface ApiCallResponse {
  status: number;
  headers: Record<string, string>;
  body: ApiCallResponseBody;
}

/**
 * Per-call execution context forwarded to the resolver from the Tool
 * `execute()` wrapper. Carries the ambient run state the resolver needs
 * to materialize file-backed bodies safely (workspace, toolCallId for
 * deterministic auto-spill paths, abort signal).
 */
export interface ApiCallContext {
  workspace: string;
  toolCallId: string;
  signal: AbortSignal;
}

/**
 * Transport callback. Resolver implementations close over whatever
 * credential / transport state they need and hand this callback to
 * {@link makeApiCallTool}. The tool wrapper passes the ambient
 * {@link ApiCallContext} alongside the request so the resolver can
 * resolve workspace-relative paths and auto-spill large responses.
 */
export type ApiCallFn = (req: ApiCallRequest, ctx: ApiCallContext) => Promise<ApiCallResponse>;

/**
 * Apply transport control headers to an outgoing credentialled call.
 *
 * Used by {@link RemoteAppstrateIntegrationResolver} for the CLI's HTTP
 * path to the platform's `/api/credential-proxy/proxy` route.
 * Container runs reach the sidecar's `executeApiCall` over MCP
 * (`{ns}__api_call`) and bypass this header layer entirely.
 *
 * Rules applied (mirrors the platform server contract):
 *  - `wantsFile` → `X-Stream-Response: 1` (server pipes response as stream).
 *    `X-Max-Response-Size` is omitted — it is redundant when streaming.
 *  - `isStreamingBody` → `X-Stream-Request: 1` + explicit `Content-Length`
 *    (so the server can enforce the 100 MB cap up-front before reading the body).
 *  - Otherwise → `X-Max-Response-Size: <cap>` when the agent requested a
 *    larger inline payload (lifts the server's default cap).
 *
 * Mutates `headers` in place and returns it for convenience.
 */
/**
 * Returns true when the body can be re-resolved from scratch for a retry.
 * `ReadableStream` bodies are not reproducible — the caller has already
 * consumed the stream. All other variants can be re-passed to
 * `resolveBodyForFetch` to produce fresh bytes/stream.
 */
export function isReproducibleBody(body: ApiCallRequest["body"]): boolean {
  if (body == null || typeof body === "string") return true;
  if (body instanceof Uint8Array) return true; // caller still holds the reference
  if (
    typeof body === "object" &&
    ("fromFile" in body || "fromBytes" in body || "multipart" in body)
  )
    return true;
  return false; // ReadableStream or other non-serialisable value
}

export function applyTransportHeaders(
  headers: Record<string, string>,
  opts: {
    wantsFile: boolean;
    isStreamingBody: boolean;
    bodySize?: number;
    maxInlineBytes?: number;
  },
): Record<string, string> {
  if (opts.wantsFile) {
    headers["X-Stream-Response"] = "1";
    // X-Max-Response-Size is not needed on the streaming-response path —
    // the server enforces MAX_STREAMED_BODY_SIZE via a transform stream.
    delete headers["X-Max-Response-Size"];
  } else {
    const maxInline = opts.maxInlineBytes;
    if (typeof maxInline === "number" && maxInline > 0) {
      const cap = Math.min(maxInline, ABSOLUTE_MAX_RESPONSE_SIZE);
      headers["X-Max-Response-Size"] = String(cap);
    }
  }
  if (opts.isStreamingBody) {
    // Use a case-insensitive check so mixed-case keys (e.g. "content-Length")
    // are detected correctly regardless of how the caller populated the object.
    const hasXStreamRequest = Object.keys(headers).some(
      (k) => k.toLowerCase() === "x-stream-request",
    );
    if (!hasXStreamRequest) {
      headers["X-Stream-Request"] = "1";
    }
    const hasContentLength = Object.keys(headers).some((k) => k.toLowerCase() === "content-length");
    if (opts.bodySize !== undefined && !hasContentLength) {
      headers["Content-Length"] = String(opts.bodySize);
    }
  }
  return headers;
}

export interface MakeApiCallToolOptions {
  /** Tool name override. Defaults to `<sluggedIntegrationName>_call`. */
  toolName?: string;
  /** Description override. */
  description?: string;
  /** Stable per-call event shape emitted through ctx.emit. */
  emitApiCallEvent?: boolean;
}

/**
 * Build a `Tool` exposing a typed credentialled-call surface to the LLM.
 * Agents see `{ns}__api_call(method, target, headers?, body?, responseMode?)`
 * rather than a free-form `curl` invocation — same observability for
 * every resolver, no prompt-level knowledge of the transport. The caller
 * passes `toolName` to set the surfaced name (integrations use
 * `{ns}__api_call`); the default falls back to `<slug>_call`.
 */
export function makeApiCallTool(
  meta: ApiCallMeta,
  call: ApiCallFn,
  opts: MakeApiCallToolOptions = {},
): Tool {
  const toolName = opts.toolName ?? defaultApiCallToolName(meta.name);
  const description =
    opts.description ??
    `Call the ${meta.name} integration. Supply method, target URL, optional headers/body, and responseMode. ` +
      `Pass binary uploads via { fromFile } and route binary downloads via responseMode.toFile — ` +
      `inline bytes are decoded as text and bloat the LLM context.`;

  // Generate the JSON schema from the Zod definition — single source of
  // truth, computed once at module load via apiCallRequestJsonSchema.
  const parameters = apiCallRequestJsonSchema;

  const emit = opts.emitApiCallEvent ?? true;

  return {
    name: toolName,
    description,
    parameters,
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      // Validate args with Zod before casting to ApiCallRequest.
      // Note: Uint8Array bodies are valid at the TypeScript level but
      // cannot arrive from the LLM (JSON has no binary type) — the Zod
      // schema covers every variant the LLM can produce.
      const parsed = apiCallRequestSchema.safeParse(args);
      if (!parsed.success) {
        throw new ResolverError(
          "RESOLVER_BODY_INVALID",
          `Invalid api_call arguments: ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join(", ")}`,
        );
      }
      const req: ApiCallRequest = parsed.data;
      enforceAuthorizedUris(meta, req.target);

      const callCtx: ApiCallContext = {
        workspace: ctx.workspace,
        toolCallId: ctx.toolCallId ?? `tc_${Math.random().toString(36).slice(2, 10)}`,
        signal: ctx.signal,
      };

      const started = Date.now();
      let response: ApiCallResponse;
      try {
        response = await call(req, callCtx);
      } catch (err) {
        if (emit) {
          ctx.emit({
            type: "api_call.called",
            timestamp: Date.now(),
            runId: ctx.runId,
            toolCallId: ctx.toolCallId,
            integrationId: meta.name,
            method: req.method,
            target: req.target,
            status: 0,
            durationMs: Date.now() - started,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      }

      if (emit) {
        ctx.emit({
          type: "api_call.called",
          timestamp: Date.now(),
          runId: ctx.runId,
          toolCallId: ctx.toolCallId,
          integrationId: meta.name,
          method: req.method,
          target: req.target,
          status: response.status,
          durationMs: Date.now() - started,
        });
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: response.status,
              headers: response.headers,
              body: response.body,
            }),
          },
        ],
        ...(response.status >= 400 ? { isError: true } : {}),
      };
    },
  };
}

/**
 * Canonical slug applied to a package id before forming a default tool
 * name. Strips a leading `@` and replaces any non-word character with `_`
 * so scoped package ids like `@appstrate/gmail` become safe tool
 * identifiers.
 *
 * Internal: used by {@link makeApiCallTool} to derive a default tool
 * name when the caller does not pass an explicit `toolName`. The
 * integration resolvers always pass `{ns}__api_call`, so this fallback
 * mostly serves tests.
 */
export function slugifyIntegrationId(integrationId: string): string {
  return integrationId.replace(/^@/, "").replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * The default tool name {@link makeApiCallTool} registers for a given
 * integration id. Internal: only consumed inside this file.
 */
function defaultApiCallToolName(integrationId: string): string {
  return `${slugifyIntegrationId(integrationId)}_call`;
}

/**
 * Absolute roots beyond the workspace under which `{ fromFile }` and
 * `responseMode.toFile` paths are permitted to resolve. The workspace
 * itself is always the primary root; this list adds container-private
 * scratch directories the agent can legitimately write to before
 * uploading.
 *
 * `/tmp` is included because every agent that writes a file then
 * uploads it via `api_call` defaults to `/tmp/output.xlsx` (Python
 * `tempfile`, bash `mktemp`, …). The agent container is isolated
 * (per-run, no host bind-mount) and the sidecar — which performs the
 * actual upstream call — has no workspace mount, so the file is read
 * locally by the resolver running inside the agent. There is no
 * exfiltration path beyond what the workspace itself already exposes.
 */
const ABSOLUTE_ALLOWED_ROOTS: readonly string[] = ["/tmp"];

/**
 * Realpath `p`, falling back to its lexical absolute form if the path
 * doesn't exist. Used to canonicalize the allowed roots once at the
 * start of every {@link resolveSafePath} call.
 */
async function realpathOrAbs(p: string): Promise<string> {
  const abs = nodePath.resolve(p);
  try {
    return await fsPromises.realpath(abs);
  } catch {
    return abs;
  }
}

/**
 * Canonicalize the workspace and {@link ABSOLUTE_ALLOWED_ROOTS} into a
 * deduplicated list of realpaths. The workspace is always position 0 —
 * relative paths resolve under it.
 *
 * Realpath is required because on macOS `/tmp` is a symlink to
 * `/private/tmp`; a lexical-only comparison would treat resolved
 * descendants (which come back through realpath) as outside the root.
 */
async function getAllowedRoots(workspace: string): Promise<readonly string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of [workspace, ...ABSOLUTE_ALLOWED_ROOTS]) {
    const real = await realpathOrAbs(r);
    if (!seen.has(real)) {
      seen.add(real);
      out.push(real);
    }
  }
  return out;
}

function isUnderAnyRoot(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    if (candidate === root) return true;
    const withSep = root.endsWith(nodePath.sep) ? root : root + nodePath.sep;
    return candidate.startsWith(withSep);
  });
}

/**
 * Canonicalize an input path. Existing paths are realpathed end-to-end
 * (so symlinks land at their true target); for non-existent paths the
 * closest existing ancestor is realpathed and the unresolved suffix is
 * reattached, so write-targets get the same canonical treatment.
 *
 * Authorization is decided by {@link isUnderAnyRoot} on the returned
 * value; symlink-aware diagnostics are computed at the call site by
 * comparing the result to the lexical candidate.
 */
async function canonicalizePath(candidate: string): Promise<string> {
  try {
    return await fsPromises.realpath(candidate);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw err;
  }
  // Walk up to the closest existing ancestor, realpath it, reattach
  // the unresolved suffix. `path.resolve` has already collapsed `..`
  // segments in the candidate, so the lexical form is canonical for
  // ancestors that don't exist either.
  let cursor = candidate;
  let suffix = "";
  while (true) {
    const parent = nodePath.dirname(cursor);
    if (parent === cursor) return candidate; // fully synthetic chain
    suffix = nodePath.join(nodePath.basename(cursor), suffix);
    cursor = parent;
    try {
      const realParent = await fsPromises.realpath(cursor);
      return nodePath.join(realParent, suffix);
    } catch (innerErr) {
      const ie = innerErr as NodeJS.ErrnoException;
      if (ie.code === "ENOENT") continue;
      throw innerErr;
    }
  }
}

/**
 * Resolve a path safely under one of the allowed roots — primarily the
 * workspace, secondarily the container-private scratch dirs declared in
 * {@link ABSOLUTE_ALLOWED_ROOTS} (currently `/tmp`).
 *
 * Behavior:
 *  - Relative paths (e.g. `"output.xlsx"`) resolve under the workspace.
 *  - Absolute paths (e.g. `"/tmp/output.xlsx"`) are accepted only if
 *    they canonicalize under one of the allowed roots.
 *  - Parent-traversal (`"../etc/passwd"`) is rejected: `path.resolve`
 *    collapses `..` segments and the result trips the root check.
 *  - Symlink escape (a path that exists but realpath-s outside every
 *    allowed root) is rejected.
 *
 * Throws {@link ResolverError} with `RESOLVER_PATH_OUTSIDE_ALLOWED_ROOTS`
 * (or `RESOLVER_PATH_INVALID`) on violation. The error message names
 * the offending path, the resolved canonical path, and the allowed
 * roots so the agent can self-correct without trial and error.
 *
 * Used by both the request-body `{ fromFile }` resolver and the
 * response-body `responseMode.toFile` writer.
 */
export async function resolveSafePath(workspace: string, relative: string): Promise<string> {
  if (typeof relative !== "string" || relative.length === 0) {
    throw new ResolverError(
      "RESOLVER_PATH_INVALID",
      `resolveSafePath: path must be a non-empty string`,
      { workspace, relative },
    );
  }
  const roots = await getAllowedRoots(workspace);
  const wsRoot = roots[0]!;
  const candidate = nodePath.isAbsolute(relative)
    ? nodePath.resolve(relative)
    : nodePath.resolve(wsRoot, relative);
  const canonical = await canonicalizePath(candidate);
  if (!isUnderAnyRoot(canonical, roots)) {
    const viaSymlink = canonical !== candidate;
    throw new ResolverError(
      "RESOLVER_PATH_OUTSIDE_ALLOWED_ROOTS",
      formatOutsideRootsError(relative, canonical, roots, viaSymlink),
      { workspace, relative, resolved: canonical, allowedRoots: roots, viaSymlink },
    );
  }
  return canonical;
}

function formatOutsideRootsError(
  relative: string,
  resolved: string,
  roots: readonly string[],
  viaSymlink: boolean,
): string {
  const extraRoots = roots.slice(1).join(", ");
  const suffix = extraRoots ? ` or an absolute path under ${extraRoots}` : "";
  // Generic "path" rather than "fromFile" — this same resolver gates
  // `{ fromFile }` uploads, `responseMode.toFile` writes, and multipart
  // file parts. The structured `details` payload carries the call-site
  // context for callers that need to distinguish.
  return (
    `path ${viaSymlink ? "resolves through a symlink to a target" : "resolved"} outside the allowed roots.\n` +
    `  got:      ${JSON.stringify(relative)}\n` +
    `  resolved: ${resolved}\n` +
    `  allowed:  ${roots.join(", ")}\n` +
    `  hint:     pass a workspace-relative path (e.g. "output.xlsx")${suffix}.`
  );
}

/**
 * Resolve an OUTPUT path safely. Delegates root-membership and
 * traversal checks to {@link resolveSafePath}, then refuses to write
 * through a pre-existing symlink at the destination — guards against an
 * attacker pre-placing a symlink to redirect writes outside the
 * destination dir.
 *
 * ENOENT on the file itself is fine (we are creating it); any other
 * lstat error is re-thrown.
 *
 * Throws {@link ResolverError} with `RESOLVER_PATH_SYMLINK_REFUSED` for
 * the symlink case, or `RESOLVER_PATH_OUTSIDE_ALLOWED_ROOTS` /
 * `RESOLVER_PATH_INVALID` for root violations propagated from
 * {@link resolveSafePath}.
 */
async function resolveSafeOutputPath(workspace: string, rel: string): Promise<string> {
  const absPath = await resolveSafePath(workspace, rel);
  try {
    const stat = await fsPromises.lstat(absPath);
    if (stat.isSymbolicLink()) {
      throw new ResolverError(
        "RESOLVER_PATH_SYMLINK_REFUSED",
        `Refusing to write through symlink: ${rel}`,
        { workspace, rel, resolved: absPath },
      );
    }
  } catch (err) {
    if (err instanceof ResolverError) throw err;
    // ENOENT is fine — we are creating a new file.
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw err;
  }
  return absPath;
}

/**
 * Resolve and stat a path in a single step, refusing symlinks at the
 * final path (in addition to the root-membership check performed by
 * {@link resolveSafePath}).
 *
 * Using a single helper eliminates the TOCTOU window that would exist
 * if callers independently called `resolveSafePath` then `lstat` — the
 * stat here is of the same resolved path returned by the function.
 *
 * Throws {@link ResolverError} with `RESOLVER_PATH_SYMLINK_REFUSED` for
 * the symlink case, or `RESOLVER_PATH_OUTSIDE_ALLOWED_ROOTS` /
 * `RESOLVER_PATH_INVALID` for root violations propagated from
 * {@link resolveSafePath}.
 */
export async function resolveSafeFile(
  workspace: string,
  rel: string,
): Promise<{ absPath: string; stat: import("node:fs").Stats }> {
  const absPath = await resolveSafePath(workspace, rel);
  const stat = await fsPromises.lstat(absPath);
  if (stat.isSymbolicLink()) {
    throw new ResolverError("RESOLVER_PATH_SYMLINK_REFUSED", `Refusing to follow symlink: ${rel}`, {
      workspace,
      rel,
      resolved: absPath,
    });
  }
  return { absPath, stat };
}

/**
 * Resolve an existing file strictly inside the workspace. Unlike
 * {@link resolveSafeFile}, this intentionally does not admit the shared
 * container scratch roots such as `/tmp`, and it rejects absolute paths even
 * when they happen to point back into the workspace. Use this for tool
 * contracts that explicitly promise a workspace-relative path.
 */
export async function resolveWorkspaceFile(
  workspace: string,
  rel: string,
): Promise<{ absPath: string; stat: import("node:fs").Stats }> {
  if (typeof rel !== "string" || rel.length === 0) {
    throw new ResolverError(
      "RESOLVER_PATH_INVALID",
      "resolveWorkspaceFile: path must be a non-empty string",
      { workspace, relative: rel },
    );
  }

  const wsRoot = await realpathOrAbs(workspace);
  if (nodePath.isAbsolute(rel)) {
    throw new ResolverError(
      "RESOLVER_PATH_OUTSIDE_ALLOWED_ROOTS",
      `path must be workspace-relative.\n  got:     ${JSON.stringify(rel)}\n  allowed: ${wsRoot}`,
      { workspace, relative: rel, allowedRoots: [wsRoot] },
    );
  }

  const candidate = nodePath.resolve(wsRoot, rel);
  const canonical = await canonicalizePath(candidate);
  if (!isUnderAnyRoot(canonical, [wsRoot])) {
    const viaSymlink = canonical !== candidate;
    throw new ResolverError(
      "RESOLVER_PATH_OUTSIDE_ALLOWED_ROOTS",
      formatOutsideRootsError(rel, canonical, [wsRoot], viaSymlink),
      { workspace, relative: rel, resolved: canonical, allowedRoots: [wsRoot], viaSymlink },
    );
  }

  const stat = await fsPromises.lstat(canonical);
  if (stat.isSymbolicLink()) {
    throw new ResolverError("RESOLVER_PATH_SYMLINK_REFUSED", `Refusing to follow symlink: ${rel}`, {
      workspace,
      rel,
      resolved: canonical,
    });
  }
  return { absPath: canonical, stat };
}

export interface ResolveBodyStreamOptions {
  allowFromFile?: boolean;
  transformString?: (input: string) => string;
  /**
   * Workspace root used to resolve `{ fromFile }` references. Required
   * when `allowFromFile` is true — the resolver refuses references that
   * resolve outside this directory.
   */
  workspace?: string;
  /**
   * When true, `{ fromFile }` references larger than
   * {@link STREAMING_THRESHOLD} are returned as a `ReadableStream`
   * instead of being read into memory. The caller must then pass the
   * stream as `body` with `duplex: "half"` to fetch. Files above
   * {@link MAX_STREAMED_BODY_SIZE} are still rejected up front.
   *
   * When false (default), the runtime buffers the file in memory up
   * to {@link MAX_REQUEST_BODY_SIZE} — preserving 401-refresh-and-retry
   * semantics on the transport.
   */
  allowStreaming?: boolean;
}

/**
 * Result of {@link resolveBodyForFetch} when streaming is enabled. Two
 * cases:
 *  - `bytes`: small payloads (or string bodies) — pass to fetch as-is.
 *  - `stream`: large `{ fromFile }` references — pass to fetch with
 *    `duplex: "half"`. `size` is included so the caller can set
 *    Content-Length explicitly (some upstreams require it).
 */
export type ResolvedRequestBody =
  | { kind: "bytes"; bytes: string | Uint8Array<ArrayBuffer> | undefined; contentType?: string }
  | { kind: "stream"; stream: ReadableStream<Uint8Array>; size: number };

/**
 * Materialise a request body into a `BodyInit`-compatible value.
 * Handles the three shapes accepted by {@link ApiCallRequest.body}:
 * strings (optionally transformed — e.g. placeholder substitution by
 * the local resolver), raw bytes (pass-through), and file references
 * (only resolved when `allowFromFile` is true; sidecar-based transports
 * disallow them since the sidecar has no workspace access).
 *
 * `{ fromFile }` resolution is workspace-rooted via
 * {@link resolveSafePath} and refuses absolute paths, parent-traversal,
 * and symlinks whose target escapes the workspace. Pre-checks file size
 * against {@link MAX_REQUEST_BODY_SIZE} so the runtime surfaces a typed
 * error instead of letting the sidecar return 413.
 */

/**
 * Build a multipart/form-data body from a mixed array of text fields,
 * workspace file references, and inline base64 bytes. Returns the
 * serialised bytes together with the correct `Content-Type` header value
 * (including the boundary) so callers can forward it verbatim to the
 * upstream.
 *
 * The total unencoded size of all parts is checked against
 * {@link MAX_REQUEST_BODY_SIZE}. Attempting to exceed this limit
 * throws {@link ResolverError} `RESOLVER_BODY_TOO_LARGE`. For larger
 * uploads agents must use a single `{ fromFile }` body instead.
 *
 * Path safety (no traversal, no symlinks) is delegated to
 * {@link resolveSafeFile} — the same rules as for `{ fromFile }` bodies.
 */
async function buildMultipartBytes(
  parts: NonNullable<Extract<ApiCallRequest["body"], { multipart: unknown }>["multipart"]>,
  workspace: string,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }> {
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const fd = new FormData();
  let totalSize = 0;

  for (const part of parts) {
    if ("value" in part) {
      // Plain text field — byte-count via Buffer.byteLength so multi-byte
      // Unicode characters (emoji, CJK, …) are counted correctly. When the
      // caller supplies an explicit contentType (e.g. JSON metadata for
      // Drive resumable upload), wrap the value in a Blob so FormData
      // emits the correct `Content-Type` part header instead of defaulting
      // to `text/plain`.
      if (part.contentType) {
        fd.append(part.name, new Blob([part.value], { type: part.contentType }));
      } else {
        fd.append(part.name, part.value);
      }
      totalSize += Buffer.byteLength(part.value, "utf8");
    } else if ("fromFile" in part) {
      // Workspace file reference.
      const { absPath, stat } = await resolveSafeFile(workspace, part.fromFile);
      if (stat.isDirectory()) {
        throw new ResolverError(
          "RESOLVER_BODY_INVALID",
          `multipart file is a directory: ${part.fromFile}`,
        );
      }
      totalSize += stat.size;
      // Enforce the cap from the stat size BEFORE reading — otherwise a
      // multi-gigabyte file is slurped fully into memory and only then
      // rejected. `stat.size` is authoritative for a regular file (symlink
      // escape already rejected by resolveSafeFile).
      if (totalSize > MAX_REQUEST_BODY_SIZE) {
        throw new ResolverError(
          "RESOLVER_BODY_TOO_LARGE",
          `Multipart body exceeds ${MAX_REQUEST_BODY_SIZE} bytes`,
          { max: MAX_REQUEST_BODY_SIZE },
        );
      }
      const fileBytes = await fs.readFile(absPath);
      const blob = new Blob([fileBytes], {
        type: part.contentType ?? "application/octet-stream",
      });
      fd.append(part.name, blob, part.filename ?? path.basename(part.fromFile));
    } else {
      // Inline base64 bytes — validate and decode via shared helper.
      // Note: the per-part size check uses MAX_REQUEST_BODY_SIZE as the
      // per-part upper bound; the total across all parts is checked below.
      const decoded = decodeBase64Body(part.fromBytes, part.encoding, MAX_REQUEST_BODY_SIZE);
      totalSize += decoded.byteLength;
      const blob = new Blob([decoded], {
        type: part.contentType ?? "application/octet-stream",
      });
      // Omit filename entirely when undefined — passing `undefined` to
      // Bun's FormData serializes as the literal string "undefined" in
      // the Content-Disposition header, which is incorrect.
      if (part.filename != null) {
        fd.append(part.name, blob, part.filename);
      } else {
        fd.append(part.name, blob);
      }
    }
    // Cap check after every part type — defense in depth.
    if (totalSize > MAX_REQUEST_BODY_SIZE) {
      throw new ResolverError(
        "RESOLVER_BODY_TOO_LARGE",
        `Multipart body exceeds ${MAX_REQUEST_BODY_SIZE} bytes`,
        { max: MAX_REQUEST_BODY_SIZE },
      );
    }
  }

  // Serialize FormData to bytes. The Response constructor computes the
  // multipart boundary and writes the correct Content-Type header.
  const tempResp = new Response(fd);
  const contentType = tempResp.headers.get("content-type");
  if (!contentType) {
    throw new ResolverError(
      "RESOLVER_BODY_INVALID",
      "Failed to serialize multipart body: missing Content-Type with boundary",
    );
  }
  const arrayBuffer = await tempResp.arrayBuffer();
  return { bytes: toArrayBufferUint8(new Uint8Array(arrayBuffer)), contentType };
}

/**
 * Validate and decode a base64-encoded body string.
 * Accepts only standard base64 (RFC 4648 §4, alphabet `+/`).
 * URL-safe base64 (`-_`) and MIME-folded base64 (with whitespace/newlines)
 * are not accepted. Throws {@link ResolverError} on invalid input or
 * when the decoded size exceeds `maxSize`.
 */
function decodeBase64Body(
  fromBytes: string,
  encoding: string,
  maxSize: number,
): Uint8Array<ArrayBuffer> {
  if (encoding !== "base64") {
    throw new ResolverError("RESOLVER_BODY_INVALID", `Unsupported fromBytes encoding: ${encoding}`);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(fromBytes)) {
    throw new ResolverError("RESOLVER_BODY_INVALID", "Invalid base64 in fromBytes");
  }
  let decoded: Uint8Array<ArrayBuffer>;
  try {
    // `new Uint8Array(arrayLike)` allocates a fresh ArrayBuffer (vs
    // `Uint8Array.from(Buffer)` whose buffer type widens to
    // ArrayBufferLike under TS 5.7+, which DOM-aware consumers like
    // `apps/web` reject when passed to `new Blob([...])`).
    const buf = Buffer.from(fromBytes, "base64");
    decoded = new Uint8Array(buf.byteLength);
    decoded.set(buf);
  } catch (err) {
    throw new ResolverError("RESOLVER_BODY_INVALID", "Invalid base64 in fromBytes", {
      cause: err,
    });
  }
  if (decoded.byteLength > maxSize) {
    throw new ResolverError("RESOLVER_BODY_TOO_LARGE", `fromBytes exceeds ${maxSize} bytes`, {
      size: decoded.byteLength,
      max: maxSize,
    });
  }
  return decoded;
}

/**
 * Resolve an `ApiCallRequest["body"]` into a fetch-ready body. When
 * `allowStreaming` is set AND the body is a `{ fromFile }` reference
 * pointing at a file larger than {@link STREAMING_THRESHOLD}, returns a
 * `ReadableStream` that reads the file lazily from disk; otherwise
 * returns the materialised bytes.
 *
 * The streaming path uses `Bun.file(path).stream()` when running under
 * Bun (preferred) and falls back to `fs.createReadStream` wrapped as a
 * web `ReadableStream` otherwise. Files above
 * {@link MAX_STREAMED_BODY_SIZE} are rejected client-side with
 * {@link ResolverError.code} `RESOLVER_BODY_TOO_LARGE` so an oversized
 * upload never opens a socket.
 *
 * Path safety, symlink refusal, and workspace rooting all flow through
 * the same {@link resolveSafeFile} + lstat pipeline.
 */
export async function resolveBodyForFetch(
  body: ApiCallRequest["body"],
  opts: ResolveBodyStreamOptions = {},
): Promise<ResolvedRequestBody> {
  if (body === undefined || body === null) {
    return { kind: "bytes", bytes: undefined };
  }
  if (typeof body === "string") {
    return {
      kind: "bytes",
      bytes: opts.transformString ? opts.transformString(body) : body,
    };
  }
  if (body instanceof Uint8Array) {
    return { kind: "bytes", bytes: toArrayBufferUint8(body) };
  }
  if (typeof body === "object" && body !== null && "multipart" in body) {
    if (!opts.allowFromFile) {
      throw new ResolverError(
        "RESOLVER_BODY_REFERENCE_FORBIDDEN",
        `resolveBodyForFetch: { multipart } body requires workspace access for file parts; pass allowFromFile`,
      );
    }
    if (!opts.workspace) {
      throw new ResolverError(
        "RESOLVER_MISSING_REQUIRED",
        `resolveBodyForFetch: { multipart } resolution requires a workspace`,
      );
    }
    const { bytes, contentType } = await buildMultipartBytes(body.multipart, opts.workspace);
    return { kind: "bytes", bytes, contentType } as ResolvedRequestBody;
  }
  if (typeof body === "object" && body !== null && "fromBytes" in body) {
    const decoded = decodeBase64Body(body.fromBytes, body.encoding, MAX_REQUEST_BODY_SIZE);
    return { kind: "bytes", bytes: toArrayBufferUint8(decoded) };
  }
  if (!opts.allowFromFile) {
    throw new ResolverError(
      "RESOLVER_BODY_REFERENCE_FORBIDDEN",
      `resolveBodyForFetch: { fromFile: "${body.fromFile}" } body references need workspace access; pass a string/bytes body or use a resolver with allowFromFile`,
      { fromFile: body.fromFile },
    );
  }
  if (!opts.workspace) {
    throw new ResolverError(
      "RESOLVER_MISSING_REQUIRED",
      `resolveBodyForFetch: { fromFile } resolution requires a workspace; resolver did not pass one`,
      { fromFile: body.fromFile },
    );
  }
  const fs = await import("node:fs/promises");
  const { absPath: safePath, stat: lst } = await resolveSafeFile(opts.workspace, body.fromFile);
  // Streaming path: file size > threshold AND caller opted in. Hard
  // cap at MAX_STREAMED_BODY_SIZE — beyond that the upload is refused
  // before any bytes hit the wire.
  if (opts.allowStreaming && lst.size > STREAMING_THRESHOLD) {
    if (lst.size > MAX_STREAMED_BODY_SIZE) {
      throw new ResolverError(
        "RESOLVER_BODY_TOO_LARGE",
        `resolveBodyForFetch: ${JSON.stringify(body.fromFile)} is ${lst.size} bytes; streaming max is ${MAX_STREAMED_BODY_SIZE}`,
        { fromFile: body.fromFile, size: lst.size, max: MAX_STREAMED_BODY_SIZE },
      );
    }
    const stream = await openFileReadStream(safePath);
    return { kind: "stream", stream, size: lst.size };
  }
  // Buffered path: same hard cap as the streaming variant.
  if (lst.size > MAX_REQUEST_BODY_SIZE) {
    throw new ResolverError(
      "RESOLVER_BODY_TOO_LARGE",
      `resolveBodyForFetch: ${JSON.stringify(body.fromFile)} is ${lst.size} bytes; max is ${MAX_REQUEST_BODY_SIZE}`,
      { fromFile: body.fromFile, size: lst.size, max: MAX_REQUEST_BODY_SIZE },
    );
  }
  return { kind: "bytes", bytes: toArrayBufferUint8(await fs.readFile(safePath)) };
}

/**
 * Open a file as a web `ReadableStream<Uint8Array>` suitable for use
 * with fetch + `duplex: "half"`. Prefers `Bun.file().stream()` when
 * running under Bun; falls back to `node:fs.createReadStream` wrapped
 * via the standard `Readable.toWeb` adapter otherwise.
 */
async function openFileReadStream(absPath: string): Promise<ReadableStream<Uint8Array>> {
  const bunGlobal = (
    globalThis as { Bun?: { file: (p: string) => { stream: () => ReadableStream<Uint8Array> } } }
  ).Bun;
  if (bunGlobal && typeof bunGlobal.file === "function") {
    return bunGlobal.file(absPath).stream();
  }
  const fs = await import("node:fs");
  const { Readable } = await import("node:stream");
  const node = fs.createReadStream(absPath);
  return Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>;
}

function toArrayBufferUint8(source: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    source.buffer instanceof ArrayBuffer &&
    source.byteOffset === 0 &&
    source.byteLength === source.buffer.byteLength
  ) {
    return source as Uint8Array<ArrayBuffer>;
  }
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

/**
 * Whitelist of MIME types we are willing to decode as UTF-8 text. Every
 * other Content-Type is treated as binary and base64-encoded — this is
 * the bug fix at the heart of issues #149 / #151. `application/octet-stream`
 * with a body that happens to be ASCII MUST come back as inline bytes,
 * not text.
 */
function isTextLikeMimeType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  if (ct.startsWith("text/")) return true;
  // Charset suffix is a strong signal regardless of base type.
  if (/;\s*charset=/.test(ct)) return true;
  // Structured-syntax suffixes for JSON/XML (RFC 6839) — `+json`, `+xml`.
  // These must come before the general substring tests so e.g.
  // `application/vnd.api+json` is treated as text.
  if (/\+json(\s*;|$)/.test(ct)) return true;
  if (/\+xml(\s*;|$)/.test(ct)) return true;
  // Common base types.
  if (ct.startsWith("application/json")) return true;
  if (ct.startsWith("application/xml")) return true;
  if (ct.startsWith("application/javascript")) return true;
  if (ct.startsWith("application/ecmascript")) return true;
  return false;
}

function parseMimeType(contentType: string | null | undefined): string {
  if (!contentType) return "application/octet-stream";
  const semi = contentType.indexOf(";");
  return (
    (semi >= 0 ? contentType.slice(0, semi) : contentType).trim() || "application/octet-stream"
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const crypto = await import("node:crypto");
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Pipe a `ReadableStream` to disk while computing the running size +
 * sha256 hash. Uses the streaming hash interface (Node's
 * `crypto.createHash` / Bun's `Bun.CryptoHasher` are equivalent here)
 * so the digest finalises after the last chunk, no buffering required.
 *
 * Throws {@link ResolverError} `RESOLVER_BODY_TOO_LARGE` if the
 * cumulative byte count exceeds {@link MAX_STREAMED_BODY_SIZE} — guards
 * against an upstream that ignores Content-Length and dribbles bytes
 * forever.
 *
 * Respects an optional `AbortSignal` — if the signal fires mid-stream,
 * the reader is cancelled, the partial file is removed, and the
 * signal's reason is rethrown.
 *
 * Aborts cleanly on writer error: cancels the source, closes the file
 * handle, and rethrows so callers see the same error path as the
 * buffered writeFile.
 */
async function writeStreamToFile(
  source: ReadableStream<Uint8Array>,
  absPath: string,
  options: { signal?: AbortSignal; maxBytes?: number } = {},
): Promise<{ size: number; sha256: string }> {
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const crypto = await import("node:crypto");
  await fs.mkdir(path.dirname(absPath), { recursive: true });

  const { signal } = options;

  const hasher = crypto.createHash("sha256");
  const handle = await fs.open(absPath, "w");
  let size = 0;
  const reader = source.getReader();

  // Check abort before we start — fast-path for pre-aborted signals.
  if (signal?.aborted) {
    reader.cancel(signal.reason).catch(() => {});
    try {
      await handle.close();
    } catch {
      /* ignore */
    }
    try {
      await fs.unlink(absPath);
    } catch {
      /* ignore */
    }
    throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
  }

  // Build an abort promise that rejects when the signal fires. This lets
  // us race each `reader.read()` against the abort so a hanging upstream
  // doesn't block the event loop indefinitely.
  let rejectOnAbort: ((reason: unknown) => void) | undefined;
  // Keep a stable handler reference so the `finally` block can actually
  // detach it. `{ once: true }` removes it only when the signal fires; on
  // the normal-completion path the listener would otherwise stay attached
  // to a long-lived signal (leak) — and `removeEventListener` with a fresh
  // closure removes nothing.
  let abortHandler: (() => void) | undefined;
  const abortPromise: Promise<never> | null = signal
    ? new Promise<never>((_resolve, reject) => {
        rejectOnAbort = reject;
        abortHandler = () =>
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        signal.addEventListener("abort", abortHandler, { once: true });
      })
    : null;

  // TOCTOU re-check: the signal may have fired between fs.open and the
  // addEventListener call above. addEventListener does NOT fire retroactively
  // for already-aborted signals, so we must re-check here explicitly.
  if (signal?.aborted) {
    reader.cancel(signal.reason).catch(() => {});
    await handle.close().catch(() => {});
    await fs.unlink(absPath).catch(() => {});
    throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
  }

  try {
    while (true) {
      const readPromise = reader.read();
      const raceResult = abortPromise
        ? await Promise.race([readPromise, abortPromise])
        : await readPromise;
      const { value, done } = raceResult;
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_STREAMED_BODY_SIZE) {
        // Drain remaining bytes from upstream and bail. Better to
        // surface a clear error than silently truncate a stream the
        // caller asked us to mirror byte-for-byte.
        await reader.cancel().catch(() => {});
        throw new ResolverError(
          "RESOLVER_BODY_TOO_LARGE",
          `writeStreamToFile: streamed response exceeded ${MAX_STREAMED_BODY_SIZE} bytes`,
          { max: MAX_STREAMED_BODY_SIZE, observed: size },
        );
      }
      hasher.update(value);
      await handle.write(value);
    }
    return { size, sha256: hasher.digest("hex") };
  } catch (err) {
    // Cancel the reader so the upstream stream is closed cleanly.
    reader.cancel(err).catch(() => {});
    // Best-effort cleanup: drop the partial file so the agent doesn't
    // pick up half-written bytes on the next call. Swallow cleanup
    // errors so the original cause surfaces.
    try {
      await handle.close();
    } catch {
      /* ignore */
    }
    try {
      await fs.unlink(absPath);
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    // Silence the unhandled rejection on abortPromise if we resolved via
    // normal completion (the abort never fired).
    if (abortPromise && rejectOnAbort) {
      // Remove the listener by resolving the outer promise chain — we
      // accomplish this by attaching a no-op catch so Node/Bun doesn't
      // surface an unhandled rejection if the signal fires after we return.
      abortPromise.catch(() => {});
    }
    // Release the reader lock. Per WHATWG streams, releaseLock() is a
    // no-op when called after cancel() (which already releases it on the
    // error path), so this is safe to call unconditionally and only has
    // an effect on the success path after the stream ends naturally.
    try {
      reader.releaseLock();
    } catch {
      /* ignore — reader may already be released or closed */
    }
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
    try {
      await handle.close();
    } catch {
      /* idempotent: handle may already be closed by the catch path */
    }
  }
}

function base64Encode(bytes: Uint8Array): string {
  // Buffer is available in both Node and Bun.
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/**
 * Attempt to determine the true MIME type of `buffer` by inspecting its
 * magic bytes (WHATWG MIME Sniffing). Only overrides generic or absent
 * Content-Types (`application/octet-stream` or empty) — if the upstream
 * already declared a specific type it is kept as-is.
 *
 * Uses `file-type` (^22) for the magic-byte lookup. Reads at most the
 * first 4 100 bytes (the library's internal look-ahead window).
 *
 * Streaming responses (responseMode.toFile) are NOT sniffed by this
 * helper — bytes are written to disk before we buffer them. A future
 * improvement could sniff from the first chunk of the stream.
 */
async function maybeSniffMimeType(
  declaredMime: string,
  buffer: Uint8Array,
): Promise<{ mime: string; sniffed: boolean }> {
  // Per WHATWG MIME Sniffing: only override unknown/generic types.
  const isAmbiguous = !declaredMime || declaredMime === "application/octet-stream";
  if (!isAmbiguous) return { mime: declaredMime, sniffed: false };

  try {
    const { fileTypeFromBuffer } = await import("file-type");
    const sniffSlice = buffer.subarray(0, 4100);
    const result = await fileTypeFromBuffer(sniffSlice);
    if (!result) return { mime: declaredMime || "application/octet-stream", sniffed: false };
    return { mime: result.mime, sniffed: true };
  } catch {
    // file-type not available or sniff failed — fall back to declared type.
    return { mime: declaredMime || "application/octet-stream", sniffed: false };
  }
}

export interface SerializeFetchResponseContext {
  workspace: string;
  toolCallId: string;
  responseMode?: { toFile?: string; maxInlineBytes?: number };
  /**
   * When true, prefer streaming the response body straight to disk
   * (computing size + sha256 incrementally) instead of buffering into
   * memory. Only used when the caller has routed the response to a
   * file (`responseMode.toFile`) or auto-spill triggers — small
   * inline bodies always go through the buffered path.
   *
   * The caller is responsible for adding the `X-Stream-Response: 1`
   * header to its sidecar request so the sidecar pipes upstream bytes
   * without truncation; otherwise the buffered/truncated path applies.
   */
  streaming?: boolean;
  /**
   * Optional abort signal forwarded from the caller's {@link ApiCallContext}.
   * When the signal fires mid-stream, `writeStreamToFile` cancels the
   * stream reader and removes any partial file written so far.
   */
  signal?: AbortSignal;
}

/**
 * Serialise a `fetch` response into the spec-shaped
 * {@link ApiCallResponse} every resolver returns to the LLM.
 *
 * Read once via `arrayBuffer()` (NEVER `text()`) so binary bytes are
 * preserved end-to-end — the regression fixed by issues #149 / #151 in
 * the sidecar resurfaced when the runtime moved from `curl` to typed
 * `{ns}__api_call` tools, because the client-side serializer still
 * stringified bytes as UTF-8. Decoding now follows a strict whitelist
 * (text/*, application/json, application/xml, +json/+xml suffixes,
 * `; charset=...`); everything else round-trips as base64 (`inline`)
 * or spills to a file (`file`).
 */
export async function serializeFetchResponse(
  res: Response,
  ctx: SerializeFetchResponseContext,
): Promise<ApiCallResponse> {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const requestedToFileEarly = ctx.responseMode?.toFile;
  const contentTypeEarly = res.headers.get("content-type");
  const mimeTypeEarly = parseMimeType(contentTypeEarly);

  // Streaming response → file: write the body to disk in chunks while
  // computing size + sha256 on the fly. Avoids buffering large
  // payloads (Drive media downloads, bulk exports, …) into memory.
  // Only triggered when the caller opts in via ctx.streaming AND has
  // routed the response to a file — inline bodies always go through
  // the buffered path so the LLM sees a well-formed text/inline body.
  if (
    ctx.streaming &&
    typeof requestedToFileEarly === "string" &&
    requestedToFileEarly.length > 0 &&
    res.body
  ) {
    const safePath = await resolveSafeOutputPath(ctx.workspace, requestedToFileEarly);
    const written = await writeStreamToFile(res.body, safePath, { signal: ctx.signal });
    return {
      status: res.status,
      headers,
      body: {
        kind: "file",
        path: requestedToFileEarly,
        size: written.size,
        mimeType: mimeTypeEarly,
        sha256: written.sha256,
        // file variant: bytes are always streamed in full — never truncated
      },
    };
  }

  const arrayBuffer = await res.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const size = bytes.byteLength;
  const contentType = res.headers.get("content-type");
  const mimeType = parseMimeType(contentType);

  // Read truncation metadata forwarded by the sidecar. X-Truncated is
  // set when the upstream response was sliced at MAX_RESPONSE_SIZE (or
  // the caller-requested X-Max-Response-Size). X-Truncated-Size carries
  // the byte length of the truncated payload (the slice that was kept).
  const truncatedHeader = res.headers.get("x-truncated");
  const truncated = truncatedHeader?.toLowerCase() === "true";
  const truncatedSizeRaw = res.headers.get("x-truncated-size");
  // Guard against malformed header values (e.g. "abc") by checking
  // that the parsed integer is finite before accepting it.
  const parsedTruncatedSize = truncatedSizeRaw !== null ? parseInt(truncatedSizeRaw, 10) : NaN;
  const truncatedSize =
    truncated && Number.isFinite(parsedTruncatedSize) ? parsedTruncatedSize : undefined;

  const requestedToFile = ctx.responseMode?.toFile;
  const requestedInlineLimit = ctx.responseMode?.maxInlineBytes;
  // Cap at the absolute maximum and fall back to the default when the
  // agent did not specify a value. Both bounds mirror the sidecar's.
  const effectiveInlineLimit =
    requestedInlineLimit === undefined
      ? defaultInlineLimit
      : Math.min(Math.max(0, requestedInlineLimit), ABSOLUTE_MAX_RESPONSE_SIZE);

  // 1. Caller asked for a file: write there, regardless of size or mime.
  if (typeof requestedToFile === "string" && requestedToFile.length > 0) {
    const safePath = await resolveSafeOutputPath(ctx.workspace, requestedToFile);
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(safePath), { recursive: true });
    await fs.writeFile(safePath, bytes);
    const sha256 = await sha256Hex(bytes);
    const { mime: finalMime, sniffed } = await maybeSniffMimeType(mimeType, bytes);
    return {
      status: res.status,
      headers,
      body: {
        kind: "file",
        path: requestedToFile,
        size,
        mimeType: finalMime,
        ...(sniffed ? { mimeTypeSniffed: true as const } : {}),
        sha256,
      },
    };
  }

  // 2. Auto-spill: response is larger than the effective inline cap.
  if (size > effectiveInlineLimit) {
    const relative = `responses/${ctx.toolCallId}.bin`;
    const safePath = await resolveSafePath(ctx.workspace, relative);
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(safePath), { recursive: true });
    await fs.writeFile(safePath, bytes);
    const sha256 = await sha256Hex(bytes);
    const { mime: finalMime, sniffed } = await maybeSniffMimeType(mimeType, bytes);
    return {
      status: res.status,
      headers,
      body: {
        kind: "file",
        path: relative,
        size,
        mimeType: finalMime,
        ...(sniffed ? { mimeTypeSniffed: true as const } : {}),
        sha256,
      },
    };
  }

  // 3. Text-like Content-Type: decode UTF-8 with replacement characters
  //    on invalid bytes (`fatal: false`) — we already know the upstream
  //    declared text, so a stray byte should not crash the call.
  //    Text bodies are not sniffed — the declared type is authoritative.
  if (isTextLikeMimeType(contentType)) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return {
      status: res.status,
      headers,
      body: {
        kind: "text",
        text,
        // Omit `truncated` entirely when false — absence means false,
        // which reduces JSON noise and keeps backward-compat cleaner.
        ...(truncated ? { truncated: true as const } : {}),
        ...(truncatedSize !== undefined && { truncatedSize }),
      },
    };
  }

  // 4. Default: small binary payload — base64-encode inline. Even if
  //    the bytes happen to be ASCII (e.g. `application/octet-stream`
  //    carrying "hello"), the strict whitelist above keeps us in the
  //    binary path so the LLM doesn't conflate the two.
  //    Attempt magic-byte sniffing to provide a more useful mimeType.
  const { mime: finalMime, sniffed } = await maybeSniffMimeType(mimeType, bytes);
  return {
    status: res.status,
    headers,
    body: {
      kind: "inline",
      data: base64Encode(bytes),
      encoding: "base64",
      mimeType: finalMime,
      ...(sniffed ? { mimeTypeSniffed: true as const } : {}),
      size,
      // Omit `truncated` entirely when false — absence means false.
      ...(truncated ? { truncated: true as const } : {}),
      ...(truncatedSize !== undefined && { truncatedSize }),
    },
  };
}

function enforceAuthorizedUris(meta: ApiCallMeta, target: string): void {
  if (meta.allowAllUris) return;
  const patterns = meta.authorizedUris ?? [];
  if (patterns.length === 0) {
    throw new AuthorizedUrisError(
      "AUTHORIZED_URIS_EMPTY",
      `Integration ${meta.name}: authorized_uris allowlist is empty; every target is forbidden. ` +
        `Declare authorized_uris in the integration manifest or set allow_all_uris: true.`,
      { integration: meta.name, target },
    );
  }
  for (const pattern of patterns) {
    if (matchesAuthorizedUriSpec(pattern, target)) return;
  }
  throw new AuthorizedUrisError(
    "AUTHORIZED_URIS_MISMATCH",
    `Integration ${meta.name}: target ${target} is not in authorized_uris allowlist`,
    { integration: meta.name, target, allowlist: patterns },
  );
}

/**
 * AFPS-spec URL allowlist matcher:
 *   - literal URLs (no wildcards)   → exact equality
 *   - `*`  (single path segment)    → regex `[^/]*`
 *   - `**` (any substring)          → regex `.*` in the PATH,
 *                                     `[^/]*` in the AUTHORITY
 *
 * All regex metacharacters in the pattern are escaped so pattern authors
 * cannot accidentally inject a regex.
 *
 * SECURITY — authority-boundary containment: neither wildcard may cross the
 * `scheme://host` authority boundary. If `**` compiled to `.*` everywhere,
 * a host wildcard like `https://**.example.com/**` would match
 * `https://evil.com/x/.example.com/y` (the `.*` swallows `evil.com/x` —
 * including the `/` that ends the authority — so the attacker controls the
 * real host). The pattern is therefore split at the first `/` after the
 * scheme: within the authority both `*` and `**` compile to `[^/]*` (an
 * authority never contains a slash), so a host wildcard only ever matches
 * within the host component; only a `**` in the path expands to `.*`.
 */
export function matchesAuthorizedUriSpec(pattern: string, target: string): boolean {
  const regex = new RegExp("^" + compileAuthorizedUriPattern(pattern) + "$");
  return regex.test(target);
}

/** Escape regex metacharacters, leaving the `*` wildcard chars intact. */
function escapeUriLiteral(part: string): string {
  return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile one URL component to a regex fragment. `crossSlash` controls
 * whether a `**` may span `/` (true for the path, false for the authority).
 * `*` never crosses a slash in either component.
 */
function compileUriComponent(part: string, crossSlash: boolean): string {
  const doubleStar = crossSlash ? ".*" : "[^/]*";
  // Match `**` before `*` (alternation is ordered + `**` is longer) so a
  // double-star is never mis-expanded as two single-stars.
  return escapeUriLiteral(part).replace(/\*\*|\*/g, (m) => (m === "**" ? doubleStar : "[^/]*"));
}

function compileAuthorizedUriPattern(pattern: string): string {
  const schemeMatch = pattern.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//);
  if (!schemeMatch) {
    // No `scheme://authority` prefix — compile the whole pattern as a path
    // (preserves the historical `**` → `.*` behavior for opaque targets).
    return compileUriComponent(pattern, true);
  }
  const scheme = schemeMatch[0];
  const afterScheme = pattern.slice(scheme.length);
  const slashIdx = afterScheme.indexOf("/");
  // `https://**` with NO path is the explicit "any host, any path" catch-all
  // (historical behaviour, relied on by the SSRF-gate branch tests). It carries
  // no literal host suffix, so there is nothing for an attacker to smuggle past
  // (the authority-confusion attack needs a fixed suffix like `.example.com`
  // AFTER the `**`), and any actual internal host it admits is still refused
  // downstream by the SSRF gate. So compile the bare form as a full `.*`.
  // Anything WITH a path (`https://**/health`) keeps the authority
  // boundary-contained: `**` in the host is `[^/]*` and cannot swallow the `/`
  // that ends the authority.
  if (slashIdx === -1 && afterScheme === "**") {
    return escapeUriLiteral(scheme) + ".*";
  }
  const authority = slashIdx === -1 ? afterScheme : afterScheme.slice(0, slashIdx);
  const rest = slashIdx === -1 ? "" : afterScheme.slice(slashIdx);
  return (
    escapeUriLiteral(scheme) +
    compileUriComponent(authority, false) +
    compileUriComponent(rest, true)
  );
}
