// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * MCP tool-descriptor `_meta` markers that identify a sidecar-hosted
 * capability tool by WHAT IT IS, not what it is named.
 *
 * The sidecar stamps these onto trusted `tools/list` descriptors, which
 * bypass third-party sanitisation and retain the marker through the
 * `{ns}__` rename. `sanitiseToolDescriptor` strips both keys from untrusted
 * descriptors, because they are privileged routing claims rather than
 * general-purpose metadata. The agent runtime routes on the surviving
 * trusted marker instead of pattern-matching the `{ns}__api_call` /
 * `{ns}__api_upload` tool name — a name is an implicit contract that breaks
 * on a rename and mis-fires on a collision.
 *
 * Each marker's payload carries the auth-scoped tool key it belongs to
 * (`api_call`, or `api_call__{authToken}` when the integration opts several
 * auths into the vendor extension). Short auth keys remain verbatim; long
 * keys use the platform's stable bounded token. An `api_upload` descriptor names the key
 * of the `api_call` sibling it dispatches its chunks through, so the agent
 * pairs the two by identity rather than by rewriting one name into the other.
 * Detection stays presence-only, so a descriptor whose payload predates this
 * shape is still recognised as the capability it is.
 *
 * Reverse-DNS namespaced per AFPS §2.2, matching `UPSTREAM_META_KEY`.
 */

/** `_meta` key marking the generic credential-injecting `api_call` tool. */
export const API_CALL_TOOL_META_KEY = "dev.appstrate/api-call";

/** `_meta` key marking the resumable `api_upload` tool. */
export const API_UPLOAD_TOOL_META_KEY = "dev.appstrate/api-upload";

/**
 * `_meta` key marking the `desktop_download` tool — advertised by the
 * sidecar (schema in one place) but EXECUTED agent-side: the extension
 * pulls the downloaded bytes chunk-by-chunk through the sidecar and
 * writes them into the workspace, which the sidecar cannot see.
 */
export const DESKTOP_DOWNLOAD_TOOL_META_KEY = "dev.appstrate/desktop-download";

/** Payload of {@link API_CALL_TOOL_META_KEY} — the auth-scoped tool key. */
export interface ApiCallToolMeta {
  tool_key: string;
}

/** Payload of {@link API_UPLOAD_TOOL_META_KEY} — the sibling api_call's key. */
export interface ApiUploadToolMeta {
  api_call_tool_key: string;
}

/** Anything carrying an optional MCP `_meta` bag (a tool descriptor). */
type ToolMetaCarrier = { _meta?: Record<string, unknown> | undefined };

function hasMarker(tool: ToolMetaCarrier, key: string): boolean {
  return (tool._meta?.[key] ?? null) !== null;
}

function readMarkerField(tool: ToolMetaCarrier, key: string, field: string): string | undefined {
  const payload = tool._meta?.[key];
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** True when the descriptor carries the api_call capability marker. */
export function isApiCallTool(tool: ToolMetaCarrier): boolean {
  return hasMarker(tool, API_CALL_TOOL_META_KEY);
}

/** True when the descriptor carries the api_upload capability marker. */
export function isApiUploadTool(tool: ToolMetaCarrier): boolean {
  return hasMarker(tool, API_UPLOAD_TOOL_META_KEY);
}

/**
 * The auth-scoped key an `api_call` descriptor identifies itself by, or
 * `undefined` when the marker carries no payload.
 */
export function readApiCallToolKey(tool: ToolMetaCarrier): string | undefined {
  return readMarkerField(tool, API_CALL_TOOL_META_KEY, "tool_key");
}

/**
 * The key of the `api_call` sibling an `api_upload` descriptor dispatches
 * through, or `undefined` when the marker carries no payload.
 */
export function readApiUploadSiblingKey(tool: ToolMetaCarrier): string | undefined {
  return readMarkerField(tool, API_UPLOAD_TOOL_META_KEY, "api_call_tool_key");
}

/** True when the descriptor carries the desktop_download agent-side-execution marker. */
export function isDesktopDownloadTool(tool: ToolMetaCarrier): boolean {
  return hasMarker(tool, DESKTOP_DOWNLOAD_TOOL_META_KEY);
}
