// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import { ApiError } from "../lib/errors.ts";

/**
 * Refuses every credential but the dashboard's own cookie session. A decision about what a space
 * lets its agents run must come from a person looking at the screen: an API key, an OIDC/MCP/CLI
 * token or the chat loopback acts for the user without that person reading the tool definition.
 */
export async function requireDashboardSession(c: Context<AppEnv>, next: Next) {
  if (c.get("authMethod") !== "session") {
    throw new ApiError({
      status: 403,
      code: "dashboard_session_required",
      title: "Dashboard Session Required",
      detail: "This change is made from the dashboard, signed in as a person.",
    });
  }
  return next();
}
