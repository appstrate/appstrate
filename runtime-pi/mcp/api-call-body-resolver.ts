// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Agent-side resolution of an `{ns}__api_call` request body that references
 * a workspace file — `body: { fromFile: "path" }` — into the canonical
 * `{ fromBytes, encoding: "base64" }` wire form the sidecar accepts.
 * Resolved BEFORE the MCP `tools/call`, so the LLM authors only a tiny
 * `{ fromFile }` argument and the file bytes never enter its context.
 *
 * Why agent-side: the sidecar has no workspace mount (the credential
 * isolation invariant — it never sees agent files or paths). The agent
 * runtime owns the workspace, reads the bytes (path-safe, symlink-refused
 * via `resolveSafeFile` — the same gate `api_upload` uses), base64-encodes
 * them, and ships the canonical wire form. The sidecar then decodes once,
 * injects the credential, and makes the upstream call. The credential
 * boundary is unchanged.
 *
 * Platform vs CLI: the standalone `appstrate run` runtime resolves the same
 * `fromFile` shape via the AFPS `IntegrationApiCallResolver`, which makes
 * the HTTP call itself and can STREAM large files. The platform cannot
 * stream — the bytes cross the agent→sidecar MCP boundary as base64 inside
 * one JSON-RPC envelope — so it caps at `MAX_REQUEST_BODY_SIZE` (default
 * 10 MB; base64 ≈ 13.3 MB, within the 16 MB MCP envelope). Larger payloads
 * belong on `{ns}__api_upload` (resumable) or a dedicated integration.
 */

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
  /** Max raw (pre-base64) bytes. Defaults to {@link MAX_REQUEST_BODY_SIZE}. */
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
  if (bun && typeof bun.file === "function") return await bun.file(absPath).bytes();
  const fs = await import("node:fs/promises");
  return new Uint8Array(await fs.readFile(absPath));
}

/**
 * Resolve an `api_call` `body` argument. When it is `{ fromFile: "path" }`,
 * read the workspace file (path-safe, size-capped) and return
 * `{ fromBytes, encoding: "base64" }`. Every other shape — strings,
 * `null`/`undefined`, already-canonical `{ fromBytes }`, `{ multipart }` —
 * passes through untouched.
 */
export async function resolveApiCallBody(
  body: unknown,
  opts: ResolveApiCallBodyOptions,
): Promise<unknown> {
  if (body == null || typeof body !== "object") return body;
  const fromFile = (body as Record<string, unknown>).fromFile;
  if (typeof fromFile !== "string") return body;

  const maxBytes = opts.maxBytes ?? MAX_REQUEST_BODY_SIZE;
  let absPath: string;
  let size: number;
  try {
    const resolved = await resolveSafeFile(opts.workspace, fromFile);
    absPath = resolved.absPath;
    size = resolved.stat.size;
  } catch (err) {
    throw new ApiCallBodyResolveError(
      `api_call: cannot read body file ${JSON.stringify(fromFile)}: ${getErrorMessage(err)}`,
    );
  }
  if (size > maxBytes) {
    throw new ApiCallBodyResolveError(
      `api_call: body file ${JSON.stringify(fromFile)} is ${size} bytes, over the ${formatBytes(maxBytes)} ` +
        `request-body cap for { fromFile } on the platform runtime — the bytes cross the ` +
        `agent→sidecar MCP boundary as base64, so there is no streaming. Use {ns}__api_upload ` +
        `(resumable) or a dedicated integration for larger payloads.`,
    );
  }
  const data = await readBytes(absPath);
  return { fromBytes: Buffer.from(data).toString("base64"), encoding: "base64" };
}
