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
 * This mirrors the `api_call` `responseMode.toFile` behaviour, but
 * generalised to every MCP server that returns resources.
 *
 * Always spills (no size threshold): the whole point is to keep file bytes
 * out of the LLM context, so even small resources are written out.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { resolveSafePath } from "@appstrate/afps-runtime/resolvers";
import type { CallToolResult } from "@appstrate/mcp-transport";
import type { RuntimeEventEmitter } from "./mcp-forward.ts";

/** Workspace-relative directory spilled resources land in. */
const SPILL_DIR = "resources";

export interface ResourceSpillOptions {
  /** Workspace root — spilled files are written under `<workspace>/resources/`. */
  workspace: string;
  /** Tool call id — namespaces the spilled filename to avoid cross-call collisions. */
  toolCallId: string;
  /** Optional telemetry sink — emits `resource.spilled` per materialised file. */
  emit?: RuntimeEventEmitter;
  /** Run id stamped on the emitted event. */
  runId?: string;
  /**
   * Fetcher for `resource_link` blocks (URI-only, bytes live in the sidecar
   * blob store — e.g. `{ns}__api_call` spilling a response > 32 KB). When
   * provided, each link is resolved via MCP `resources/read` and spilled to a
   * file just like an embedded resource, so the agent can grep / head / tail /
   * read-with-offset it instead of receiving an unreadable `appstrate://` URI.
   * Omitted ⇒ links are passed through untouched (legacy behaviour).
   */
  readResource?: (uri: string) => Promise<{
    contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>;
  }>;
}

type EmbeddedResource = {
  uri?: string;
  mimeType?: string;
  text?: string;
  blob?: string;
};

/**
 * Rewrite a `CallToolResult` so file payloads land in workspace files instead
 * of the LLM context:
 *
 *   - Embedded `resource` blocks (inline `text` / base64 `blob`) are always
 *     spilled.
 *   - `resource_link` blocks (URI only) are spilled when {@link
 *     ResourceSpillOptions.readResource} is provided — the bytes are fetched
 *     via MCP `resources/read` first. Without a fetcher they pass through.
 *
 * Each spilled block is replaced by a short `text` pointer naming the workspace
 * file (with a mime-derived extension so `jq` / `grep` work), so the agent uses
 * its native filesystem tools (read with offset, grep, head/tail) on it.
 *
 * Never throws: a fetch/write failure falls back to leaving the original block
 * in place so {@link callToolResultToPi} renders it as before.
 */
export async function spillResourcesToWorkspace(
  result: CallToolResult,
  opts: ResourceSpillOptions,
): Promise<CallToolResult> {
  const blocks = result.content;
  const canFetchLinks = typeof opts.readResource === "function";
  if (
    !Array.isArray(blocks) ||
    !blocks.some((c) => c.type === "resource" || (canFetchLinks && c.type === "resource_link"))
  ) {
    return result;
  }

  const out: CallToolResult["content"] = [];
  let index = 0;
  for (const block of blocks) {
    // Embedded resource — content is inline.
    if (block.type === "resource") {
      const inner = block.resource as EmbeddedResource;
      const bytes = resourceBytes(inner);
      const replaced = bytes ? await writeAndPointer(inner, bytes, index, opts) : null;
      if (replaced) index++;
      out.push(replaced ?? block);
      continue;
    }
    // Resource link — URI only; fetch the bytes via resources/read, then spill.
    if (block.type === "resource_link" && canFetchLinks) {
      const uri = (block as { uri?: unknown }).uri;
      const linkMime = (block as { mimeType?: unknown }).mimeType;
      let inner: EmbeddedResource | null = null;
      let bytes: Uint8Array | null = null;
      if (typeof uri === "string") {
        try {
          const res = await opts.readResource!(uri);
          const c = res.contents?.[0];
          if (c) {
            inner = {
              uri,
              mimeType: c.mimeType ?? (typeof linkMime === "string" ? linkMime : undefined),
              text: c.text,
              blob: c.blob,
            };
            bytes = resourceBytes(inner);
          }
        } catch {
          // Fetch failed — leave the link untouched (degraded, not dropped).
        }
      }
      const replaced = inner && bytes ? await writeAndPointer(inner, bytes, index, opts) : null;
      if (replaced) index++;
      out.push(replaced ?? block);
      continue;
    }
    out.push(block);
  }

  return { ...result, content: out };
}

/**
 * Write `bytes` to a workspace file derived from the resource URI + mime type
 * and return the `text` pointer block that replaces it. Returns `null` on any
 * write failure so the caller keeps the original block.
 */
async function writeAndPointer(
  inner: EmbeddedResource,
  bytes: Uint8Array,
  index: number,
  opts: ResourceSpillOptions,
): Promise<{ type: "text"; text: string } | null> {
  const base = ensureExtension(basenameFromUri(inner.uri, index), inner.mimeType);
  const rel = `${SPILL_DIR}/${sanitizeSegment(opts.toolCallId)}-${base}`;
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
    return { type: "text", text: pointerText(inner, rel, bytes) };
  } catch {
    return null;
  }
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

/**
 * Append a mime-derived extension when the basename has none, so the agent's
 * `jq` / `grep` / editor tooling recognises the file type. Blob URIs like
 * `appstrate://api-response/{runId}/{ulid}` have an extensionless ULID
 * tail, so without this an `application/json` response would land as a bare
 * `<ulid>` file.
 */
function ensureExtension(name: string, mimeType?: string): string {
  if (/\.[A-Za-z0-9]{1,8}$/.test(name)) return name;
  const ext = extFromMime(mimeType);
  return ext ? `${name}.${ext}` : name;
}

/** Map a MIME type to a file extension, or `null` when unknown. */
function extFromMime(mimeType?: string): string | null {
  if (!mimeType) return null;
  const m = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  switch (m) {
    case "application/json":
      return "json";
    case "text/html":
      return "html";
    case "text/plain":
      return "txt";
    case "text/csv":
      return "csv";
    case "application/xml":
    case "text/xml":
      return "xml";
    case "application/pdf":
      return "pdf";
    default:
      if (m.endsWith("+json")) return "json";
      if (m.endsWith("+xml")) return "xml";
      if (m.startsWith("text/")) return "txt";
      return null;
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
