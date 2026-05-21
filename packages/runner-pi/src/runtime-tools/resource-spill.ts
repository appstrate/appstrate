// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Spill embedded MCP resources to workspace files.
 *
 * MCP servers return file payloads as embedded `resource` content blocks
 * (`{ type: "resource", resource: { uri, text | blob, mimeType? } }`) — the
 * MCP-native way to say "here is a file with this URI". GitHub MCP's
 * `get_file_contents`, Gmail MCP attachments, etc. all use it.
 *
 * Without this step, {@link callToolResultToPi} flattens those blocks to
 * inline text (`[resource <uri>\n<text>]`), which has two failure modes:
 *
 *   1. **Slow round-trip** — the full file lands in the LLM context, so the
 *      only way for the agent to upload it (e.g. `{ns}__api_upload`, which
 *      takes a workspace `fromFile`) is to re-emit the entire content into a
 *      `write` call, token by token. A 10 KB file ≈ a minute of generation.
 *   2. **Binary data loss** — a `blob` resource carries no `text`, so the
 *      inline renderer drops the bytes entirely. Binary downloads (images,
 *      PDFs, archives) silently become empty `[resource <uri>]` pointers.
 *
 * Spilling materialises each resource into a workspace file and replaces the
 * inline block with a short pointer the LLM can pass straight to `fromFile`.
 * This mirrors the legacy provider `responseMode.toFile` behaviour, but
 * generalised to every MCP server that returns resources.
 *
 * Always spills (no size threshold): the whole point is to keep file bytes
 * out of the LLM context, so even small resources are written out.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { resolveSafePath } from "@appstrate/afps-runtime/resolvers";
import type { CallToolResult } from "@appstrate/mcp-transport";

/** Workspace-relative directory spilled resources land in. */
const SPILL_DIR = "resources";

export interface ResourceSpillOptions {
  /** Workspace root — spilled files are written under `<workspace>/resources/`. */
  workspace: string;
  /** Tool call id — namespaces the spilled filename to avoid cross-call collisions. */
  toolCallId: string;
  /** Optional telemetry sink — emits `resource.spilled` per materialised file. */
  emit?: (event: { type: string; [k: string]: unknown }) => void;
  /** Run id stamped on the emitted event. */
  runId?: string;
}

type EmbeddedResource = {
  uri?: string;
  mimeType?: string;
  text?: string;
  blob?: string;
};

/**
 * Rewrite a `CallToolResult` so every embedded `resource` block carrying
 * content (`text` or base64 `blob`) is written to a workspace file and
 * replaced by a `text` pointer. Blocks with nothing to spill (and
 * `resource_link`s, which carry only a URI) are passed through untouched, as
 * are results with no resource blocks (fast path — returns the input).
 *
 * Never throws: a write failure falls back to leaving the original block in
 * place so {@link callToolResultToPi} renders it inline as before.
 */
export async function spillResourcesToWorkspace(
  result: CallToolResult,
  opts: ResourceSpillOptions,
): Promise<CallToolResult> {
  const blocks = result.content;
  if (!Array.isArray(blocks) || !blocks.some((c) => c.type === "resource")) {
    return result;
  }

  const out: CallToolResult["content"] = [];
  let index = 0;
  for (const block of blocks) {
    if (block.type !== "resource") {
      out.push(block);
      continue;
    }
    const inner = block.resource as EmbeddedResource;
    const bytes = resourceBytes(inner);
    if (!bytes) {
      out.push(block);
      continue;
    }

    const rel = `${SPILL_DIR}/${sanitizeSegment(opts.toolCallId)}-${basenameFromUri(inner.uri, index)}`;
    index++;
    try {
      const abs = await resolveSafePath(opts.workspace, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, bytes);
      opts.emit?.({
        type: "resource.spilled",
        runId: opts.runId,
        toolCallId: opts.toolCallId,
        uri: inner.uri,
        path: rel,
        bytes: bytes.byteLength,
        timestamp: Date.now(),
      });
      out.push({ type: "text", text: pointerText(inner, rel, bytes) });
    } catch {
      // Spill failed (path escape, write error) — keep the original block so
      // the downstream adapter still renders it inline. Better degraded than
      // a dropped result.
      out.push(block);
    }
  }

  return { ...result, content: out };
}

/** Decode an embedded resource's payload to bytes, or `null` when it has none. */
function resourceBytes(inner: EmbeddedResource): Uint8Array | null {
  if (typeof inner.text === "string") {
    return new TextEncoder().encode(inner.text);
  }
  if (typeof inner.blob === "string") {
    try {
      return new Uint8Array(Buffer.from(inner.blob, "base64"));
    } catch {
      return null;
    }
  }
  return null;
}

/** Derive a safe filename from a resource URI, falling back to `resource-<n>`. */
function basenameFromUri(uri: string | undefined, index: number): string {
  if (typeof uri === "string" && uri.length > 0) {
    // Strip query/fragment, then take the last path segment.
    const noQuery = uri.split(/[?#]/, 1)[0]!;
    const last = noQuery.split("/").filter(Boolean).pop();
    if (last) {
      const safe = sanitizeSegment(decodeUriComponentSafe(last));
      if (safe && safe !== "_") return safe;
    }
  }
  return `resource-${index}`;
}

function decodeUriComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Collapse anything outside a conservative filename charset to `_`. */
function sanitizeSegment(s: string): string {
  return s
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 128);
}

/** Build the LLM-facing pointer that replaces the inline resource. */
function pointerText(inner: EmbeddedResource, rel: string, bytes: Uint8Array): string {
  const parts = [`${bytes.byteLength} bytes`];
  if (inner.mimeType) parts.push(inner.mimeType);
  let preview = "";
  if (typeof inner.text === "string") {
    const firstLine = inner.text.split("\n", 1)[0]!.slice(0, 120);
    if (firstLine) preview = ` — first line: ${JSON.stringify(firstLine)}`;
  }
  return (
    `[resource ${inner.uri ?? "(no uri)"} → saved to workspace file ${rel} ` +
    `(${parts.join(", ")})${preview}. ` +
    `Pass ${rel} as fromFile to upload it, or read it directly.]`
  );
}
