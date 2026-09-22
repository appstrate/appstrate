// SPDX-License-Identifier: Apache-2.0

import type { GetHeaders } from "./runtime-context.ts";

export function requestHeaders(
  getHeaders: GetHeaders | null | undefined,
  json = false,
): Record<string, string> {
  return { ...(json ? { "Content-Type": "application/json" } : {}), ...getHeaders?.() };
}
