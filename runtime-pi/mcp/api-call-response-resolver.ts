// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Agent-side shaping of an `{ns}__api_call` RESULT before it reaches the
 * LLM. Two jobs, symmetric to the request-side `api-call-body-resolver`:
 *
 *   1. Surface the upstream HTTP status. The sidecar ships it out-of-band
 *      on `_meta["dev.appstrate/upstream"]`, but `callToolResultToPi` keeps
 *      only `content` — so without this the agent never sees the status
 *      code and can't branch on 200/404/409/… Here we read it back and put
 *      it where the agent can act on it.
 *   2. Honour `responseMode.toFile`. The sidecar has no workspace mount, so
 *      (like `body.fromFile`) this is resolved runtime-side: materialise the
 *      response body to the requested workspace path and hand the agent a
 *      `{ kind: "file", path, size, status }` descriptor instead of the bytes
 *      — keeping large responses out of the model context with a
 *      deterministic, agent-chosen path.
 *
 * When `responseMode.toFile` is absent, large responses still auto-spill to
 * `resources/<file>` (existing behaviour via {@link spillResourcesToWorkspace});
 * we just prepend an `[api_call status=…]` line so the status is visible.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveSafePath } from "@appstrate/afps-runtime/resolvers";
import { spillResourcesToWorkspace, type RuntimeEventEmitter } from "@appstrate/runner-pi";
import { readUpstreamMeta } from "./upstream-meta.ts";

// Structural views — the sidecar's MCP `CallToolResult` carries these
// shapes; we avoid importing the SDK type to keep the helper test-friendly.
interface ResultContentBlock {
  type: string;
  text?: string;
  uri?: string;
}
interface ToolResult {
  content: ResultContentBlock[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

type ReadResource = (uri: string) => Promise<{
  contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>;
}>;

export interface ShapeApiCallResponseOptions {
  workspace: string;
  /** `responseMode.toFile` — workspace-relative path to write the body to. */
  toFile?: string;
  toolCallId: string;
  runId: string;
  emit: RuntimeEventEmitter;
  readResource: ReadResource;
}

/** Upstream status, or `null` when the sidecar attached no `_meta` (defensive). */
function safeStatus(result: ToolResult): number | null {
  try {
    return readUpstreamMeta(result as Parameters<typeof readUpstreamMeta>[0]).status;
  } catch {
    return null;
  }
}

function decodeBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Gather the full response body bytes from a result's content blocks.
 * api_call returns inline `text` (small) or a `resource_link` (the sidecar
 * spilled a large body to its blob store) — never an embedded `resource`.
 */
async function extractBodyBytes(
  result: ToolResult,
  readResource: ReadResource,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const block of result.content) {
    if (block.type === "text" && typeof block.text === "string") {
      chunks.push(enc.encode(block.text));
    } else if (block.type === "resource_link" && typeof block.uri === "string") {
      const c = (await readResource(block.uri)).contents?.[0];
      if (c?.text != null) chunks.push(enc.encode(c.text));
      else if (c?.blob != null) chunks.push(decodeBase64(c.blob));
    }
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Shape an api_call result for the LLM. With `responseMode.toFile`, writes
 * the body to the chosen workspace path and returns a file descriptor; else
 * auto-spills large bodies and prepends the status line.
 */
export async function shapeApiCallResponse(
  result: ToolResult,
  opts: ShapeApiCallResponseOptions,
): Promise<ToolResult> {
  const status = safeStatus(result);

  if (opts.toFile) {
    const bytes = await extractBodyBytes(result, opts.readResource);
    const abs = await resolveSafePath(opts.workspace, opts.toFile);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
    const descriptor = {
      kind: "file" as const,
      path: opts.toFile,
      size: bytes.byteLength,
      ...(status !== null ? { status } : {}),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(descriptor) }],
      ...(result.isError ? { isError: true } : {}),
    };
  }

  // No toFile: keep auto-spill (large → resources/<file>), prepend status.
  const spilled = (await spillResourcesToWorkspace(
    result as Parameters<typeof spillResourcesToWorkspace>[0],
    {
      workspace: opts.workspace,
      toolCallId: opts.toolCallId,
      emit: opts.emit,
      runId: opts.runId,
      readResource: opts.readResource,
    },
  )) as ToolResult;
  if (status === null) return spilled;
  return {
    ...spilled,
    content: [{ type: "text", text: `[api_call status=${status}]` }, ...spilled.content],
  };
}
