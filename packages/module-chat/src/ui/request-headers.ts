// SPDX-License-Identifier: Apache-2.0

/**
 * The scoping headers every module-chat request carries.
 *
 * A LEAF, imported by both `sessions.ts` and `chat-skills.ts`: the two files
 * had byte-identical copies of this helper, and `sessions.ts` importing
 * `chat-skills.ts` means the shared one cannot live in either.
 */

import type { GetHeaders } from "./runtime-context.ts";

/** The host's org/space headers, plus the JSON content type when there is a body. */
export function requestHeaders(
  getHeaders: GetHeaders | null | undefined,
  json = false,
): Record<string, string> {
  return { ...(json ? { "Content-Type": "application/json" } : {}), ...getHeaders?.() };
}
