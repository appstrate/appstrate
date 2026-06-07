// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * MCP tool-descriptor `_meta` markers that identify a sidecar-hosted
 * capability tool by WHAT IT IS, not what it is named.
 *
 * The sidecar stamps these onto the `tools/list` descriptor (the SDK and
 * the McpHost carry `_meta` through verbatim — trusted tools bypass
 * sanitisation, and `sanitiseToolDescriptor` spreads `...tool` so the key
 * survives the `{ns}__` rename either way). The agent runtime then routes
 * on the marker instead of pattern-matching the `{ns}__api_call` /
 * `{ns}__api_upload` tool name.
 *
 * Why: a name match is an implicit contract between two packages — it
 * breaks silently if the sidecar renames the tool, mis-fires if a spawned
 * integration advertises a tool that happens to end in `__api_call`, and
 * already has a non-namespaced code path (`createApiCallToolDefs` emits the
 * bare `api_call` name before the host prefixes it). A `_meta` marker is an
 * explicit, rename-safe, collision-proof capability declaration — the
 * MCP-idiomatic way to advertise what a tool supports.
 *
 * Reverse-DNS namespaced per AFPS §2.2, matching `UPSTREAM_META_KEY`.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** `_meta` key marking the generic credential-injecting `api_call` tool. */
export const API_CALL_TOOL_META_KEY = "dev.appstrate/api-call";

/** `_meta` key marking the resumable `api_upload` tool. */
export const API_UPLOAD_TOOL_META_KEY = "dev.appstrate/api-upload";

/** Capability payload carried under {@link API_CALL_TOOL_META_KEY}. */
export interface ApiCallToolMeta {
  /**
   * The tool accepts workspace-file body references — `body: { fromFile }`
   * and multipart `{ name, fromFile }` parts — which the agent runtime
   * resolves to canonical wire bytes before the MCP call.
   */
  body_from_file: true;
}

/** Capability payload carried under {@link API_UPLOAD_TOOL_META_KEY}. */
export interface ApiUploadToolMeta {
  /** Resumable upload protocols this tool dispatches (e.g. `s3-multipart`). */
  protocols: string[];
}

/** Minimal structural view of a tool descriptor's optional `_meta` bag. */
type ToolMetaCarrier = Pick<Tool, "_meta"> | { _meta?: Record<string, unknown> | undefined };

function readToolMeta(tool: ToolMetaCarrier, key: string): Record<string, unknown> | null {
  const meta = (tool as { _meta?: Record<string, unknown> })._meta;
  const entry = meta?.[key];
  return entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
}

/** The api_call capability marker on a tool descriptor, or `null` if absent. */
export function readApiCallToolMeta(tool: ToolMetaCarrier): ApiCallToolMeta | null {
  return readToolMeta(tool, API_CALL_TOOL_META_KEY) as ApiCallToolMeta | null;
}

/** The api_upload capability marker on a tool descriptor, or `null` if absent. */
export function readApiUploadToolMeta(tool: ToolMetaCarrier): ApiUploadToolMeta | null {
  const meta = readToolMeta(tool, API_UPLOAD_TOOL_META_KEY);
  if (!meta) return null;
  const protocols = Array.isArray(meta.protocols)
    ? meta.protocols.filter((p): p is string => typeof p === "string")
    : [];
  return { protocols };
}
