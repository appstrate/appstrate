// SPDX-License-Identifier: Apache-2.0

/**
 * Global telemetry middleware — the platform's single provider-agnostic hook
 * for HTTP server spans.
 *
 * Modules cannot register `app.use("*")` middleware themselves (the module
 * contract deliberately has no global-middleware surface), so core mounts
 * this thin delegator right after `requestId()` and a telemetry module
 * contributes the actual SERVER-span implementation through the façade's
 * provider slot (`TelemetryProvider.httpMiddleware`).
 *
 * The provider is resolved PER REQUEST (not at registration): module init
 * runs during `boot()`, after this middleware is registered — reading the
 * slot lazily picks up the provider installed later in the boot sequence
 * without re-wiring the app. Without a provider (module absent or none
 * contributed) this is a straight `next()` pass-through — nothing on the hot
 * path.
 */

import type { Context, Next } from "hono";
import { telemetryHttpMiddleware } from "@appstrate/core/telemetry";
import type { AppEnv } from "../types/index.ts";

export function telemetry() {
  return async (c: Context<AppEnv>, next: Next) => {
    const mw = telemetryHttpMiddleware();
    if (!mw) return next();
    return mw(c, next);
  };
}
