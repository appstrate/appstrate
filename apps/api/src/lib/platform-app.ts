// SPDX-License-Identifier: Apache-2.0

/**
 * Holder for the running root Hono app, enabling in-process self-dispatch:
 * a module issuing an authenticated request back through the full platform
 * middleware chain via `app.fetch(request)` — no socket, no second auth
 * implementation. The dispatched request re-enters the same auth pipeline,
 * org-context, and `requirePermission` guards, so callers reuse the exact
 * authorization surface of the REST API.
 *
 * Set once when module routes are mounted (`registerModuleRoutes`) and by
 * the test harness. Generic infra — not tied to any single module.
 */

import type { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";

let platformApp: Hono<AppEnv> | null = null;

/** Register the fully-wired root app for in-process self-dispatch. */
export function setPlatformApp(app: Hono<AppEnv>): void {
  platformApp = app;
}

/**
 * Resolve the root app for in-process dispatch. Throws if called before
 * `setPlatformApp()` — a programming error (dispatch can only happen after
 * routes are mounted, which is when the app is registered).
 */
export function getPlatformApp(): Hono<AppEnv> {
  if (!platformApp) {
    throw new Error(
      "Platform app not initialized — setPlatformApp() must run before in-process dispatch",
    );
  }
  return platformApp;
}

/**
 * Re-enter the fully-wired platform app in-process (no socket hop). `app.fetch`
 * returns `Response | Promise<Response>`; the async wrapper normalizes it to the
 * `Promise<Response>` callers (the `inProcess` service, the MCP router) expect.
 */
export function dispatchInProcess(request: Request): Promise<Response> {
  return Promise.resolve(getPlatformApp().fetch(request));
}
