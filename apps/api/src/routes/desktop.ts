// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Routes for the Appstrate Desktop bridge — the companion app that lets
 * a platform-hosted agent drive a Chromium surface on the user's own
 * machine, with the user's own cookies and logged-in sessions (see
 * `apps/desktop/`).
 *
 *   - `GET /api/desktop/bridge` — WebSocket upgrade. The desktop app
 *     connects here with the Better Auth session cookie of the webapp
 *     pane it embeds; the standard auth middleware resolves the user
 *     before this handler runs, and that user is what we register.
 *
 *   - `GET /api/desktop/me/status` — whether the caller has a desktop
 *     connected right now.
 *
 *   - `POST /api/desktop/me/command` — lets the authenticated user
 *     (curl, CLI, dashboard) drive their own desktop directly. Not on
 *     the agent's execution path — agents go through the sidecar's
 *     `desktop_browser` tool and `/internal/desktop-command` — but it is
 *     the fastest way to smoke-test a bridge without starting a run.
 *
 * Both `/me/*` routes are user-scoped and org-agnostic: a desktop
 * belongs to a person, not to an organization, so they are whitelisted
 * in `skipOrgContext` (`lib/auth-pipeline.ts`) and read `c.get("user")`.
 */

import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";
import {
  ApiError,
  unauthorized,
  invalidRequest,
  badGateway,
  serviceUnavailable,
  internalError,
} from "../lib/errors.ts";
import {
  registerClient,
  unregisterClient,
  sendCommand,
  handleClientReply,
  DesktopNotConnectedError,
  DesktopCommandError,
  DesktopCommandTimeoutError,
  isConnected,
} from "../services/desktop-registry.ts";

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

/**
 * Bun-native WebSocket handler produced by `createBunWebSocket()`. Passed
 * to `Bun.serve` via the `websocket` field on the API's default export —
 * without it the `upgradeWebSocket()` call below has nothing to hook into.
 */
export { websocket as desktopBunWebSocketHandler };

/**
 * Translate a registry rejection into the platform's RFC 9457 error
 * shape. Timeout gets a 504 (the desktop is connected but silent),
 * absence a 503, an error reported by the desktop itself a 502.
 */
export function desktopErrorToApiError(err: unknown): ApiError {
  if (err instanceof DesktopNotConnectedError) {
    return serviceUnavailable("No Appstrate Desktop connected for this user");
  }
  if (err instanceof DesktopCommandTimeoutError) {
    return new ApiError({
      status: 504,
      code: "desktop_command_timeout",
      title: "Gateway Timeout",
      detail: err.message,
    });
  }
  if (err instanceof DesktopCommandError) {
    return badGateway(err.message);
  }
  return err instanceof ApiError ? err : internalError();
}

export function createDesktopRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get(
    "/bridge",
    upgradeWebSocket((c) => {
      // Auth has already run via the platform middleware chain — if
      // `user` is missing we wouldn't be here. Capture the id now so the
      // callbacks below can register / unregister without re-reading `c`
      // (the context object's lifetime ends at upgrade time).
      const userId = c.get("user")?.id;
      if (!userId) {
        // Defense in depth — the auth middleware rejects unauthenticated
        // upgrades long before we reach this point.
        return { onMessage: (): void => {} };
      }
      let registered: { userId: string; send(payload: string): void; close(): void } | null = null;

      return {
        onOpen: (_evt, ws): void => {
          registered = {
            userId,
            send: (payload): void => ws.send(payload),
            close: (): void => ws.close(),
          };
          registerClient(registered);
        },
        onMessage: (evt): void => {
          let parsed: { id?: string; result?: unknown; error?: { message?: string } };
          try {
            const raw = typeof evt.data === "string" ? evt.data : evt.data.toString();
            parsed = JSON.parse(raw);
          } catch {
            logger.debug("Desktop bridge: dropped malformed message", { module: "desktop" });
            return;
          }
          handleClientReply(parsed);
        },
        onClose: (): void => {
          if (registered) unregisterClient(userId, registered);
        },
        onError: (): void => {
          if (registered) unregisterClient(userId, registered);
        },
      };
    }),
  );

  router.get("/me/status", (c) => {
    const user = c.get("user");
    if (!user) throw unauthorized("Authentication required");
    return c.json({ connected: isConnected(user.id) });
  });

  router.post("/me/command", async (c) => {
    const user = c.get("user");
    if (!user) throw unauthorized("Authentication required");
    let body: { method?: string; params?: unknown; timeoutMs?: number };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      throw invalidRequest("Invalid JSON body");
    }
    if (!body.method || typeof body.method !== "string") {
      throw invalidRequest("Missing or invalid `method`", "method");
    }
    try {
      const result = await sendCommand(user.id, body.method, body.params ?? {}, {
        timeoutMs: body.timeoutMs,
      });
      return c.json({ result });
    } catch (err) {
      throw desktopErrorToApiError(err);
    }
  });

  return router;
}
