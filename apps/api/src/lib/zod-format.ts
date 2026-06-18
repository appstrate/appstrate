// SPDX-License-Identifier: Apache-2.0

import type { z } from "zod";

/**
 * Render a Zod error's issues into a single `"; "`-joined string of
 * `path: message` segments (root-level issues labelled `<root>`). Shared by the
 * boot-time env-limit validators (`run-limits`, `proxy-limits`) so their thrown
 * fail-fast messages stay identically formatted.
 */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}
