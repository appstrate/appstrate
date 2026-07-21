// SPDX-License-Identifier: Apache-2.0

/**
 * WebSocket bridge client.
 *
 * Connects to the Appstrate instance's desktop endpoint with the
 * Better Auth session cookie harvested from the webapp pane's session,
 * then services incoming JSON-RPC requests by dispatching to the
 * `browser-api` wrappers against the supplied `WebContents`.
 *
 * Protocol (subset of JSON-RPC 2.0, no batching):
 *   server → client:  { id: string, method: string, params: unknown }
 *   client → server:  { id: string, result: unknown } | { id: string, error: { message: string } }
 *
 * Reconnect: exponential backoff up to 30 s, with a `getCookieHeader()`
 * callback derived fresh on every reconnect attempt. The owner (main.ts)
 * resolves the cookie from the webapp WebContentsView's session so the
 * bridge inherits whatever auth state the user has in the embedded SPA
 * — log in there, the bridge sees it on the next reconnect.
 */

import { WebSocket } from "ws";
import type { WebContents } from "electron";
import * as api from "./browser-api.ts";

const BRIDGE_PATH = "/api/desktop/bridge";

export interface BridgeClient {
  stop(): void;
}

interface JsonRpcRequest {
  id: string;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  id: string;
  result: unknown;
}

interface JsonRpcError {
  id: string;
  error: { message: string };
}

type Handler = (wc: WebContents, params: unknown) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  "browser.navigate": (wc, p) => api.navigate(wc, p as api.NavigateParams),
  "browser.click": async (wc, p) => {
    await api.click(wc, p as api.ClickParams);
    return null;
  },
  "browser.fill": async (wc, p) => {
    await api.fill(wc, p as api.FillParams);
    return null;
  },
  "browser.evaluate": (wc, p) => api.evaluate(wc, p as api.EvaluateParams),
  "browser.screenshot": (wc) => api.screenshot(wc),
  "browser.waitForSelector": async (wc, p) => {
    await api.waitForSelector(wc, p as api.WaitForSelectorParams);
    return null;
  },
};

async function dispatch(
  wc: WebContents,
  req: JsonRpcRequest,
): Promise<JsonRpcSuccess | JsonRpcError> {
  const handler = handlers[req.method];
  if (!handler) {
    return { id: req.id, error: { message: `unknown method: ${req.method}` } };
  }
  try {
    const result = await handler(wc, req.params);
    return { id: req.id, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id: req.id, error: { message } };
  }
}

/**
 * Start the bridge.
 *
 * `getCookieHeader` is invoked on every (re)connect attempt — the caller
 * resolves it freshly from the webapp WebContentsView's session so the
 * bridge picks up cookie rotations (login, sign-out, session refresh).
 * Returning `null` or an empty string is treated as "user not logged in
 * yet" — the bridge sits in `disconnected`, retries on the same backoff,
 * and reconnects automatically once the user signs into the embedded SPA.
 */
export function start(opts: {
  instance: string;
  getCookieHeader: () => Promise<string | null>;
  webContents: WebContents;
  onStateChange?: (state: "connecting" | "connected" | "disconnected") => void;
  onError?: (err: unknown) => void;
}): BridgeClient {
  let stopped = false;
  let ws: WebSocket | null = null;
  let backoffMs = 1_000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const url = `${opts.instance.replace(/^http/, "ws")}${BRIDGE_PATH}`;

  async function connect(): Promise<void> {
    if (stopped) return;
    opts.onStateChange?.("connecting");

    // Fresh cookie on every connect. The caller reads it from the webapp
    // WebContentsView's session so the bridge stays in sync with whatever
    // auth state the user has in the embedded SPA — sign in there, the
    // bridge sees it on its next reconnect attempt.
    let cookieHeader: string | null;
    try {
      cookieHeader = await opts.getCookieHeader();
    } catch (err) {
      opts.onError?.(err);
      cookieHeader = null;
    }
    if (!cookieHeader) {
      opts.onStateChange?.("disconnected");
      // Schedule a retry — cookie may show up later (user signs in in the
      // webapp pane, network heals, etc.).
      if (!stopped) {
        reconnectTimer = setTimeout(() => void connect(), backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
      return;
    }

    ws = new WebSocket(url, {
      headers: { Cookie: cookieHeader },
    });

    ws.on("open", () => {
      backoffMs = 1_000;
      opts.onStateChange?.("connected");
    });

    ws.on("message", async (raw) => {
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(raw.toString()) as JsonRpcRequest;
      } catch {
        return; // malformed → ignore
      }
      if (!req.id || !req.method) return;
      const response = await dispatch(opts.webContents, req);
      ws?.send(JSON.stringify(response));
    });

    ws.on("close", () => {
      opts.onStateChange?.("disconnected");
      if (stopped) return;
      reconnectTimer = setTimeout(() => void connect(), backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    });

    ws.on("error", (err) => {
      // 'close' will fire next; surface the error so the owner can log
      // it (silently swallowing makes "WS dies after token expiry" near-
      // impossible to debug). Reconnect handling stays in the 'close'
      // listener so we don't double-schedule.
      opts.onError?.(err);
    });
  }

  void connect();

  return {
    stop(): void {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}
