// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Sidecar-facing deprecation header surface.
 *
 * Phase 3b introduced these constants locally; Phase 6 (#276) hoisted
 * the implementation into `@appstrate/mcp-transport` so registry,
 * future hosts, and the sidecar all surface the same Sunset date.
 * This file remains as the sidecar's import barrel — same names, same
 * shape — with the single source of truth one layer deeper.
 *
 * Routes covered:
 * - `/llm/*` — replaced by the MCP `llm_complete` tool. Agents on
 *   `RUNTIME_MCP_CLIENT=1` should NEVER hit this route directly.
 * - `/proxy?X-Stream-Response=1` — replaced by `provider_call`
 *   returning a `resource_link` block. The buffered `/proxy` path is
 *   NOT deprecated yet (still load-bearing for non-MCP runtime-pi).
 */

import {
  DEPRECATION_DATE_V2,
  SUNSET_DATE_V2,
  MIGRATION_GUIDE_URL as _MIGRATION_GUIDE_URL,
  deprecationHeaders,
} from "@appstrate/mcp-transport";

export const DEPRECATION_DATE = DEPRECATION_DATE_V2.toUTCString();
export const SUNSET_DATE = SUNSET_DATE_V2.toUTCString();
export const MIGRATION_GUIDE_URL = _MIGRATION_GUIDE_URL;

/**
 * Standard set of headers applied to deprecated routes. Both legacy
 * surfaces (legacy-llm-routes, legacy-binary-passthrough) share the
 * same V2 sunset, so one record is sufficient. Spread directly into
 * Hono `c.header()` calls.
 */
export const DEPRECATION_HEADERS: Record<string, string> = deprecationHeaders("legacy-llm-routes");
