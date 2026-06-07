// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Agent-side resolution of `{ns}__api_call` request bodies that reference
 * workspace files — `body: { fromFile }` (raw body) and multipart
 * `{ name, fromFile }` file-parts — into the canonical wire shapes the
 * sidecar accepts (`{ fromBytes, encoding: "base64" }` and inline
 * multipart byte-parts). Resolved BEFORE the MCP `tools/call`, so the LLM
 * authors only a tiny `{ fromFile: "path" }` argument and the file bytes
 * never enter its context.
 *
 * Why agent-side: the sidecar has no workspace mount (the credential
 * isolation invariant — it never sees agent files or paths). The agent
 * runtime owns the workspace, reads the bytes (path-safe, symlink-refused
 * via `resolveSafeFile` — the same gate `api_upload` uses), base64-encodes
 * them, and ships the canonical wire form. The sidecar then decodes once,
 * injects the credential, and makes the upstream call. The credential
 * boundary is unchanged. This mirrors `api-upload-resolver.ts`, but for a
 * single non-chunked body rather than a resumable protocol.
 *
 * Platform vs CLI parity: the standalone `appstrate run` runtime resolves
 * the same `fromFile` shapes via the AFPS `IntegrationApiCallResolver`,
 * which makes the HTTP call itself and can STREAM large files from disk.
 * The platform cannot stream — the bytes cross the agent→sidecar MCP
 * boundary as base64 inside one JSON-RPC envelope — so it caps at
 * `MAX_REQUEST_BODY_SIZE` (default 10 MB; base64 ≈ 13.3 MB, within the
 * 16 MB MCP envelope). Larger payloads belong on `{ns}__api_upload`
 * (resumable) or a dedicated integration.
 */

import { basename } from "node:path";
import { resolveSafeFile, MAX_REQUEST_BODY_SIZE } from "@appstrate/afps-runtime/resolvers";
import { getErrorMessage } from "@appstrate/core/errors";

/**
 * Thrown when a `fromFile` reference cannot be resolved (missing file,
 * symlink, escapes the workspace) or exceeds the platform request-body
 * cap. Surfaced as a structured tool-level error by `direct.ts` so the
 * LLM sees an actionable message rather than an opaque sidecar rejection.
 */
export class ApiCallBodyResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiCallBodyResolveError";
  }
}

export interface ResolveApiCallBodyOptions {
  /** Workspace root `fromFile` paths resolve under (symlink/escape refused). */
  workspace: string;
  /** Max raw (pre-base64) bytes per body. Defaults to {@link MAX_REQUEST_BODY_SIZE}. */
  maxBytes?: number;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MB`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KB`;
  return `${bytes} bytes`;
}

/** Read a workspace file's bytes via Bun, with a Node fallback for tests. */
async function readBytes(absPath: string): Promise<Uint8Array> {
  const bun = (
    globalThis as { Bun?: { file: (p: string) => { bytes: () => Promise<Uint8Array> } } }
  ).Bun;
  if (bun && typeof bun.file === "function") {
    return await bun.file(absPath).bytes();
  }
  const fs = await import("node:fs/promises");
  return new Uint8Array(await fs.readFile(absPath));
}

/**
 * Resolve a single `fromFile` reference to base64, enforcing the path
 * safety and size cap. Returns the raw byte count (for multipart running
 * totals) alongside the base64 payload.
 */
async function readWorkspaceFileBase64(
  rel: string,
  opts: ResolveApiCallBodyOptions,
): Promise<{ bytes: number; base64: string }> {
  const maxBytes = opts.maxBytes ?? MAX_REQUEST_BODY_SIZE;
  let absPath: string;
  let size: number;
  try {
    const resolved = await resolveSafeFile(opts.workspace, rel);
    absPath = resolved.absPath;
    size = resolved.stat.size;
  } catch (err) {
    throw new ApiCallBodyResolveError(
      `api_call: cannot read body file ${JSON.stringify(rel)}: ${getErrorMessage(err)}`,
    );
  }
  if (size > maxBytes) {
    throw new ApiCallBodyResolveError(
      `api_call: body file ${JSON.stringify(rel)} is ${size} bytes, over the ${formatBytes(maxBytes)} ` +
        `request-body cap for { fromFile } on the platform runtime — the bytes cross the ` +
        `agent→sidecar MCP boundary as base64, so there is no streaming. Use {ns}__api_upload ` +
        `(resumable) or a dedicated integration for larger payloads.`,
    );
  }
  const data = await readBytes(absPath);
  return { bytes: size, base64: Buffer.from(data).toString("base64") };
}

/**
 * Resolve an `api_call` `body` argument into the sidecar wire form.
 *
 * Transforms only the workspace-file-bearing shapes:
 *   - `{ fromFile }`                 → `{ fromBytes, encoding: "base64" }`
 *   - multipart `{ name, fromFile }` → `{ name, filename, bytes, encoding, contentType? }`
 *   - multipart `{ name, fromBytes }` (afps inline shape) → renamed to the
 *     sidecar's `{ name, filename, bytes, encoding }` file-part shape.
 *
 * Strings, `null`/`undefined`, already-canonical `{ fromBytes }` bodies,
 * and multipart text parts (`{ name, value }`) pass through untouched.
 * The running multipart total is capped at `maxBytes`, mirroring the
 * sidecar's own decoded-bytes ceiling so an oversize body fails fast
 * agent-side with an actionable message.
 */
export async function resolveApiCallBody(
  body: unknown,
  opts: ResolveApiCallBodyOptions,
): Promise<unknown> {
  if (body == null || typeof body === "string" || typeof body !== "object") return body;
  const b = body as Record<string, unknown>;

  // { fromFile } → { fromBytes, encoding }
  if (typeof b.fromFile === "string") {
    const { base64 } = await readWorkspaceFileBase64(b.fromFile, opts);
    return { fromBytes: base64, encoding: "base64" };
  }

  // { multipart: [...] } → resolve file parts, passthrough text parts
  if (Array.isArray(b.multipart)) {
    const maxBytes = opts.maxBytes ?? MAX_REQUEST_BODY_SIZE;
    let total = 0;
    const parts: unknown[] = [];
    for (const raw of b.multipart) {
      const part = (raw ?? {}) as Record<string, unknown>;
      if (typeof part.fromFile === "string") {
        const { bytes, base64 } = await readWorkspaceFileBase64(part.fromFile, opts);
        total += bytes;
        if (total > maxBytes) {
          throw new ApiCallBodyResolveError(
            `api_call: multipart file parts sum to over ${formatBytes(maxBytes)} — the platform ` +
              `runtime buffers the whole body as base64 over MCP (no streaming). Use ` +
              `{ns}__api_upload or a dedicated integration for larger uploads.`,
          );
        }
        parts.push({
          name: part.name,
          filename:
            typeof part.filename === "string" && part.filename.length > 0
              ? part.filename
              : basename(part.fromFile),
          bytes: base64,
          encoding: "base64",
          ...(typeof part.contentType === "string" ? { contentType: part.contentType } : {}),
        });
      } else if (typeof part.fromBytes === "string") {
        // afps inline-bytes part shape → the sidecar's `bytes` file-part shape.
        parts.push({
          name: part.name,
          filename:
            typeof part.filename === "string" && part.filename.length > 0
              ? part.filename
              : String(part.name ?? "file"),
          bytes: part.fromBytes,
          encoding: "base64",
          ...(typeof part.contentType === "string" ? { contentType: part.contentType } : {}),
        });
      } else {
        // Text part (`{ name, value }`) or an already-wire-shaped part — verbatim.
        parts.push(part);
      }
    }
    return { multipart: parts };
  }

  // { fromBytes } or any other already-canonical shape — passthrough.
  return body;
}

/** JSON-Schema fragment advertised for the `{ fromFile }` raw-body variant. */
function fromFileBodyVariant(cap: string): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["fromFile"],
    properties: {
      fromFile: {
        type: "string",
        description:
          `Workspace-relative path to a file whose bytes become the request body. Read ` +
          `agent-side and sent as base64 (max ${cap}, no streaming) — keeps large bodies ` +
          `out of the model context.`,
      },
    },
  };
}

/** JSON-Schema fragment for a multipart `{ name, fromFile }` file part. */
function fromFileMultipartPartVariant(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["name", "fromFile"],
    properties: {
      name: { type: "string", description: "Form field name" },
      fromFile: {
        type: "string",
        description: "Workspace-relative path to the file for this part (sent as base64).",
      },
      filename: {
        type: "string",
        description:
          "Optional `Content-Disposition` filename. Defaults to the basename of `fromFile`.",
      },
      contentType: {
        type: "string",
        description: "Optional part `Content-Type`. Defaults to `application/octet-stream`.",
      },
    },
  };
}

/**
 * Return a shallow-augmented copy of an `api_call` tool's input schema
 * that advertises the `{ fromFile }` body variant and the multipart
 * `{ name, fromFile }` file-part variant to the LLM. The sidecar's own
 * schema stays canonical — these variants are resolved away by
 * {@link resolveApiCallBody} before the MCP call, so the sidecar only
 * ever sees `{ fromBytes }` / inline byte-parts.
 *
 * Defensive: if the schema's `body` shape isn't the expected `oneOf`
 * structure (e.g. the sidecar schema changed), the original schema is
 * returned unchanged — fromFile simply isn't advertised, never a crash.
 */
export function augmentApiCallInputSchema(inputSchema: unknown): Record<string, unknown> {
  if (inputSchema == null || typeof inputSchema !== "object") {
    return (inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} };
  }
  const cloned = structuredClone(inputSchema) as Record<string, unknown>;
  const props = cloned.properties as Record<string, unknown> | undefined;
  const body = props?.body as Record<string, unknown> | undefined;
  const bodyVariants = body?.oneOf;
  if (!Array.isArray(bodyVariants)) return cloned;

  const cap = formatBytes(MAX_REQUEST_BODY_SIZE);
  bodyVariants.push(fromFileBodyVariant(cap));

  // Find the multipart body variant and extend its part `oneOf` in place.
  for (const variant of bodyVariants) {
    const mp = (variant as { properties?: { multipart?: { items?: { oneOf?: unknown } } } })
      ?.properties?.multipart?.items?.oneOf;
    if (Array.isArray(mp)) {
      mp.push(fromFileMultipartPartVariant());
      break;
    }
  }
  return cloned;
}
