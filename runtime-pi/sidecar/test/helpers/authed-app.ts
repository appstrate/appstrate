// SPDX-License-Identifier: Apache-2.0

/**
 * Test-side counterpart of the agent container: an app whose config carries a
 * known {@link TEST_SIDECAR_AUTH_TOKEN}, and an `app.request` that stamps it.
 *
 * The sidecar's control surface denies by default, so without this every suite
 * covering `/llm/*`, `/mcp`, `/integrations/boot-report` or `/runtime-events`
 * would be asserting against a wall of 401s. Stamping it here keeps each of
 * those suites about ITS OWN subject rather than about authentication —
 * authentication itself is covered on the real, unwrapped `createApp` in
 * `test/app-auth.test.ts`, which is the only place that should be able to make
 * this pass or fail.
 *
 * The header is only added when the caller did not set one, so a test can still
 * exercise a wrong-token or absent-token request through this helper.
 */

import type { Hono } from "hono";
import { SIDECAR_AUTH_HEADER } from "@appstrate/core/sidecar-types";
import { createApp, type AppDeps } from "../../app.ts";

/**
 * The token both halves of a wrapped app agree on. Any non-empty value works.
 *
 * Module-private on purpose: a suite that needs to name the token is a suite
 * asserting on authentication, and that belongs in `test/app-auth.test.ts`
 * against the real unwrapped `createApp`, not here.
 */
const TEST_SIDECAR_AUTH_TOKEN = "test-sidecar-auth-token";

/**
 * `createApp` with the agent's credential on both sides of the boundary.
 *
 * Every call site in this directory passes a `path` string (never a `Request`),
 * which is why stamping the init is enough.
 */
export function createTestApp(deps: AppDeps): Hono {
  const app = createApp({
    ...deps,
    config: { ...deps.config, sidecarAuthToken: TEST_SIDECAR_AUTH_TOKEN },
  });
  const raw = app.request.bind(app);
  app.request = ((input: unknown, init?: RequestInit, ...rest: unknown[]) => {
    const headers = new Headers(init?.headers);
    if (!headers.has(SIDECAR_AUTH_HEADER)) {
      headers.set(SIDECAR_AUTH_HEADER, TEST_SIDECAR_AUTH_TOKEN);
    }
    return (raw as (...args: unknown[]) => Response | Promise<Response>)(
      input,
      { ...(init ?? {}), headers },
      ...rest,
    );
  }) as typeof app.request;
  return app;
}
