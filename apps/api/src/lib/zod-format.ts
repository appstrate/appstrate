// SPDX-License-Identifier: Apache-2.0

import type { z } from "zod";
import { renderFieldPath } from "@appstrate/core/api-errors";

/**
 * Render a Zod error's issues into a single `"; "`-joined string of
 * `path: message` segments (root-level issues labelled `<root>`). Shared by the
 * boot-time env validators (`run-limits`, `proxy-limits`,
 * `integration-client-registry`) so their thrown fail-fast messages stay
 * identically formatted.
 *
 * ALL issues, not just the first: an operator fixing a hand-written env JSON
 * should not have to restart the process once per typo.
 *
 * Paths render through `renderFieldPath` — the very renderer the RFC 9457
 * `errors[].field` pointers use — so a nested index reads `clients[0].auth_key`
 * rather than `clients.0.auth_key`, and one path convention holds across boot
 * crashes and API errors instead of two.
 */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${renderFieldPath(i.path) || "<root>"}: ${i.message}`).join("; ");
}
