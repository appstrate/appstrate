// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * MCP tool-descriptor `_meta` markers that identify a sidecar-hosted
 * capability tool by WHAT IT IS, not what it is named.
 *
 * The sidecar stamps these onto the `tools/list` descriptor (carried
 * through verbatim — trusted tools bypass sanitisation, and
 * `sanitiseToolDescriptor` spreads `...tool` so the key survives the
 * `{ns}__` rename either way). The agent runtime routes on the marker
 * instead of pattern-matching the `{ns}__api_call` / `{ns}__api_upload`
 * tool name — a name is an implicit contract that breaks on a rename,
 * mis-fires on a collision, and already has a non-namespaced code path
 * (`createApiCallToolDefs` emits the bare `api_call` name). The marker is
 * explicit and rename-safe; detection is by presence only.
 *
 * Reverse-DNS namespaced per AFPS §2.2, matching `UPSTREAM_META_KEY`.
 */

/** `_meta` key marking the generic credential-injecting `api_call` tool. */
export const API_CALL_TOOL_META_KEY = "dev.appstrate/api-call";

/** `_meta` key marking the resumable `api_upload` tool. */
export const API_UPLOAD_TOOL_META_KEY = "dev.appstrate/api-upload";

/** Anything carrying an optional MCP `_meta` bag (a tool descriptor). */
type ToolMetaCarrier = { _meta?: Record<string, unknown> | undefined };

function hasMarker(tool: ToolMetaCarrier, key: string): boolean {
  return (tool._meta?.[key] ?? null) !== null;
}

/** True when the descriptor carries the api_call capability marker. */
export function isApiCallTool(tool: ToolMetaCarrier): boolean {
  return hasMarker(tool, API_CALL_TOOL_META_KEY);
}

/** True when the descriptor carries the api_upload capability marker. */
export function isApiUploadTool(tool: ToolMetaCarrier): boolean {
  return hasMarker(tool, API_UPLOAD_TOOL_META_KEY);
}
