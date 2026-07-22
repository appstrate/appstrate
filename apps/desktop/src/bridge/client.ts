// SPDX-License-Identifier: Apache-2.0

/**
 * WebSocket bridge client.
 *
 * Connects to the Appstrate instance's desktop endpoint with the
 * Better Auth session cookie harvested from the webapp pane's session,
 * then services incoming JSON-RPC requests by dispatching to the
 * `browser-api` wrappers against the supplied `WebContents`.
 *
 * Protocol: JSON-RPC 2.0, no batching (see `protocol.ts`):
 *   server → client:  { jsonrpc, id, method, params }
 *   client → server:  { jsonrpc, id, result } | { jsonrpc, id, error: { code, message } }
 *   client → server:  { jsonrpc, method, params }   (notifications: download events)
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
import * as cdp from "./cdp.ts";
import { startDownload, type Notify } from "./downloads.ts";
import {
  ERR_EXECUTION,
  ERR_METHOD_NOT_FOUND,
  errorResponse,
  notification,
  successResponse,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./protocol.ts";

const BRIDGE_PATH = "/api/desktop/bridge";

export interface BridgeClient {
  stop(): void;
}

type Handler = (wc: WebContents, params: unknown, notify: Notify) => Promise<unknown> | unknown;

const handlers: Record<string, Handler> = {
  "browser.navigate": (wc, p) => cdp.navigate(wc, p as cdp.CdpNavigateParams),
  "browser.click": (wc, p) => cdp.click(wc, p as cdp.CdpClickParams),
  "browser.fill": (wc, p) => cdp.fill(wc, p as cdp.CdpFillParams),
  "browser.selectOption": (wc, p) => cdp.selectOption(wc, p as cdp.CdpSelectOptionParams),
  "browser.evaluate": (wc, p) => cdp.evaluate(wc, p as cdp.CdpEvaluateParams),
  "browser.screenshot": (wc, p) => cdp.screenshot(wc, (p ?? {}) as cdp.CdpScreenshotParams),
  "browser.waitForSelector": async (wc, p) => {
    await api.waitForSelector(wc, p as api.WaitForSelectorParams);
    return null;
  },
  "browser.download": (wc, p, notify) => startDownload(wc, p, notify),
  "browser.batch": (wc, p, notify) => runBatch(wc, p, notify),
  // Capture: runs the caller's script for the credential fields AND
  // attaches the page URL from `wc.getURL()` — the main-process
  // committed URL, which the (attacker-controlled) script cannot forge.
  // The platform checks that URL against the integration's
  // authorized_uris. Keeping the URL out of the script's return is the
  // whole point: an object-literal-injection breakout could otherwise
  // spoof it.
  "browser.capture": async (wc, p) => {
    const script = (p as { script?: string })?.script;
    if (typeof script !== "string") throw new Error("capture requires a `script` string");
    const fields = await cdp.evaluate(wc, { script });
    return { url: wc.getURL(), fields };
  },
};

/**
 * Sequential batch executor — the desktop half of `browser.batch`.
 * Steps arrive ALREADY substituted (the platform resolves `{{field}}`
 * per step before dispatch) and download steps arrive already minted
 * (download_id + upload_url injected platform-side). Runs each step
 * through the same handlers as single commands, stops at the first
 * failure, and reports partial results with the failing step's index
 * and error — the RPC itself succeeds; the batch outcome is data.
 */
interface BatchStep {
  method: string;
  params?: unknown;
}

async function runBatch(
  wc: WebContents,
  raw: unknown,
  notify: Notify,
): Promise<{
  completed: number;
  results: unknown[];
  error?: { step: number; code: number; message: string };
}> {
  const steps = (raw as { steps?: BatchStep[] } | undefined)?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw Object.assign(new Error("batch requires a non-empty `steps` array"), {
      code: ERR_INVALID_PARAMS_CODE,
    });
  }
  const results: unknown[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const handler = step.method === "browser.batch" ? undefined : handlers[step.method];
    if (!handler) {
      return {
        completed: i,
        results,
        error: {
          step: i,
          code: -32601,
          message: `unknown or non-batchable method: ${step.method}`,
        },
      };
    }
    try {
      results.push(await handler(wc, step.params, notify));
    } catch (err) {
      const code =
        err instanceof Error && typeof (err as { code?: unknown }).code === "number"
          ? (err as unknown as { code: number }).code
          : -32000;
      return {
        completed: i,
        results,
        error: { step: i, code, message: err instanceof Error ? err.message : String(err) },
      };
    }
  }
  return { completed: steps.length, results };
}
const ERR_INVALID_PARAMS_CODE = -32602;

async function dispatch(
  wc: WebContents,
  req: JsonRpcRequest,
  notify: Notify,
): Promise<JsonRpcResponse> {
  const handler = handlers[req.method];
  if (!handler) {
    return errorResponse(req.id, ERR_METHOD_NOT_FOUND, `unknown method: ${req.method}`);
  }
  try {
    const result = await handler(wc, req.params, notify);
    return successResponse(req.id, result);
  } catch (err) {
    const code =
      err instanceof Error && typeof (err as { code?: unknown }).code === "number"
        ? (err as unknown as { code: number }).code
        : ERR_EXECUTION;
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(req.id, code, message);
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

  // Desktop-initiated JSON-RPC notifications (download.progress /
  // .completed / .failed). Best-effort: a notification raised while the
  // socket is down is dropped — the platform's download record then ages
  // out on its TTL, which the status surface reports as a timeout.
  const notify: Notify = (method, params) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(notification(method, params)));
    } else {
      opts.onError?.(new Error(`notification ${method} dropped: bridge disconnected`));
    }
  };

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
      const response = await dispatch(opts.webContents, req, notify);
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
