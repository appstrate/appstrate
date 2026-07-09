// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * MCP exposure of the sidecar's capabilities — the only agent-facing
 * surface.
 *
 * The sidecar's only first-party HTTP endpoint is `/health`; everything
 * the agent talks to (`{ns}__api_call`, `run_history`, `recall_memory`) is
 * dispatched here as MCP tools.
 *
 * Key invariants:
 *
 * 1. `{ns}__api_call` calls {@link executeApiCall} directly via
 *    `proxyDeps`. There is no longer a `/proxy` HTTP envelope — the
 *    same credential-isolation invariants (cred fetch, URL allowlist,
 *    server-side header injection, 401-retry, cookie jar, persistent-
 *    auth-failure reporting) are enforced inside the credential-proxy
 *    core (`./credential-proxy.ts`) which is the SOLE place those
 *    invariants live.
 *
 * 2. `run_history` and `recall_memory` use `proxyDeps.fetchFn` to call
 *    the platform directly (no Hono round-trip). Tests inject a mock
 *    `fetchFn` via `AppDeps`.
 *
 * 3. Stateless transport, **per-request**. Each `/mcp` invocation builds
 *    a fresh `Server` + `WebStandardStreamableHTTPServerTransport` pair,
 *    serves the request, then tears them down. This is not a design
 *    choice — the SDK throws "Stateless transport cannot be reused
 *    across requests" the second time a single
 *    `WebStandardStreamableHTTPServerTransport` constructed with
 *    `sessionIdGenerator: undefined` handles a request. The cost is one
 *    `new Server()` + `transport.connect()` per request, both of which
 *    are pure-memory and synchronous in practice; the upside is that
 *    the agent can issue any number of MCP calls per run lifecycle.
 *
 * 4. Binary upstream responses spill to the run-scoped {@link BlobStore}
 *    and are surfaced as MCP `resource_link` blocks (see
 *    `responseToToolResult`). The agent reads bytes via
 *    `client.readResource({ uri })` only when needed.
 *
 * The endpoint is mounted at `/mcp` because the spec recommends a single
 * URL for both client → server (POST) and server → client (GET stream).
 * We currently only handle POST + DELETE — GET (SSE replay) is out of
 * scope until server-initiated notifications ship.
 */

import type { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  createMcpServer,
  ErrorCode,
  McpError,
  API_CALL_TOOL_META_KEY,
  API_UPLOAD_TOOL_META_KEY,
  type AppstrateToolDefinition,
  type CallToolResult,
  type ReadResourceResult,
  type Resource,
} from "@appstrate/mcp-transport";
import { getErrorMessage } from "@appstrate/core/errors";
import {
  RUN_HISTORY_INJECTED_TOOL,
  RECALL_MEMORY_INJECTED_TOOL,
} from "@appstrate/runner-pi/runtime-tools";
import {
  ABSOLUTE_MAX_RESPONSE_SIZE,
  MAX_MCP_ENVELOPE_SIZE,
  MAX_REQUEST_BODY_SIZE,
  MAX_RESPONSE_SIZE,
  readRequestBodyBounded,
  substituteVars,
} from "./helpers.ts";
import { TokenBudget } from "./token-budget.ts";
import type { LimitFunction } from "p-limit";
import { logger } from "./logger.ts";

/**
 * Strict standard base64 decoder (RFC 4648 §4). Refuses URL-safe
 * (`-_`), MIME-folded (whitespace/newlines), and any non-canonical
 * characters. Returns `"invalid"` instead of throwing so the MCP
 * handler can surface a tool-level error rather than crashing the
 * transport.
 */
function decodeStrictBase64(s: string): Uint8Array | "invalid" {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return "invalid";
  // Canonical RFC 4648 §4 encoding is padded to a multiple of 4 chars. A
  // length ≡ 1 (mod 4) is impossible, and any other non-multiple-of-4 length
  // is a truncated / non-canonical (unpadded) encoding — reject it rather than
  // let `Buffer.from` silently accept it and decode a different byte count.
  if (s.length % 4 !== 0) return "invalid";
  try {
    const buf = Buffer.from(s, "base64");
    const u8 = new Uint8Array(buf.byteLength);
    u8.set(buf);
    // `Buffer.from` also tolerates non-canonical trailing bits (e.g. "AB==",
    // whose discarded bits are non-zero). Require the decode to round-trip to
    // the exact input so only canonical base64 is accepted.
    if (buf.toString("base64") !== s) return "invalid";
    return u8;
  } catch {
    return "invalid";
  }
}
import type { BlobStore } from "./blob-store.ts";
import { executeApiCall, type ApiCallDeps, type ApiCallRequestBody } from "./credential-proxy.ts";
import {
  UPSTREAM_META_KEY,
  buildPreflightUpstreamMeta,
  buildUpstreamMeta,
  type UpstreamMeta,
} from "./upstream-meta.ts";

/**
 * `_meta` payload attached to every `api_call` pre-flight error
 * (no upstream contact). Surfacing `status: 0` lets the runtime
 * distinguish "no upstream contact" from "upstream returned 5xx" via
 * the status code rather than the absence of `_meta` — the runtime
 * parser now requires `_meta` on every CallToolResult.
 */
const API_CALL_PREFLIGHT_META: Record<string, unknown> = {
  [UPSTREAM_META_KEY]: buildPreflightUpstreamMeta(),
};

/**
 * Re-exported alias for the JSON-RPC envelope cap so call sites in this
 * file read consistently. See {@link MAX_MCP_ENVELOPE_SIZE} for the
 * canonical definition (and the `SIDECAR_MAX_MCP_ENVELOPE_BYTES` env
 * override).
 */
const MAX_MCP_REQUEST_BODY_SIZE = MAX_MCP_ENVELOPE_SIZE;

/**
 * Hostnames the agent uses to reach the sidecar. The Docker bridge
 * exposes the sidecar under the `sidecar` alias on port 8080; the
 * process orchestrator (used by `appstrate run` and tests) exposes it
 * under `localhost`/`127.0.0.1` on a *dynamic* port.
 *
 * The MCP SDK's built-in `allowedHosts` does an exact-match check
 * including port, which fails the dynamic-port case (Host header
 * `localhost:51123` is not in the list). We do the validation
 * ourselves — splitting hostname from port — and disable the SDK's
 * own host check via `enableDnsRebindingProtection: false`. The DNS-
 * rebinding defence is preserved because every legitimate caller
 * resolves to one of these hostnames; an attacker rebinding a public
 * domain to 127.0.0.1 still hits a Host header that does not match.
 */
const ALLOWED_HOSTNAMES = new Set(["sidecar", "127.0.0.1", "localhost"]);

function jsonRpcErrorResponse(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function validateMcpHostHeader(req: Request): Response | undefined {
  const hostHeader = req.headers.get("host");
  if (!hostHeader) {
    return jsonRpcErrorResponse(403, -32000, "Invalid Host header: <missing>");
  }
  // Strip port: hostname is everything before the last `:` (handles
  // IPv6 literals `[::1]:8080` too — split on `]:` for them, but the
  // sidecar's allowlist contains no IPv6 literals so a simple last-`:`
  // split is sufficient here).
  const colonIdx = hostHeader.lastIndexOf(":");
  const hostname = colonIdx >= 0 ? hostHeader.slice(0, colonIdx) : hostHeader;
  if (!ALLOWED_HOSTNAMES.has(hostname)) {
    return jsonRpcErrorResponse(403, -32000, `Invalid Host header: ${hostHeader}`);
  }
  return undefined;
}

/**
 * Headers an LLM caller may NOT inject via `api_call.args.headers`.
 *
 * The MCP descriptor advertises that routing / sidecar-control headers
 * are filtered server-side. Without this filter, an LLM could supply
 * `X-Stream-Response: 1` to opt into the binary streaming path (which
 * the MCP layer deliberately does not expose),
 * `X-Substitute-Body: 1` to inject `{{credential}}` placeholders into
 * an attacker-controlled payload, or `X-Max-Response-Size` to bypass
 * the response truncation budget. The `X-Integration` and `X-Target`
 * routing headers are also stripped so the LLM can't redirect the
 * request post-validation. Header names are matched case-insensitively
 * (HTTP header semantics).
 */
const API_CALL_FORBIDDEN_HEADERS = new Set<string>([
  "x-integration",
  "x-integration-id",
  "x-target",
  "x-substitute-body",
  "x-stream-response",
  "x-max-response-size",
  "x-truncated",
  "x-truncated-size",
  "x-auth-refreshed",
]);

/**
 * Strip caller-supplied headers that would forge sidecar control state.
 * Returns the sanitised map plus the list of names that were dropped
 * (used to surface the violation to the agent — silent stripping would
 * mask buggy MCP clients).
 */
function sanitiseApiCallHeaders(raw: Record<string, string> | undefined): {
  headers: Record<string, string>;
  dropped: string[];
} {
  if (!raw) return { headers: {}, dropped: [] };
  const headers: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (API_CALL_FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      dropped.push(name);
      continue;
    }
    headers[name] = value;
  }
  return { headers, dropped };
}

/**
 * Case-insensitive presence check over a sanitised header map. HTTP
 * header names are case-insensitive, but a plain `Record` lookup is
 * not — so a caller's `content-type` would not be seen by a literal
 * `headers["Content-Type"]` read. Used to decide whether the sidecar
 * may inject a default Content-Type without clobbering an explicit one.
 */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

/**
 * MCP `_meta` key under which the sidecar surfaces token-budget
 * accounting to the agent runtime.
 *
 * NOTHING reads it today — no agent-side resolver, no runner, no test
 * outside `sidecar/test/token-budget-integration.test.ts`. It is emitted
 * for operators and for a future consumer ("X / Y tokens of run budget
 * consumed", structured truncation events). Treat it as informational:
 * the spill decisions it reports are already enforced sidecar-side and
 * logged, so a client that drops `_meta` loses telemetry, not behaviour.
 * Do not make it load-bearing without giving it a real reader — most MCP
 * HTTP clients drop result `_meta` (see `META_DROPPED`).
 *
 * Distinct from {@link UPSTREAM_META_KEY} (which carries upstream
 * `{ status, headers }`) so a CallToolResult can carry both without
 * collision.
 *
 * AFPS (Phase F1 follow-up): reverse-DNS namespace — `_meta` keys
 * must be either a single bare token or a reverse-DNS prefix (RFC §10.1
 * / Appendix B). The canonical form is `"dev.appstrate/token-budget"`.
 */
export const TOKEN_BUDGET_META_KEY = "dev.appstrate/token-budget";

/**
 * Discriminated reason surfaced in the agent-facing `_meta` payload.
 * Wider than {@link BudgetDecision.reason} because it adds the
 * caller-driven fallback states (no blob store wired, blob store full)
 * the budget tracker itself cannot produce.
 */
type TokenBudgetMetaReason =
  | "under_inline_cap"
  | "exceeds_inline_cap"
  | "exceeds_run_budget"
  | "exceeds_context_window"
  | "blob_store_full"
  | "no_blob_store_configured";

/**
 * Shape of the {@link TOKEN_BUDGET_META_KEY} payload. Stable wire
 * contract — extensions append, never rename.
 */
interface TokenBudgetMeta {
  /** Tokens estimated for *this* tool output. */
  estimatedTokens: number;
  /** Cumulative tool-output tokens consumed in the run so far. */
  consumedTokens: number;
  /** Configured run-level ceiling. */
  runBudgetTokens: number;
  /** Configured per-call inline cap. */
  inlineCapTokens: number;
  /** What the budget tracker decided (after caller overrides). */
  decision: "inline" | "spill";
  /** Why it decided that way (machine-readable). */
  reason: TokenBudgetMetaReason;
}

/**
 * Per-part metadata caps. Each is caller-supplied and ends up in MIME
 * part headers (`Content-Disposition: name="…"; filename="…"` /
 * `Content-Type: …`); none are counted by `MAX_REQUEST_BODY_SIZE`
 * (which sums decoded file bytes). Without these, a 10 MB `filename`
 * string would pass every existing check.
 */
const MAX_MULTIPART_PARTS = 256;
const MAX_MULTIPART_NAME_LENGTH = 256;
const MAX_MULTIPART_FILENAME_LENGTH = 1024;
const MAX_MULTIPART_CONTENT_TYPE_LENGTH = 256;

/**
 * Runtime shape of a single `api_call.body.multipart[]` entry.
 * Mirrors the JSON Schema on the tool descriptor — kept as an explicit
 * TS type so the handler can narrow without `as` casts. Two variants:
 *
 *   - Field part: `{ name, value }` — a `multipart/form-data` form
 *     field whose value is a string. `{{var}}` placeholders inside the
 *     `value` are substituted when `substituteBody: true`.
 *   - File part: `{ name, filename, bytes: <base64>, encoding, contentType? }`
 *     — a binary file part. `bytes` is base64-decoded into a `Blob`
 *     before being appended to the `FormData`. `{{var}}` substitution
 *     is intentionally NOT applied to binary parts (would corrupt the
 *     payload). `contentType` defaults to `application/octet-stream`.
 */
type MultipartPartArg =
  | { name: string; value: string }
  | {
      name: string;
      filename: string;
      bytes: string;
      encoding: "base64";
      contentType?: string;
    };

interface MultipartValidationOk {
  ok: true;
  /** Decoded file parts paired with their declared metadata. */
  files: Array<{ name: string; filename: string; contentType: string; bytes: Uint8Array }>;
  /** Field parts — string templates that may need {{var}} substitution. */
  fields: Array<{ name: string; value: string }>;
  /** Sum of base64-decoded bytes across all file parts (for cap enforcement). */
  decodedBytes: number;
}

interface MultipartValidationErr {
  ok: false;
  result: CallToolResult;
}

/** Build a preflight error `CallToolResult` for multipart validation. */
function multipartError(
  text: string,
  structuredContent?: CallToolResult["structuredContent"],
): MultipartValidationErr {
  return {
    ok: false,
    result: {
      content: [{ type: "text", text }],
      ...(structuredContent ? { structuredContent } : {}),
      isError: true,
      _meta: API_CALL_PREFLIGHT_META,
    },
  };
}

/**
 * Resolved `api_call` request body: either the internal discriminated
 * {@link ApiCallRequestBody} ready for the proxy (optionally with a
 * Content-Type the sidecar may default), or a preflight error result.
 */
type ResolvedRequestBody =
  | { ok: true; body: ApiCallRequestBody; defaultContentType?: string }
  | { ok: false; result: CallToolResult };

/** Build a labelled preflight error result for a body that cannot be sent. */
function bodyPreflightError(
  label: string,
  text: string,
  structuredContent?: CallToolResult["structuredContent"],
): ResolvedRequestBody {
  return {
    ok: false,
    result: {
      content: [{ type: "text", text: `${label}: ${text}` }],
      ...(structuredContent ? { structuredContent } : {}),
      isError: true,
      _meta: API_CALL_PREFLIGHT_META,
    },
  };
}

/**
 * Resolve the loosely-typed `api_call` body argument (untyped LLM input,
 * no discriminant tag) into the internal discriminated
 * {@link ApiCallRequestBody}. All shape narrowing lives here via `in`
 * checks — the right tool for external, tag-less data — so the handler
 * stays linear and this logic is unit-testable in isolation.
 *
 * Invariant (#765): a body that is PRESENT but cannot be turned into a
 * sendable shape returns an error result — it is NEVER silently dropped
 * to `{ kind: "none" }` and shipped as an empty request.
 *
 * Serialization of a plain JSON object is deferred to the proxy
 * (`kind: "json"`) so `{{var}}` substitution runs on the structured leaf
 * values BEFORE `JSON.stringify` escapes them — an injected credential
 * can never produce malformed JSON.
 */
function resolveRequestBody(
  rawBody: unknown,
  opts: { label: string; substituteBody: boolean },
): ResolvedRequestBody {
  const { label, substituteBody } = opts;

  // Absent / explicit null → genuinely no body.
  if (rawBody == null) return { ok: true, body: { kind: "none" } };

  // multipart/form-data: structured parts, serialization deferred to a
  // FormData build closure so fetch() sets the boundary token itself.
  if (typeof rawBody === "object" && "multipart" in rawBody) {
    const validation = validateMultipartParts((rawBody as { multipart: unknown }).multipart);
    if (!validation.ok) return { ok: false, result: validation.result };
    const { files, fields } = validation;
    const wants = substituteBody;
    return {
      ok: true,
      body: {
        kind: "formData",
        fieldTemplates: wants ? fields.map((f) => f.value) : [],
        build: (activeCreds: Record<string, string>): FormData => {
          const fd = new FormData();
          // Field parts honour {{var}} substitution when opted in; binary
          // parts pass through (substituting into bytes would corrupt them).
          for (const f of fields) {
            fd.append(f.name, wants ? substituteVars(f.value, activeCreds) : f.value);
          }
          for (const file of files) {
            // Slice into a fresh ArrayBuffer so the Blob owns a copy
            // independent of the Uint8Array's backing buffer.
            const ab = file.bytes.buffer.slice(
              file.bytes.byteOffset,
              file.bytes.byteOffset + file.bytes.byteLength,
            ) as ArrayBuffer;
            fd.append(file.name, new Blob([ab], { type: file.contentType }), file.filename);
          }
          return fd;
        },
      },
    };
  }

  // Pre-serialized string (text/JSON/XML/form/NDJSON). Sent verbatim; no
  // Content-Type is guessed — the media type is the caller's to declare.
  if (typeof rawBody === "string") {
    return {
      ok: true,
      body: {
        kind: "buffered",
        bytes: new TextEncoder().encode(rawBody).buffer,
        ...(substituteBody ? { text: rawBody } : {}),
      },
    };
  }

  // Binary upload, base64-encoded agent-side.
  if (typeof rawBody === "object" && "fromBytes" in rawBody) {
    if (substituteBody) {
      return bodyPreflightError(
        label,
        "substituteBody requires a text body — pass body as a string, not { fromBytes }.",
      );
    }
    const decoded = decodeStrictBase64((rawBody as { fromBytes: string }).fromBytes);
    if (decoded === "invalid") {
      return bodyPreflightError(
        label,
        "body.fromBytes is not standard base64 (RFC 4648 §4, alphabet `+/`, no whitespace).",
      );
    }
    if (decoded.byteLength > MAX_REQUEST_BODY_SIZE) {
      return bodyPreflightError(
        label,
        `body.fromBytes is ${decoded.byteLength} bytes, which exceeds the per-request limit of ` +
          `${MAX_REQUEST_BODY_SIZE} bytes. Operators can raise the cap with ` +
          `SIDECAR_MAX_REQUEST_BODY_BYTES (and SIDECAR_MAX_MCP_ENVELOPE_BYTES, since base64 ` +
          `inflation must still fit the JSON-RPC envelope). Files larger than the cap must be ` +
          `split across multiple api_call invocations.`,
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            scope: "request_body",
            limit: MAX_REQUEST_BODY_SIZE,
            actual: decoded.byteLength,
            envVar: "SIDECAR_MAX_REQUEST_BODY_BYTES",
          },
        },
      );
    }
    return {
      ok: true,
      body: {
        kind: "buffered",
        bytes: decoded.buffer.slice(
          decoded.byteOffset,
          decoded.byteOffset + decoded.byteLength,
        ) as ArrayBuffer,
      },
    };
  }

  // `{ fromFile }` must be resolved into `{ fromBytes }` agent-side before
  // the call reaches the sidecar (the file bytes never enter model
  // context). A raw wrapper here means that resolver did not run — error
  // rather than POST a bogus `{"fromFile":…}` JSON body.
  if (typeof rawBody === "object" && "fromFile" in rawBody) {
    return bodyPreflightError(
      label,
      "body.fromFile was not resolved before the call — this is a runtime bug. The file should " +
        "be materialised into { fromBytes, encoding: 'base64' } agent-side before invoking api_call.",
    );
  }

  // Plain JSON object/array — the LLM's natural reflex. Serialization is
  // deferred to the proxy (kind:"json"); default Content-Type to
  // application/json since we know the wire bytes will be JSON.
  if (typeof rawBody === "object") {
    return {
      ok: true,
      body: { kind: "json", value: rawBody },
      defaultContentType: "application/json",
    };
  }

  // Present but not a usable shape (number, boolean, …). Per #765 this must
  // error — never silently fall through to an empty-bodied request.
  return bodyPreflightError(
    label,
    "'body' has an unsupported shape and cannot be sent. Pass a JSON object, a string, " +
      "{ fromBytes, encoding: 'base64' }, or { multipart: [...] }.",
  );
}

/**
 * Validate + decode every entry in `api_call.body.multipart[]`.
 * Returns either the fully-decoded parts ready for `FormData` assembly,
 * or a structured `CallToolResult` describing the first failure (mirrors
 * the `{ fromBytes }` error shapes — invalid base64, oversize payload).
 *
 * `parts` is typed as `unknown` because the MCP SDK does NOT validate
 * `tools/call` arguments against the descriptor's `inputSchema` — a
 * caller could pass a non-array (string/object/null) and the loop would
 * either no-op or emit a confusing per-char error. The first check
 * here is the runtime guard.
 */
function validateMultipartParts(parts: unknown): MultipartValidationOk | MultipartValidationErr {
  if (!Array.isArray(parts)) {
    return multipartError("api_call: body.multipart must be an array of parts.");
  }
  if (parts.length === 0) {
    return multipartError("api_call: body.multipart must contain at least one part.");
  }
  if (parts.length > MAX_MULTIPART_PARTS) {
    return multipartError(
      `api_call: body.multipart has ${parts.length} parts, which exceeds the per-request limit of ${MAX_MULTIPART_PARTS}.`,
    );
  }

  const files: MultipartValidationOk["files"] = [];
  const fields: MultipartValidationOk["fields"] = [];
  let decodedBytes = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as MultipartPartArg | undefined;
    if (!part || typeof part !== "object") {
      return multipartError(`api_call: body.multipart[${i}] must be an object.`);
    }
    if (typeof (part as { name?: unknown }).name !== "string" || part.name.length === 0) {
      return multipartError(`api_call: body.multipart[${i}].name must be a non-empty string.`);
    }
    if (part.name.length > MAX_MULTIPART_NAME_LENGTH) {
      return multipartError(
        `api_call: body.multipart[${i}].name length ${part.name.length} exceeds the per-part limit of ${MAX_MULTIPART_NAME_LENGTH}.`,
      );
    }
    if ("value" in part) {
      if (typeof part.value !== "string") {
        return multipartError(
          `api_call: body.multipart[${i}].value must be a string. Use the file-part shape ({ name, filename, bytes, encoding }) for binary data.`,
        );
      }
      fields.push({ name: part.name, value: part.value });
      continue;
    }
    // File part: { name, filename, bytes, encoding, contentType? }
    if (part.encoding !== "base64") {
      return multipartError(
        `api_call: body.multipart[${i}].encoding must be "base64" (only standard base64 file parts are supported).`,
      );
    }
    if (typeof part.filename !== "string" || part.filename.length === 0) {
      return multipartError(`api_call: body.multipart[${i}].filename must be a non-empty string.`);
    }
    if (part.filename.length > MAX_MULTIPART_FILENAME_LENGTH) {
      return multipartError(
        `api_call: body.multipart[${i}].filename length ${part.filename.length} exceeds the per-part limit of ${MAX_MULTIPART_FILENAME_LENGTH}.`,
      );
    }
    if (
      part.contentType !== undefined &&
      (typeof part.contentType !== "string" ||
        part.contentType.length > MAX_MULTIPART_CONTENT_TYPE_LENGTH)
    ) {
      return multipartError(
        `api_call: body.multipart[${i}].contentType must be a string of at most ${MAX_MULTIPART_CONTENT_TYPE_LENGTH} characters.`,
      );
    }
    const decoded = decodeStrictBase64(part.bytes);
    if (decoded === "invalid") {
      return multipartError(
        `api_call: body.multipart[${i}].bytes is not standard base64 (RFC 4648 §4, alphabet \`+/\`, no whitespace).`,
      );
    }
    decodedBytes += decoded.byteLength;
    if (decodedBytes > MAX_REQUEST_BODY_SIZE) {
      return multipartError(
        `api_call: body.multipart sum of decoded file bytes is ${decodedBytes} bytes ` +
          `(at index ${i}), which exceeds the per-request limit of ${MAX_REQUEST_BODY_SIZE} ` +
          `bytes. Operators can raise the cap with SIDECAR_MAX_REQUEST_BODY_BYTES (and ` +
          `SIDECAR_MAX_MCP_ENVELOPE_BYTES, since base64 inflation must still fit the ` +
          `JSON-RPC envelope).`,
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            scope: "request_body",
            limit: MAX_REQUEST_BODY_SIZE,
            actual: decodedBytes,
            envVar: "SIDECAR_MAX_REQUEST_BODY_BYTES",
          },
        },
      );
    }
    files.push({
      name: part.name,
      filename: part.filename,
      contentType:
        typeof part.contentType === "string" && part.contentType.length > 0
          ? part.contentType
          : "application/octet-stream",
      bytes: decoded,
    });
  }

  return { ok: true, files, fields, decodedBytes };
}

/**
 * Build the `{ns}__api_call`, `run_history`, and `recall_memory` MCP
 * tool definitions. All three tools are implemented in-process —
 * `{ns}__api_call` calls {@link executeApiCall} directly via
 * {@link MountMcpOptions.proxyDeps}; `run_history` and `recall_memory`
 * call `proxyDeps.fetchFn` against the platform upstream. None of
 * these tools round-trip through a Hono HTTP envelope.
 *
 * When an `api_call` upstream response is binary, exceeds the
 * per-call token cap, or would push the run-level cumulative budget
 * past its ceiling (see {@link TokenBudget}), the bytes are stored in
 * the supplied {@link BlobStore} and the tool returns a `resource_link`
 * block instead of an inline text body.
 */
function buildSidecarTools(options: MountMcpOptions): {
  firstParty: AppstrateToolDefinition[];
  makeApiCallTool: (integ: ApiCallIntegrationConfig) => AppstrateToolDefinition;
  makeApiUploadTool: (integ: ApiCallIntegrationConfig) => AppstrateToolDefinition | null;
} {
  const { blobStore, proxyDeps, tokenBudget, apiCallLimit } = options;
  const { config, fetchFn } = proxyDeps;
  // Input schema for the generic `{ns}__api_call` per-integration tool —
  // the integration is implied by the tool name, so the request carries no
  // integration identifier (just target + method + headers + body).
  const CREDENTIAL_PROXY_INPUT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["target"],
    properties: {
      target: {
        type: "string",
        format: "uri",
        description:
          "Absolute target URL. Must match an entry in the integration auth's `authorizedUris` " +
          "(or be a non-private URL if the integration is `allowAllUris`).",
      },
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
        description: "HTTP method. Defaults to GET.",
      },
      headers: {
        type: "object",
        description:
          "Additional headers to forward. Hop-by-hop headers and sidecar-control " +
          "headers (X-Integration, X-Target, X-Substitute-Body, …) are filtered " +
          "server-side.",
        additionalProperties: { type: "string" },
      },
      body: {
        description:
          "Request body. Shapes:\n" +
          '  - JSON object (e.g. { "url": "https://…" }): serialized to a JSON ' +
          "string and sent with Content-Type: application/json by default (unless you set " +
          "the header yourself). Use this for ordinary JSON request bodies.\n" +
          "  - string: pre-serialized text/JSON/XML/form bodies. No Content-Type is added " +
          "automatically — set it yourself when the endpoint needs one.\n" +
          "  - { fromFile: <workspace-relative path> }: send a workspace file's bytes as the " +
          "body without base64-encoding it into this argument. Resolved agent-side (read + " +
          "base64) before the call, so the file never enters the model context. Capped at " +
          "SIDECAR_MAX_REQUEST_BODY_BYTES (buffered over MCP, not streamed — use api_upload for larger).\n" +
          "  - { fromBytes: <base64>, encoding: 'base64' }: binary uploads. " +
          "Standard base64 (RFC 4648 §4) only — no URL-safe alphabet, no whitespace.\n" +
          "  - { multipart: [...] }: multipart/form-data uploads. The sidecar " +
          "builds a `FormData` from the supplied parts and lets `fetch()` set the " +
          "`Content-Type: multipart/form-data; boundary=…` header itself — any " +
          "caller-supplied multipart Content-Type is stripped (the boundary token " +
          "must match the body bytes). Each part is either " +
          "`{ name, value }` (a string field) or " +
          "`{ name, filename, bytes: <base64>, encoding: 'base64', contentType? }` " +
          "(a file part). Decoded byte sizes summed across all parts must fit " +
          "SIDECAR_MAX_REQUEST_BODY_BYTES.",
        oneOf: [
          { type: "string" },
          {
            type: "object",
            additionalProperties: false,
            required: ["fromFile"],
            properties: {
              fromFile: {
                type: "string",
                description:
                  "Workspace-relative path; the runtime reads the file and sends its bytes as the request body.",
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["fromBytes", "encoding"],
            properties: {
              fromBytes: { type: "string" },
              encoding: { const: "base64" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["multipart"],
            properties: {
              multipart: {
                type: "array",
                minItems: 1,
                maxItems: MAX_MULTIPART_PARTS,
                items: {
                  oneOf: [
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["name", "value"],
                      properties: {
                        name: {
                          type: "string",
                          minLength: 1,
                          maxLength: MAX_MULTIPART_NAME_LENGTH,
                        },
                        value: { type: "string" },
                      },
                    },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["name", "filename", "bytes", "encoding"],
                      properties: {
                        name: {
                          type: "string",
                          minLength: 1,
                          maxLength: MAX_MULTIPART_NAME_LENGTH,
                        },
                        filename: {
                          type: "string",
                          minLength: 1,
                          maxLength: MAX_MULTIPART_FILENAME_LENGTH,
                        },
                        bytes: { type: "string" },
                        encoding: { const: "base64" },
                        contentType: {
                          type: "string",
                          maxLength: MAX_MULTIPART_CONTENT_TYPE_LENGTH,
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          {
            // Plain JSON object: serialized to a JSON string and sent with
            // a default `Content-Type: application/json` (unless the caller
            // set one). `not` excludes the reserved wrapper shapes above so
            // this variant stays disjoint from them under strict oneOf.
            type: "object",
            not: {
              anyOf: [
                { required: ["fromFile"] },
                { required: ["fromBytes"] },
                { required: ["multipart"] },
              ],
            },
          },
        ],
      },
      substituteBody: {
        type: "boolean",
        description:
          "When true, the sidecar substitutes `{{credential}}` placeholders in the " +
          "request body. Off by default to avoid accidental token leaks into payloads.",
      },
      responseMode: {
        type: "object",
        additionalProperties: false,
        description:
          "Control where the response body lands. Resolved agent-side (the sidecar has no " +
          "workspace) — keeps large responses out of the model context.",
        properties: {
          toFile: {
            type: "string",
            description:
              "Workspace-relative path to write the response body to. The tool then returns a " +
              "`{ kind: 'file', path, size, status }` descriptor instead of the bytes. " +
              "Without it, responses larger than the inline threshold auto-spill to `resources/<file>`.",
          },
        },
      },
    },
  } as const;

  // `{ns}__api_call` deliberately declares NO `outputSchema`.
  //
  // Declaring one is not free: the MCP SDK client then refuses any
  // non-error result that lacks `structuredContent`, which forced this
  // server to attach `structuredContent: { status }` to every response.
  // Per the MCP spec `structuredContent` is a structured MIRROR of
  // `content` — so a client that prefers it (Claude Code, VS Code)
  // handed the model `{"status":200}` and discarded the response body
  // sitting in `content`. See issue #876.
  //
  // The upstream status/headers/finalUrl ride on `_meta`
  // (`UPSTREAM_META_KEY`); the agent-side shaper re-renders the status
  // into a model-visible text line.
  //
  // Two paths still emit `structuredContent` — legal, since the spec only
  // requires it when an `outputSchema` is declared:
  //   - the agent-side `toFile` descriptor, mirrored verbatim into a text
  //     block (`api-call-response-resolver.ts`),
  //   - the pre-flight refusal envelope (`{ error: { code, … } }`), which
  //     rides alongside `isError: true` and a human-readable message. It
  //     is not a mirror, but a client surfacing it sees strictly more than
  //     the message — never less, and never a swallowed response body.

  // Build one generic `{ns}__api_call` tool for an integration that opted
  // into `apiCall`. Runs the credential-proxy core (body parsing,
  // redirect/cookie/SSRF hardening, 401 refresh, blob spillover) via
  // {@link credentialProxyInner}, scoped to one integration's
  // package id and integration-backed credentials. The integration is
  // implied by the tool name, so the request schema carries no integration
  // identifier.
  //
  // Built lazily (per `/mcp` request) by `mountMcp` because the set of
  // integrations is only known after the background bootstrap finishes.
  const makeApiCallTool = (integ: ApiCallIntegrationConfig): AppstrateToolDefinition => {
    const toolName = integ.toolName ?? "api_call";
    const ctx = {
      proxyDeps: {
        ...proxyDeps,
        fetchCredentials: integ.fetchCredentials,
        refreshCredentials: integ.refreshCredentials,
      },
      integrationId: integ.integrationId,
      label: toolName,
    };
    return {
      descriptor: {
        name: `${integ.namespace}__${toolName}`,
        description:
          `Make an authenticated request through the "${integ.integrationId}" integration's ` +
          "credential-injecting proxy. The sidecar injects the integration's resolved " +
          "credential and forwards the request to the supplied target URL, which must match " +
          "the integration auth's `authorizedUris`. Binary upstream responses spill to MCP " +
          "`resources` and are returned as a `resource_link`.",
        inputSchema:
          CREDENTIAL_PROXY_INPUT_SCHEMA as unknown as AppstrateToolDefinition["descriptor"]["inputSchema"],
        // Capability marker (read agent-side by `direct.ts`) — routes this
        // tool by an explicit, rename-safe flag instead of its
        // `{ns}__api_call` name.
        _meta: { [API_CALL_TOOL_META_KEY]: true },
      },
      handler: async (rawArgs) =>
        apiCallLimit
          ? await apiCallLimit(() => credentialProxyInner(rawArgs, ctx))
          : await credentialProxyInner(rawArgs, ctx),
    };
  };

  // Resumable upload — advertise a
  // `{ns}__api_upload` tool for an integration whose `apiCall` declared
  // ≥1 `uploadProtocols`. The sidecar ONLY advertises this tool: the
  // descriptor (gating enum + JSON schema) lives here so it cannot drift,
  // but the chunked upload itself is orchestrated agent-side
  // (`runtime-pi/mcp/api-upload-extension.ts`, wired by `direct.ts`),
  // because the workspace file the agent uploads is not visible to the
  // credential-isolated sidecar. The agent-side resolver dispatches each
  // chunk back through this integration's `{ns}__api_call` tool, so
  // credential injection + `authorizedUris` + SSRF hardening still apply
  // per chunk. If a misconfigured client calls `{ns}__api_upload`
  // directly against the sidecar (instead of via the agent extension),
  // the handler returns a structured tool-level error rather than
  // attempting an impossible no-workspace upload.
  const makeApiUploadTool = (integ: ApiCallIntegrationConfig): AppstrateToolDefinition | null => {
    const protocols = (integ.uploadProtocols ?? []).filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    if (protocols.length === 0) return null;
    const uploadToolName = (integ.toolName ?? "api_call").replace(/^api_call/, "api_upload");
    return {
      descriptor: {
        name: `${integ.namespace}__${uploadToolName}`,
        description:
          `Upload a workspace file (>5 MB friendly) to the "${integ.integrationId}" integration's ` +
          "API over a chunked resumable protocol. Bytes flow through the credential-injecting " +
          "proxy per chunk; the agent never holds credentials. Returns the upstream's final " +
          "response (file ID, ETag, …) plus a SHA-256 of the bytes uploaded for verification. " +
          "Pick the `uploadProtocol` the API speaks: " +
          "`google-resumable` (Drive, Cloud Storage, YouTube, Photos), " +
          "`s3-multipart` (S3 / R2 / MinIO / Backblaze B2), " +
          "`tus` (Cloudflare Stream, Vimeo, tusd), " +
          "`ms-resumable` (OneDrive, SharePoint, Graph).",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["target", "fromFile", "uploadProtocol"],
          properties: {
            target: {
              type: "string",
              format: "uri",
              description:
                "Initial upload endpoint (Drive: `…?uploadType=resumable`; S3: object URL; " +
                "tus: tus endpoint; MS: `…:/createUploadSession`). Must match the integration " +
                "auth's `authorizedUris`.",
            },
            fromFile: {
              type: "string",
              description: "Workspace-relative path to the file to upload.",
            },
            uploadProtocol: {
              type: "string",
              enum: protocols,
              description:
                "Wire protocol the upstream API speaks. The integration manifest's " +
                "`apiCall.uploadProtocols` gates which protocols are legal here.",
            },
            metadata: {
              type: "object",
              additionalProperties: true,
              description:
                "Per-protocol metadata. Drive: file metadata JSON (`{ name, parents, mimeType }`). " +
                "S3: header overrides (`Content-Type`, `x-amz-meta-*`). " +
                "tus: free-form key/value (encoded as `Upload-Metadata`). " +
                "MS Graph: `{ item: { ... } }` envelope.",
            },
            partSizeBytes: {
              type: "integer",
              minimum: 1,
              description:
                "Chunk size in bytes. Defaults are protocol-tuned (Google: 8 MiB; S3: 5 MiB; " +
                "tus: 4 MiB; MS: 5 MiB). Constraints: Google 256-KiB aligned; S3 ≥5 MiB except " +
                "the last; MS ≤60 MiB and 320-KiB aligned.",
            },
          },
        },
        // Capability marker (read agent-side by `direct.ts`) — routes this
        // tool by an explicit, rename-safe flag instead of its
        // `{ns}__api_upload` name (protocols come from the schema enum).
        _meta: { [API_UPLOAD_TOOL_META_KEY]: true },
      },
      // Advertise-only: the upload is executed agent-side (workspace
      // access), so a direct sidecar invocation cannot succeed.
      handler: async () => ({
        content: [
          {
            type: "text",
            text:
              `${integ.namespace}__api_upload is orchestrated agent-side and cannot run against ` +
              "the sidecar directly (the workspace file is not visible here). It is exposed to " +
              "the LLM as a runtime tool that chunks the file and dispatches each part through " +
              `${integ.namespace}__api_call.`,
          },
        ],
        isError: true,
      }),
    };
  };

  /**
   * Inner handler for `api_call` — extracted so the
   * concurrency-limiting wrapper above can stay shallow and the
   * pre-flight validation / upstream HTTP body can keep its existing
   * control flow without nested closures.
   */
  async function credentialProxyInner(
    rawArgs: unknown,
    ctx: { proxyDeps: ApiCallDeps; integrationId: string; label: string },
  ): Promise<CallToolResult> {
    {
      const args = rawArgs as {
        target: string;
        method?: string;
        headers?: Record<string, string>;
        // Untyped LLM input — a tag-less union of body shapes. Narrowed
        // by `resolveRequestBody` (via `in` checks, the right tool for
        // external data) into the internal discriminated body type.
        body?: unknown;
        substituteBody?: boolean;
      };

      // The MCP SDK does NOT validate `tools/call` arguments against the
      // descriptor's `inputSchema`, so `target` may be absent or a
      // non-string. Guard before it reaches executeApiCall →
      // substituteVars(undefined) → opaque `undefined.replace` TypeError
      // (surfaced as JSON-RPC -32603 instead of a structured tool error).
      if (typeof args.target !== "string" || args.target.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `${ctx.label}: 'target' is required and must be a non-empty string (the request URL or path).`,
            },
          ],
          isError: true,
          _meta: API_CALL_PREFLIGHT_META,
        };
      }

      // Normalise the method to upper-case. The descriptor enum is upper-case
      // and every downstream check (`method === "GET"`, upstream preflight)
      // compares against upper-case literals — a caller-supplied `"get"` /
      // `"post"` must not slip past the GET/HEAD body guard on a case mismatch.
      const method = (typeof args.method === "string" ? args.method : "GET").toUpperCase();

      // Refuse `body` on GET/HEAD explicitly rather than silently
      // dropping it. A model that supplies a body genuinely expects it
      // to be sent — silent drop produces a confusing upstream behaviour
      // (server returns "missing field X" while the agent thinks it
      // sent X). Surface the contract violation as a clear tool-level
      // error instead. JSON Schema can't express conditional `required`
      // cleanly across all MCP clients, so we enforce it in the handler.
      if (args.body !== undefined && (method === "GET" || method === "HEAD")) {
        return {
          content: [
            {
              type: "text",
              text: `${ctx.label}: 'body' is not allowed with method '${method}'. Use POST/PUT/PATCH/DELETE if you need to send a request body.`,
            },
          ],
          isError: true,
          _meta: API_CALL_PREFLIGHT_META,
        };
      }

      const { headers: callerHeaders, dropped } = sanitiseApiCallHeaders(args.headers);
      if (dropped.length > 0) {
        return {
          content: [
            {
              type: "text",
              text:
                `${ctx.label}: caller-supplied headers may not include sidecar-control names: ` +
                `${dropped.join(", ")}. Use the dedicated tool arguments (substituteBody, …) instead.`,
            },
          ],
          isError: true,
          _meta: API_CALL_PREFLIGHT_META,
        };
      }

      // Resolve the loosely-typed body argument into the internal
      // discriminated `ApiCallRequestBody`. All shape narrowing + the
      // silent-drop guard (#765) live in `resolveRequestBody`, keeping
      // this handler linear and the logic unit-testable in isolation.
      const resolved = resolveRequestBody(args.body, {
        label: ctx.label,
        substituteBody: !!args.substituteBody,
      });
      if (!resolved.ok) {
        return resolved.result;
      }
      // Default Content-Type only when the resolver knows the wire bytes
      // are JSON (object body) AND the caller did not set one — never
      // override an explicit choice, never guess for a raw string body.
      if (resolved.defaultContentType && !hasHeader(callerHeaders, "content-type")) {
        callerHeaders["Content-Type"] = resolved.defaultContentType;
      }

      const result = await executeApiCall(
        {
          integrationId: ctx.integrationId,
          targetUrl: args.target,
          method,
          callerHeaders,
          body: resolved.body,
          substituteBody: !!args.substituteBody,
          proxyUrl: config.proxyUrl,
        },
        ctx.proxyDeps,
      );
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `${ctx.label}: ${result.error}` }],
          isError: true,
          // Pre-flight failure (cred fetch, URL allowlist, etc): no
          // upstream contact, but the runtime parser requires `_meta`
          // on every CallToolResult — surface `status: 0` so the agent
          // can distinguish "no upstream contact" from "upstream
          // returned 5xx" via the status code.
          _meta: API_CALL_PREFLIGHT_META,
        };
      }
      return responseToToolResult(result.response, {
        ...(blobStore ? { blobStore } : {}),
        tokenBudget,
        source: `${ctx.label}:${ctx.integrationId}`,
        // Attach upstream `{ status, headers, finalUrl }` to the
        // CallToolResult `_meta` payload so the agent-side resolver
        // can surface real HTTP status / response headers (Location,
        // ETag, Upload-Offset, …) to chunked-upload protocols, plus
        // the post-redirect terminal URL for OAuth/CAS/magic-link
        // callback extraction. Always on for `api_call` — the
        // runtime parser requires it.
        attachUpstreamMeta: true,
        upstreamFinalUrl: result.finalUrl,
      });
    }
  }

  const runHistory: AppstrateToolDefinition = {
    // Name + description + inputSchema are derived from the canonical
    // `run_history` descriptor in `@appstrate/runner-pi/runtime-tools`
    // (the single source consumed by the runtime Pi-tool registration).
    // The handler stays local to the sidecar.
    descriptor: {
      name: RUN_HISTORY_INJECTED_TOOL.name,
      description: RUN_HISTORY_INJECTED_TOOL.description,
      inputSchema:
        RUN_HISTORY_INJECTED_TOOL.parameters as AppstrateToolDefinition["descriptor"]["inputSchema"],
    },
    handler: async (rawArgs) => {
      const args = rawArgs as { limit?: number; fields?: string[] };
      const params = new URLSearchParams();
      if (args.limit !== undefined) params.set("limit", String(args.limit));
      if (args.fields?.length) params.set("fields", args.fields.join(","));
      const qs = params.size > 0 ? `?${params.toString()}` : "";

      const url = `${config.platformApiUrl}/internal/run-history${qs}`;
      let res: Response;
      try {
        res = await fetchFn(url, {
          headers: { Authorization: `Bearer ${config.runToken}` },
        });
      } catch (err) {
        const code =
          err instanceof Error && "code" in err ? (err as { code: string }).code : undefined;
        const suffix = code ? `: ${code}` : "";
        return {
          content: [{ type: "text", text: `run_history: upstream fetch failed${suffix}` }],
          isError: true,
        };
      }
      return responseToToolResult(res, {
        source: "run_history",
        ...(blobStore ? { blobStore } : {}),
        tokenBudget,
      });
    },
  };

  // `recall_memory` MCP tool — backs the agent's archive memory store.
  // Pinned memories are already in the system prompt; this tool fetches
  // the archive (everything else) on demand so the working context stays
  // small. See ADR-012.
  const recallMemory: AppstrateToolDefinition = {
    // Name + description + inputSchema are derived from the canonical
    // `recall_memory` descriptor in `@appstrate/runner-pi/runtime-tools`
    // (the single source consumed by the runtime Pi-tool registration).
    // The handler stays local to the sidecar.
    descriptor: {
      name: RECALL_MEMORY_INJECTED_TOOL.name,
      description: RECALL_MEMORY_INJECTED_TOOL.description,
      inputSchema:
        RECALL_MEMORY_INJECTED_TOOL.parameters as AppstrateToolDefinition["descriptor"]["inputSchema"],
    },
    handler: async (rawArgs) => {
      const args = rawArgs as { q?: string; limit?: number };
      const params = new URLSearchParams();
      if (args.q !== undefined && args.q.length > 0) params.set("q", args.q);
      if (args.limit !== undefined) params.set("limit", String(args.limit));
      const qs = params.size > 0 ? `?${params.toString()}` : "";

      const url = `${config.platformApiUrl}/internal/memories${qs}`;
      let res: Response;
      try {
        res = await fetchFn(url, {
          headers: { Authorization: `Bearer ${config.runToken}` },
        });
      } catch (err) {
        const code =
          err instanceof Error && "code" in err ? (err as { code: string }).code : undefined;
        const suffix = code ? `: ${code}` : "";
        return {
          content: [{ type: "text", text: `recall_memory: upstream fetch failed${suffix}` }],
          isError: true,
        };
      }
      return responseToToolResult(res, {
        source: "recall_memory",
        ...(blobStore ? { blobStore } : {}),
        tokenBudget,
      });
    },
  };

  return { firstParty: [runHistory, recallMemory], makeApiCallTool, makeApiUploadTool };
}

/**
 * Build the resource provider for the supplied {@link BlobStore}.
 *
 * Two surfaces:
 * - `list()` — returns an empty array. Per spec, ephemeral
 *   `resource_link` blocks emitted from tools are NOT enumerated by
 *   `resources/list`. This matches the MCP guidance for run-scoped
 *   blob caches.
 * - `read(uri)` — validates the URI is in the active run's namespace
 *   and returns the bytes. Cross-run reads are silently rejected
 *   (treated as not-found per defence-in-depth).
 */
function buildBlobResourceProvider(blobStore: BlobStore) {
  return {
    list: (): Resource[] => [],
    read: (uri: string): ReadResourceResult => {
      const record = blobStore.read(uri);
      if (!record) {
        // -32002 maps to InvalidParams in the SDK error code enum and
        // is the closest match for "URI doesn't resolve" per spec.
        throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
      }
      const isText = record.mimeType.startsWith("text/") || record.mimeType.includes("json");
      if (isText) {
        return {
          contents: [
            {
              uri: record.uri,
              mimeType: record.mimeType,
              text: new TextDecoder("utf-8", { fatal: false }).decode(record.bytes),
            },
          ],
        };
      }
      // Binary — base64-encode per MCP spec (resources/read content
      // block accepts either `text` or `blob`).
      const base64 =
        typeof Buffer !== "undefined"
          ? Buffer.from(record.bytes).toString("base64")
          : btoa(String.fromCharCode(...record.bytes));
      return {
        contents: [{ uri: record.uri, mimeType: record.mimeType, blob: base64 }],
      };
    },
  };
}

interface ResponseToToolResultOptions {
  /** Run-scoped blob store; required to spill non-text or oversized responses. */
  blobStore?: BlobStore;
  /**
   * Run-scoped token budget. The inline-vs-spill decision for text
   * responses is made on **estimated tokens**, not raw bytes; dense
   * JSON or base64 spills correctly, and a cumulative counter tightens
   * the inline path as the agent's run budget runs down.
   */
  tokenBudget: TokenBudget;
  /** Source label propagated to the BlobStore record (for observability). */
  source?: string;
  /**
   * When true, attach upstream `{ status, headers, finalUrl }` to the
   * `CallToolResult._meta` payload under {@link UPSTREAM_META_KEY}.
   * Required for protocols where the agent must read response
   * headers (`Location:` for resumable uploads, `ETag:` for S3
   * multipart, `Upload-Offset:` for tus) or the post-redirect
   * terminal URL (OAuth Authorization Code, CAS ticket, magic-link).
   * Headers are filtered server-side via the allowlist in
   * `./upstream-meta.ts`; finalUrl is sanitised (userinfo + fragment
   * stripped) before serialisation.
   *
   * Defaults to false for the first-party `run_history` / `recall_memory`
   * tools. The `api_call` path always passes `true` (the runtime parser
   * hard-requires `_meta`), as does the `api_upload` Pi tool.
   */
  attachUpstreamMeta?: boolean;
  /**
   * URL the response was eventually served from after any redirect
   * follow. Forwarded to {@link buildUpstreamMeta} which sanitises it
   * before serialisation. Omitted when no redirect happened (the
   * sidecar passes `result.finalUrl` from {@link executeApiCall}
   * regardless — equals the resolved target URL when no chain).
   */
  upstreamFinalUrl?: string;
}

/**
 * Pure helper: decide whether a text body should spill, and produce
 * the agent-facing `_meta` payload describing the decision.
 *
 * Folded out of {@link responseToToolResult} so the budget logic is
 * unit-testable in isolation and the surrounding async flow stays
 * linear. Calls {@link TokenBudget.tryReserve} so the inline-record is
 * atomic with the decision (no decide/record interleave under
 * concurrent calls).
 */
function evaluateBudget(args: { text: string; tokenBudget: TokenBudget }): {
  shouldSpill: boolean;
  meta: TokenBudgetMeta;
} {
  const estimated = args.tokenBudget.estimate(args.text);
  const decision = args.tokenBudget.tryReserve(estimated);
  // Per-call trace at debug only. Spill events are already surfaced by
  // the downstream "spilled to blob store" / "blob store full" / "no
  // blob store configured" logs in spillToBlobStore.
  logger.debug("token-budget decision", {
    decision: decision.decision,
    reason: decision.reason,
    estimatedTokens: estimated,
    consumedTokens: decision.consumedTokens,
  });
  return {
    shouldSpill: decision.decision === "spill",
    meta: {
      estimatedTokens: estimated,
      consumedTokens: decision.consumedTokens,
      runBudgetTokens: decision.runBudgetTokens,
      inlineCapTokens: decision.inlineCapTokens,
      decision: decision.decision,
      reason: decision.reason,
    },
  };
}

/**
 * Convert an upstream `Response` into an MCP CallToolResult.
 *
 * Non-OK responses become tool-level errors (`isError: true`) — the
 * model still receives them as data and can react. The SDK reserves
 * thrown errors for protocol-level faults; per-tool 4xx/5xx are
 * domain-level signals.
 *
 * Behaviour:
 * - Text/JSON/XML whose **estimated token count** fits under the
 *   per-call inline cap AND the run-level cumulative budget → inline
 *   `text` block. Token estimation uses the Anthropic-recommended
 *   ~3.5 chars/token heuristic (see `./token-budget.ts`).
 * - Text/JSON/XML that exceeds the per-call cap OR would push the
 *   cumulative budget past its ceiling → spilled to the BlobStore as
 *   a `resource_link`. The agent reads the bytes via
 *   `client.readResource({ uri })` only if needed.
 * - Binary content → always spilled regardless of size (binary in the
 *   agent's context window is never useful).
 * - No BlobStore configured → binary rejected; text that should spill is
 *   forced inline and recorded against the token budget with a distinct
 *   reason. Production always supplies a BlobStore + TokenBudget via
 *   `mountMcp`.
 *
 * Every text-path result carries a `dev.appstrate/token-budget` `_meta`
 * payload so the agent runtime can surface accounting and react to
 * structured truncation events.
 */
async function responseToToolResult(
  res: Response,
  options: ResponseToToolResultOptions,
): Promise<{
  content: Array<
    | { type: "text"; text: string }
    | {
        type: "resource_link";
        uri: string;
        name: string;
        mimeType?: string;
      }
  >;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}> {
  // Capture upstream status + allowlisted headers BEFORE consuming the
  // body. The Response object's `headers` view stays valid after read,
  // but resolving the meta up-front keeps the code path linear and
  // documents the dependency: meta is independent of content.
  const upstreamMeta: UpstreamMeta | undefined = options.attachUpstreamMeta
    ? buildUpstreamMeta(res, options.upstreamFinalUrl)
    : undefined;

  // Budget meta accumulates per-response: estimated cost + the tracker's
  // decision are folded in by the text path below. Stays undefined for
  // binary spills where no text estimate is meaningful.
  let budgetMeta: TokenBudgetMeta | undefined;

  type Result = {
    content: Array<
      | { type: "text"; text: string }
      | { type: "resource_link"; uri: string; name: string; mimeType?: string }
    >;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
  // Helper: attach `_meta` to every return path. We merge upstream-
  // exchange meta and token-budget meta into a single payload — both
  // are independent of agent-side mapping, both can be present
  // simultaneously.
  //
  // No `structuredContent` is attached here. The response body owns
  // `content`, and a `structuredContent` that does not mirror it makes
  // spec-compliant clients drop the body (#876). The status, headers and
  // finalUrl travel on `_meta[UPSTREAM_META_KEY]`, which the agent-side
  // shaper reads back into a model-visible `[api_call status=…]` line.
  const withMeta = (r: Result): Result => {
    if (!upstreamMeta && !budgetMeta) return r;
    const meta: Record<string, unknown> = {};
    if (upstreamMeta) meta[UPSTREAM_META_KEY] = upstreamMeta;
    if (budgetMeta) meta[TOKEN_BUDGET_META_KEY] = budgetMeta;
    return { ...r, _meta: meta };
  };

  const ct = res.headers.get("content-type") ?? "";
  const isText = ct.startsWith("text/") || ct.includes("json") || ct.includes("xml");

  if (!isText) {
    if (!options.blobStore) {
      return withMeta({
        content: [
          {
            type: "text",
            text:
              `api_call: non-text response of type '${ct || "unknown"}' is not supported on ` +
              `this path without a configured blob store. Binary upstream responses are linked as ` +
              `MCP resources — verify the sidecar was started with a runId.`,
          },
        ],
        isError: true,
      });
    }
    // Spill to blob store and return a resource_link.
    // When a blob store is available, raise the cap to ABSOLUTE_MAX_RESPONSE_SIZE:
    // the spillover path exists precisely for bodies larger than MAX_RESPONSE_SIZE,
    // so capping the read at MAX_RESPONSE_SIZE refuses real-world binaries
    // (PDFs 1-10 MB, images, ZIPs) that the agent would consume via pdf-toolkit,
    // vision, etc. Symmetrical to the text path below.
    const binaryReadCap = options.blobStore ? ABSOLUTE_MAX_RESPONSE_SIZE : MAX_RESPONSE_SIZE;
    const bytes = await readBodyToBuffer(res, binaryReadCap);
    if (bytes === "exceeded") {
      return withMeta({
        content: [
          {
            type: "text",
            text:
              `api_call: response exceeds ${binaryReadCap} bytes (${binaryReadCap >= 1024 * 1024 ? `${Math.round(binaryReadCap / 1024 / 1024)} MB` : `${Math.round(binaryReadCap / 1024)} KB`}) — refused without truncation ` +
              `(truncating an opaque binary blob is unsafe).`,
          },
        ],
        isError: true,
      });
    }
    let record;
    try {
      record = options.blobStore.put(bytes, {
        mimeType: ct || "application/octet-stream",
        ...(options.source !== undefined ? { source: options.source } : {}),
      });
    } catch (err) {
      return withMeta({
        content: [
          {
            type: "text",
            text: `api_call: blob store rejected upstream response — ${getErrorMessage(err)}`,
          },
        ],
        isError: true,
      });
    }
    const link = {
      type: "resource_link" as const,
      uri: record.uri,
      name: options.source ?? "blob",
      mimeType: record.mimeType,
    };
    return withMeta(res.ok ? { content: [link] } : { content: [link], isError: true });
  }

  // Text — bound the read. We stream into a buffer rather than calling
  // res.text() directly so a hypothetical multi-GB response can never
  // be fully materialised before the cap kicks in.
  //
  // When a blob store is available, raise the cap to ABSOLUTE_MAX_RESPONSE_SIZE:
  // the spillover path exists precisely to handle bodies larger than
  // MAX_RESPONSE_SIZE, so capping the read at MAX_RESPONSE_SIZE before deciding
  // to spill silently truncated text bodies above 256 KB (they were spilled,
  // but with a `[truncated]` marker poisoning the JSON). Without a blob store
  // there's no recovery path, so the conservative cap stays.
  const readCap = options.blobStore ? ABSOLUTE_MAX_RESPONSE_SIZE : MAX_RESPONSE_SIZE;
  const text = await readBodyBounded(res, readCap);

  // Token-aware spill decision. The token-budget path uses an atomic
  // tryReserve() so cumulative state doesn't drift under concurrent
  // calls (two awaits between decide() and record() would otherwise
  // let two callers both observe a stale `consumed`).
  const evaluation = evaluateBudget({
    text,
    tokenBudget: options.tokenBudget,
  });
  budgetMeta = evaluation.meta;
  const shouldSpillForBudget = evaluation.shouldSpill;

  // If the text body should spill AND we have a blob store, spill it.
  // The agent gets a pointer instead of poisoning its context with a
  // dense JSON dump that would silently consume its run budget.
  if (options.blobStore && shouldSpillForBudget) {
    const bytes = new TextEncoder().encode(text);
    let record;
    try {
      record = options.blobStore.put(bytes, {
        mimeType: ct || "text/plain",
        ...(options.source !== undefined ? { source: options.source } : {}),
      });
    } catch (err) {
      // Blob store full — surface a distinct reason and record the
      // forced-inline tokens against the budget. tryReserve() did NOT
      // record on the spill path, so we record explicitly here.
      budgetMeta = { ...budgetMeta, decision: "inline", reason: "blob_store_full" };
      options.tokenBudget.record(budgetMeta.estimatedTokens);
      logger.warn("token-budget: blob store full, forced inline", {
        source: options.source,
        estimatedTokens: budgetMeta.estimatedTokens,
        consumedTokens: options.tokenBudget.consumedTokens(),
        error: getErrorMessage(err),
      });
      const fallback: Result = res.ok
        ? { content: [{ type: "text", text }] }
        : { content: [{ type: "text", text }], isError: true };
      return withMeta(fallback);
    }
    logger.info("token-budget: spilled to blob store", {
      source: options.source,
      reason: budgetMeta?.reason,
      estimatedTokens: budgetMeta?.estimatedTokens,
      consumedTokens: budgetMeta?.consumedTokens,
      uri: record.uri,
    });
    const link = {
      type: "resource_link" as const,
      uri: record.uri,
      name: options.source ?? "blob",
      mimeType: record.mimeType,
    };
    return withMeta(res.ok ? { content: [link] } : { content: [link], isError: true });
  }

  // Inline path — when the budget said spill but no blob store is
  // configured, surface the distinct reason and record the
  // forced-inline tokens. tryReserve() did NOT record on the spill
  // path, so we record explicitly here.
  if (shouldSpillForBudget && !options.blobStore) {
    budgetMeta = { ...budgetMeta, decision: "inline", reason: "no_blob_store_configured" };
    options.tokenBudget.record(budgetMeta.estimatedTokens);
    logger.warn("token-budget: no blob store configured, forced inline", {
      source: options.source,
      estimatedTokens: budgetMeta.estimatedTokens,
      consumedTokens: options.tokenBudget.consumedTokens(),
    });
  }

  if (!res.ok) {
    return withMeta({ content: [{ type: "text", text }], isError: true });
  }
  return withMeta({ content: [{ type: "text", text }] });
}

/**
 * Read a Response body as raw bytes, refusing the read if `maxBytes`
 * is breached. Returns `"exceeded"` on overflow — for binary spills we
 * never want a partial body that the agent might mistake for the full
 * content.
 */
async function readBodyToBuffer(res: Response, maxBytes: number): Promise<Uint8Array | "exceeded"> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel();
        return "exceeded";
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged;
}

/**
 * Read a Response body as text, truncating to `maxBytes` bytes. We
 * append a single `[truncated]` marker so the agent can tell the read
 * was bounded — silent truncation would let a bad upstream poison the
 * agent's reasoning with a short-but-wrong prefix.
 */
async function readBodyBounded(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(merged);
  return truncated ? `${text}\n[truncated: response exceeded ${maxBytes} bytes]` : text;
}

/**
 * Mount the MCP endpoint on the supplied Hono app.
 *
 * Per-request transport (stateless mode requirement): the SDK's
 * `WebStandardStreamableHTTPServerTransport` constructed with
 * `sessionIdGenerator: undefined` records `_hasHandledRequest = true`
 * after its first call and throws on the second — "Stateless transport
 * cannot be reused across requests. Create a new transport per
 * request." Reusing the same transport across `/mcp` calls would cap
 * the agent at one MCP call per sidecar lifetime, which is unusable.
 *
 * The tool definitions are computed once (pure data — they reference
 * `app.request()` lazily, not `app` state). The `Server` and
 * `WebStandardStreamableHTTPServerTransport` are constructed fresh for
 * each request. Construction is pure-memory and `server.connect()` on
 * the web-standard transport is synchronous in practice, so the
 * per-request cost is negligible compared to the upstream HTTP hop the
 * tool then performs.
 */
/**
 * One integration's `api_call` wiring.
 * The credential adapters are built by the sidecar boot from the
 * integration's live credentials source; `mountMcp` threads them into a
 * per-integration `ApiCallDeps` so the generic tool reuses the
 * shared credential-proxy core.
 */
export interface ApiCallIntegrationConfig {
  /** McpHost-style namespace — the tool is named `{namespace}__{toolName}`. */
  namespace: string;
  /**
   * Bare api_call tool name (before the `{namespace}__` prefix). `api_call`
   * for an integration that opts in a single auth; `api_call__{authKey}` when
   * it opts in several. Defaults to `api_call` when omitted. The companion
   * upload tool swaps the `api_call` prefix for `api_upload`.
   */
  toolName?: string;
  /** Integration package id (used as the proxy `integrationId` + audit source). */
  integrationId: string;
  /** Resolve the integration's credentials into the proxy payload. */
  fetchCredentials: ApiCallDeps["fetchCredentials"];
  /** Force-refresh on a mid-run 401 and re-resolve (null when not rotated). */
  refreshCredentials: NonNullable<ApiCallDeps["refreshCredentials"]>;
  /**
   * Resumable-upload protocols this integration's `apiCall` declared
   * (`manifest.apiCall.uploadProtocols`). When non-empty the sidecar
   * ALSO advertises a `{ns}__api_upload` tool alongside `{ns}__api_call`.
   * The sidecar only ADVERTISES it (gating + schema live here); the
   * actual chunked upload is orchestrated agent-side by `direct.ts`'s
   * resolver (which has workspace access — the sidecar does not) and
   * dispatched chunk-by-chunk back through this integration's
   * `{ns}__api_call` tool. Empty / omitted → no upload tool.
   */
  uploadProtocols?: readonly string[];
}

/**
 * Credential-proxy core deps needed to build one integration's `api_call`
 * (+ optional `api_upload`) tool definitions outside of `mountMcp`. The
 * sidecar boot (`integrations-boot.ts`) builds these once per run and
 * passes them in so the api_call tools can be hosted as a trusted
 * in-process MCP server registered on the McpHost — same pipeline as
 * spawned/remote integration tools.
 */
export interface ApiCallToolDeps {
  proxyDeps: ApiCallDeps;
  blobStore?: BlobStore;
  tokenBudget: TokenBudget;
  apiCallLimit?: LimitFunction;
}

/**
 * Build the `api_call` (+ optional `api_upload`) {@link AppstrateToolDefinition}s
 * for one integration, named UNPREFIXED (`api_call` / `api_upload`). The
 * caller registers them on the McpHost, which applies the `{ns}__` prefix
 * (yielding the `{ns}__api_call` name) + tool-name validation. The
 * handlers reuse the exact credential-proxy core (`credentialProxyInner`)
 * via {@link buildSidecarTools}, with the integration's credential adapters
 * injected per-call.
 */
export function createApiCallToolDefs(
  integ: ApiCallIntegrationConfig,
  deps: ApiCallToolDeps,
): AppstrateToolDefinition[] {
  const { makeApiCallTool, makeApiUploadTool } = buildSidecarTools(deps);
  const out: AppstrateToolDefinition[] = [];
  const call = makeApiCallTool(integ);
  out.push({ ...call, descriptor: { ...call.descriptor, name: API_CALL_TOOL_NAME } });
  const upload = makeApiUploadTool(integ);
  if (upload) {
    out.push({ ...upload, descriptor: { ...upload.descriptor, name: API_UPLOAD_TOOL_NAME } });
  }
  return out;
}

/** Unprefixed tool names for the generic credential-injecting tools. */
export const API_CALL_TOOL_NAME = "api_call";
export const API_UPLOAD_TOOL_NAME = "api_upload";

/**
 * True for the synthetic `api_call` / `api_upload` tool names (bare, or the
 * per-auth `__{authKey}` variants). These are served by the in-process api_call
 * server, never by the integration's own MCP server, so any accounting over the
 * spawned server's tools must exclude them.
 *
 * Kept as a local predicate rather than importing `@appstrate/core/integration`
 * — the sidecar bundle deliberately avoids pulling in the manifest schema stack.
 */
export function isSyntheticApiToolName(name: string): boolean {
  for (const base of [API_CALL_TOOL_NAME, API_UPLOAD_TOOL_NAME]) {
    if (name === base || name.startsWith(`${base}__`)) return true;
  }
  return false;
}

export interface MountMcpOptions {
  /** Run-scoped blob store for `api_call` resource spillover. */
  blobStore?: BlobStore;
  /**
   * Credential-proxy core deps. `api_call` calls
   * {@link executeApiCall} directly with structured args; `run_history`
   * and `recall_memory` use `proxyDeps.fetchFn` + `proxyDeps.config` to
   * reach the platform upstream. Required: there is no longer a legacy
   * HTTP-route fallback.
   */
  proxyDeps: ApiCallDeps;
  /**
   * Run-scoped token budget. Every tool output is run through the
   * budget tracker before being delivered to the agent; dense JSON that
   * fits under a byte cap but would exhaust the context window spills
   * to the blob store, and a structured `dev.appstrate/token-budget`
   * `_meta` payload records the accounting.
   */
  tokenBudget: TokenBudget;
  /**
   * Run-scoped fan-out limiter for `api_call`. Caps the number of
   * concurrent upstream HTTP hops a single run can issue at once.
   * Without a cap, an agent that fetches N items in parallel (8 Gmail
   * messages, 20 ClickUp tasks, …) can feed the next LLM turn an
   * over-sized JSON dump and blow past the upstream model's TPM
   * window. See issue #427 for the reference incident.
   *
   * Optional only so tests / embedders can omit it; production wires a
   * `pLimit` instance unconditionally via `createApp` (see `app.ts`).
   */
  apiCallLimit?: LimitFunction;
  /**
   * Lazy provider for additional MCP tool definitions to merge alongside
   * the first-party sidecar tools (run_history, recall_memory).
   * Called on EVERY `/mcp` request so the sidecar's HTTP surface comes up
   * before integration MCP servers finish their initial handshake. The
   * integration runtime (Phase 1.4) wires `McpHost.buildTools` here:
   * tools registered after the sidecar started serving become visible on
   * the next `tools/list` without restarting anything. First-party
   * names take precedence.
   */
  additionalToolsProvider?: () => AppstrateToolDefinition[];
  /**
   * Promise that resolves once the integration runtime has finished its
   * initial bootstrap pass. The first `/mcp` request awaits it (capped
   * at INTEGRATION_BOOT_WAIT_MS) so the agent's initial `tools/list`
   * sees all declared integration tools, even though the sidecar's HTTP
   * listener came up first. Subsequent requests skip the wait (the
   * promise is already resolved).
   */
  integrationBootPromise?: Promise<void>;
}

/**
 * Cap on how long the first `/mcp` request waits for integrations to
 * register their tools before responding. Tuned for the Phase 1.5 path
 * on Docker Desktop / macOS: per-integration spawn pays for `docker
 * create` + `docker cp bundle` + `docker cp ca.pem` (MITM) +
 * `docker start` + Python/Node runner cold-start + MCP handshake, each
 * `docker exec` round-trip costing 1–2 s on the LinuxKit VM. Linux hosts
 * see <2 s end-to-end; the ceiling exists to bound pathological cases,
 * not the happy path. Mirrors the agent-side MCP connect deadline so a
 * truly hung integration boot surfaces as the agent's own handshake
 * timeout rather than as an empty toolset (the failure mode that hides
 * the bug — the LLM cheerfully tells the user the integration is not
 * connected instead of erroring out).
 */
const INTEGRATION_BOOT_WAIT_MS = 30_000;

export function mountMcp(app: Hono, options: MountMcpOptions): void {
  const { firstParty } = buildSidecarTools(options);
  const firstPartyNames = new Set(firstParty.map((t) => t.descriptor.name));
  const resources = options.blobStore ? buildBlobResourceProvider(options.blobStore) : undefined;
  // Cache the await so only the first `/mcp` request pays the wait —
  // every subsequent request sees an already-resolved promise. The
  // timeout side of the race logs when it fires so a slow boot doesn't
  // silently degrade the agent's toolset (see comment on
  // INTEGRATION_BOOT_WAIT_MS).
  let bootReady = options.integrationBootPromise;
  if (bootReady) {
    bootReady = Promise.race([
      bootReady.then(() => {
        bootReady = undefined; // resolved — skip the race on later requests
      }),
      new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          // Best-effort log; tools/list still responds with whatever
          // integrations DID register before the deadline. Operators
          // diagnosing "agent doesn't see my integration" should look
          // for this line.
          logger.warn(
            "integration boot wait exceeded; tools/list will respond without late integrations",
            { waitMs: INTEGRATION_BOOT_WAIT_MS },
          );
          resolve();
        }, INTEGRATION_BOOT_WAIT_MS);
        t.unref?.();
      }),
    ]);
  }

  app.all("/mcp", async (c) => {
    // Host header validation (DNS-rebinding defence). Done here, not by
    // the SDK, so we accept dynamic-port Host values like
    // `localhost:51123` (process-orchestrator mode) while still
    // rejecting anything outside `ALLOWED_HOSTNAMES`.
    const hostError = validateMcpHostHeader(c.req.raw);
    if (hostError) return hostError;

    // Body-size guard: the SDK transport calls `await req.json()`
    // unconditionally on POST. We pre-read the body (bounded), then
    // hand a fresh Request to the transport. `Content-Length`, when
    // declared, is enforced up-front; otherwise we stream and abort if
    // the cap is exceeded mid-read. Either way the SDK never sees a
    // body larger than MAX_MCP_REQUEST_BODY_SIZE.
    const method = c.req.method.toUpperCase();
    let forwarded: Request = c.req.raw;
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      const envelopeOversizeError = (actual: number | null) => ({
        jsonrpc: "2.0" as const,
        error: {
          code: -32600,
          message:
            actual !== null
              ? `Request body exceeds ${MAX_MCP_REQUEST_BODY_SIZE} bytes (declared ${actual}).`
              : `Request body exceeds ${MAX_MCP_REQUEST_BODY_SIZE} bytes.`,
          data: {
            reason: "PAYLOAD_TOO_LARGE",
            scope: "mcp_envelope",
            limit: MAX_MCP_REQUEST_BODY_SIZE,
            ...(actual !== null ? { actual } : {}),
            envVar: "SIDECAR_MAX_MCP_ENVELOPE_BYTES",
            hint:
              "Raise the JSON-RPC envelope cap via SIDECAR_MAX_MCP_ENVELOPE_BYTES " +
              "(remember base64 inflation: ~1.37×). Per-call body size is also bounded " +
              "by SIDECAR_MAX_REQUEST_BODY_BYTES; both caps must be raised together for " +
              "larger uploads.",
          },
        },
        id: null,
      });
      const declared = c.req.header("content-length");
      if (declared !== undefined) {
        const declaredLength = Number(declared);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_MCP_REQUEST_BODY_SIZE) {
          return c.json(envelopeOversizeError(declaredLength), 413);
        }
      }
      const bodyBytes = await readRequestBodyBounded(c.req.raw, MAX_MCP_REQUEST_BODY_SIZE);
      if (bodyBytes === "exceeded") {
        return c.json(envelopeOversizeError(null), 413);
      }
      // Reconstruct a Request the SDK can read once. The SDK clones the
      // Request internally on its first read, so a single rebuild here
      // is sufficient.
      forwarded = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: bodyBytes,
      });
    }

    // Wait for the integration runtime to finish its first bootstrap
    // pass (max INTEGRATION_BOOT_WAIT_MS = 30s). The wait is amortised: only the first `/mcp`
    // request pays it; once the promise resolves we drop the reference
    // so subsequent requests skip the await entirely.
    if (bootReady) await bootReady;
    // Resolve tools per-request so integrations that finish booting AFTER
    // the sidecar's HTTP listener is up still surface on the next call.
    // The generic `api_call` (+ optional
    // `api_upload`) tools are registered on the McpHost as trusted
    // in-process MCP servers at boot (see integrations-boot.ts), so they
    // arrive here through `additionalToolsProvider` (= host.buildTools)
    // exactly like any spawned/remote integration tool. One pipeline.
    const dynamicExtras = (options.additionalToolsProvider?.() ?? []).filter(
      (t) => !firstPartyNames.has(t.descriptor.name),
    );
    const tools = [...firstParty, ...dynamicExtras];
    // `createMcpServer` validates every descriptor (tool-name pattern, schema
    // shape). A single malformed dynamic tool would otherwise throw here —
    // outside the try/finally below — and 500 the entire `/mcp` POST, taking
    // down even the first-party tools. Degrade gracefully: log the offending
    // descriptor, drop the dynamic extras, and serve first-party only so the
    // agent can still connect.
    let server: ReturnType<typeof createMcpServer>;
    try {
      server = createMcpServer(
        tools,
        { name: "appstrate-sidecar", version: "1" },
        resources ? { resources } : {},
      );
    } catch (err) {
      logger.error("MCP server build failed; serving first-party tools only", {
        error: err instanceof Error ? err.message : String(err),
        dynamicToolNames: dynamicExtras.map((t) => t.descriptor.name),
      });
      server = createMcpServer(
        firstParty,
        { name: "appstrate-sidecar", version: "1" },
        resources ? { resources } : {},
      );
    }
    // Stateless mode: passing `sessionIdGenerator: undefined` explicitly
    // disables session tracking. Combined with per-request construction,
    // there is no state to leak between agent invocations, no map to
    // bound, and no SDK contract to violate.
    //
    // DNS-rebinding defence is enforced above by `validateMcpHostHeader`
    // (port-tolerant, supports dynamic-port deployments). The SDK's own
    // host/origin check is therefore disabled.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: false,
    });
    try {
      await server.connect(transport);
      // `handleRequest` returns a `Promise<Response>` we hand straight
      // back to Hono. Awaiting before returning ensures the `finally`
      // teardown runs after the response has been fully composed (the
      // SDK populates the response body synchronously into the Response
      // object before resolving the promise).
      return await transport.handleRequest(forwarded);
    } finally {
      await transport.close();
      await server.close();
    }
  });
}
