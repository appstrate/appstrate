// SPDX-License-Identifier: Apache-2.0

/** Scoping headers for every module-chat request. A LEAF: `sessions.ts` imports
 * `chat-skills.ts`, so the copy they share fits in neither. */

import type { GetHeaders } from "./runtime-context.ts";

export function requestHeaders(
  getHeaders: GetHeaders | null | undefined,
  json = false,
): Record<string, string> {
  return { ...(json ? { "Content-Type": "application/json" } : {}), ...getHeaders?.() };
}
