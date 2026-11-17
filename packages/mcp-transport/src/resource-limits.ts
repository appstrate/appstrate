// SPDX-License-Identifier: Apache-2.0

/**
 * How much of a resource's bytes a tool or `resources/read` result inlines:
 * the platform's file reads (`read_file`, `resources/read` on `appfile://`) and
 * the chat's `read_resource` tool apply the same bounds, so a model reads the
 * same amount of a resource whichever path it takes. Above a bound, the result
 * carries the resource's metadata and {@link RESOURCE_OVERSIZED_NOTE}.
 */

/** Ceiling on a textual resource's UTF-8 bytes inlined as `text`. */
export const RESOURCE_TEXT_MAX_BYTES = 1024 * 1024;

/**
 * Ceiling on a non-textual resource's RAW bytes inlined as base64 `blob`.
 * Base64 inflates 4/3, so a 700 KiB raw cap keeps the encoded payload
 * (~933 KiB) under the ~1 MB practical MCP response limit.
 */
export const RESOURCE_BLOB_MAX_BYTES = 700 * 1024;

/** Why a result carries a resource's metadata instead of its content. */
export const RESOURCE_OVERSIZED_NOTE =
  "Content omitted — it exceeds the inline size limit (1 MiB text / 700 KiB binary).";
