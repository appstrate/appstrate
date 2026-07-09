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
 *
 * Structured data vs. text: the file descriptor is ALSO emitted as MCP
 * `structuredContent`, mirrored verbatim into a JSON text block. The tool
 * declares no `outputSchema` (see `sidecar/mcp.ts`, issue #876), so the
 * mirror is the spec's backwards-compat recommendation rather than a
 * validated contract. Do NOT drop the text forms: Pi's `AgentToolResult`
 * forwards only text/image `content` blocks to the model (`details` is
 * logs/UI only — see `callToolResultToPi`), so the `[api_call status=…]`
 * line and the JSON descriptor text block remain the ONLY way the model
 * sees the status while Pi is the runtime.
 */

import { mkdir, lstat, realpath, open } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, resolve, sep } from "node:path";
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
  structuredContent?: Record<string, unknown>;
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
      // Prefer the base64 `blob` (byte-exact) over `text`: a non-UTF-8 /
      // binary body round-tripped through `TextEncoder` would corrupt bytes
      // (invalid sequences replaced with U+FFFD). Only fall back to `text`
      // when the resource carries no blob (genuine text resource).
      if (c?.blob != null) chunks.push(decodeBase64(c.blob));
      else if (c?.text != null) chunks.push(enc.encode(c.text));
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
 * Write `bytes` to `abs` while refusing any symlink escape.
 *
 * `resolveSafePath` confines the *logical* path to the workspace root, but a
 * symlink at (or above) the resolved target can still redirect the actual
 * write outside the sandbox — `writeFile` follows symlinks. Two floors close
 * that hole:
 *
 *   1. After creating the parent, `realpath` it and confirm the resolved path
 *      is still inside the workspace root. This catches a symlinked
 *      intermediate directory (e.g. `/workspace/out -> /etc`) that
 *      `resolveSafePath` accepted on its logical name.
 *   2. Open the final path with `O_NOFOLLOW`, so the open fails with `ELOOP`
 *      when the final component is itself a symlink — closing the TOCTOU
 *      window between the check and the write. An `lstat` pre-check gives a
 *      clearer error for the common already-exists case.
 */
async function writeBodyConfined(workspace: string, abs: string, bytes: Uint8Array): Promise<void> {
  const root = resolve(workspace);
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  const parent = dirname(abs);
  await mkdir(parent, { recursive: true });

  // Floor 1 — the parent dir must not resolve (through any symlink) outside
  // the workspace. `realpath` follows every link in the chain.
  const realParent = await realpath(parent);
  if (realParent !== root && !realParent.startsWith(rootPrefix)) {
    throw new Error(
      "api_call responseMode.toFile: refusing to write — target directory escapes the workspace via a symlink",
    );
  }

  // Floor 2a — refuse a pre-existing symlink at the final path. `lstat` does
  // not follow the link, so a symlinked target is caught before we open it.
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) {
      throw new Error("api_call responseMode.toFile: refusing to write — target path is a symlink");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  // Floor 2b — `O_NOFOLLOW` fails with ELOOP if the final path component is a
  // symlink, closing the TOCTOU gap between the lstat above and the write.
  const handle = await open(
    abs,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
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
    await writeBodyConfined(opts.workspace, abs, bytes);
    const descriptor = {
      kind: "file" as const,
      path: opts.toFile,
      size: bytes.byteLength,
      ...(status !== null ? { status } : {}),
    };
    // Descriptor rides twice, per the MCP spec recommendation: as
    // `structuredContent` (machine-readable, matches the tool's
    // `outputSchema`) and as a JSON text block (the fallback — and the
    // only form Pi forwards to the model, see module doc).
    return {
      content: [{ type: "text", text: JSON.stringify(descriptor) }],
      structuredContent: descriptor,
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
  // The spread keeps `_meta` intact. The sidecar attaches no
  // `structuredContent` on this path (#876) — the body owns `content`.
  // This prefix is the model-visible status channel: Pi forwards only
  // text/image content to the model (see module doc).
  return {
    ...spilled,
    content: [{ type: "text", text: `[api_call status=${status}]` }, ...spilled.content],
  };
}
