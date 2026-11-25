// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import { ApiError } from "../lib/errors.ts";
import { isInternalDispatch } from "../lib/internal-dispatch.ts";

/**
 * Refuses every credential but the dashboard's own cookie session, used by the dashboard itself.
 * A decision about what a space lets its agents run must come from a person looking at the
 * screen: an API key, an OIDC/MCP/CLI token or the chat loopback acts for the user without that
 * person reading the tool definition. The MCP endpoint also takes a cookie session and re-enters
 * the platform with it in-process: that request carries the internal-dispatch marker and is
 * refused too (the routes are also kept out of the MCP catalog).
 */
export async function requireDashboardSession(c: Context<AppEnv>, next: Next) {
  if (c.get("authMethod") !== "session" || isInternalDispatch(c.req.raw.headers)) {
    throw new ApiError({
      status: 403,
      code: "dashboard_session_required",
      title: "Dashboard Session Required",
      detail: "This change is made from the dashboard, signed in as a person.",
    });
  }
  return next();
}
